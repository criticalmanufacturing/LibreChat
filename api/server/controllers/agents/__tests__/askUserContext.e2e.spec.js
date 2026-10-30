/** Ask-user resume retains MES variables and conversation history using real SDK checkpoints. */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { z } = require('zod');
const { replaceCustomVars } = require('librechat-data-provider');
const { tool } = require('@langchain/core/tools');
const { HumanMessage } = require('@langchain/core/messages');
const { Run, Providers, FakeChatModel, askUserQuestion } = require('@librechat/agents');

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAndIncrementPendingRequest: jest.fn(async () => ({ allowed: true })),
  decrementPendingRequest: jest.fn(async () => {}),
}));

jest.mock('~/models', () => ({
  saveMessage: jest.fn(async (req, message) => message),
  getConvo: jest.fn(async () => null),
  getMessages: jest.fn(async () => []),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
}));

jest.mock('~/server/services/MCPRequestContext', () => ({
  getMCPRequestContext: jest.fn(() => null),
  cleanupMCPRequestContextForReq: jest.fn(),
}));

// Import after mocks — these are the REAL implementations.
const {
  GenerationJobManager,
  createStreamServices,
  buildPendingAction,
  pickResumeContext,
  applyResumeContext,
  getAgentCheckpointer,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  __resetCheckpointerForTests,
} = require('@librechat/api');
const ResumeAgentController = require('~/server/controllers/agents/resume');

const USER_ID = 'ask-e2e-user';
const MONGO_CFG = { type: 'mongo', ttl: 3600 };
const ASK_TOOL = 'ask_user_question';

/**
 * Body-run counter + captured resolution. The body executes TWICE per answered
 * question by LangGraph contract (pass 1 runs until `interrupt()` throws; the
 * resume pass re-runs the body from the top and `askUserQuestion()` returns the
 * host's answer), so `bodyRuns` proves the re-entry semantics and
 * `resolvedAnswers` proves the answer round-trip.
 */
let bodyRuns = 0;
let resolvedAnswers = [];
const askTool = tool(
  async (input) => {
    bodyRuns += 1;
    const { answer } = askUserQuestion(input);
    resolvedAnswers.push(answer);
    return answer;
  },
  {
    name: ASK_TOOL,
    description: 'Ask the user a clarifying question and wait for their answer.',
    schema: z.object({
      question: z.string(),
      description: z.string().optional(),
      options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    }),
  },
);

/**
 * Build a REAL run in the PRODUCTION shape: the agents endpoint loads tools
 * definitions-only, so the run is EVENT-DRIVEN (`toolDefinitions` non-empty flips
 * the SDK ToolNode to event dispatch) and the ask tool rides `graphTools` — the
 * SDK's in-graph direct-tool seam (agents#289, > 3.2.57) — because an event-
 * dispatched tool body executes in the host handler outside the Pregel task
 * frame, where `interrupt()` throws instead of pausing. This is the mode
 * `createRun` produces via `buildAgentInput`.
 */
async function buildAskRunEventMode({
  saver,
  responses,
  toolCalls,
  runId,
  instructions = 'You are a helpful assistant.',
}) {
  const run = await Run.create({
    runId,
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId: 'agent-ask-event',
          provider: Providers.OPENAI,
          clientOptions: { model: 'gpt-4o-mini', streaming: true, streamUsage: false },
          instructions,
          maxContextTokens: 8000,
          toolDefinitions: [{ name: 'dummy_event_tool', description: 'host-executed event tool' }],
          graphTools: [askTool],
        },
      ],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    eagerEventToolExecution: { enabled: true, excludeToolNames: [ASK_TOOL] },
  });
  run.Graph.overrideModel = new FakeChatModel({ responses, toolCalls });
  return run;
}

const runConfig = (conversationId, checkpointNamespace = '') => ({
  runName: 'AgentRun',
  configurable: {
    thread_id: conversationId,
    checkpoint_ns: '',
    [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
    user_id: USER_ID,
  },
  streamMode: 'values',
  version: 'v2',
});

/** Poll until `predicate` returns true (the resume continuation is fire-and-forget). */
async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

async function checkpointCounts(conversationId) {
  const db = mongoose.connection.db;
  return {
    checkpoints: await db
      .collection('agent_checkpoints')
      .countDocuments({ thread_id: conversationId }),
    writes: await db
      .collection('agent_checkpoint_writes')
      .countDocuments({ thread_id: conversationId }),
  };
}

let mongoServer;
let saver;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  __resetCheckpointerForTests();
  saver = await getAgentCheckpointer(MONGO_CFG);

  GenerationJobManager.configure({ ...createStreamServices(), cleanupOnComplete: false });
  GenerationJobManager.initialize();
}, 60000);

afterAll(async () => {
  await GenerationJobManager.destroy();
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  bodyRuns = 0;
  resolvedAnswers = [];
  jest.clearAllMocks();
});

describe('MES context across ask-user resume', () => {
  jest.setTimeout(30000);

  test('EVENT-DRIVEN mode retains MES context and history when the answer omits custom variables', async () => {
    const conversationId = `ask-e2e-event-${Date.now()}`;
    const responseMessageId = 'resp-ask-event-1';
    const customVariables = {
      entityType: 'Material',
      entityId: 'material-1',
      attachmentIds: '["attachment-1"]',
      culture: 'en-US',
      timeZone: 'Europe/London',
      utcOffset: '60',
      dateTimeFormat: 'MM/DD/YYYY hh:mm A',
    };
    const instructionTemplate = Object.keys(customVariables)
      .map((key) => `{{${key}}}`)
      .join(' | ');
    const originalInstructions = replaceCustomVars({ text: instructionTemplate, customVariables });
    const job = await GenerationJobManager.createJob(conversationId, USER_ID, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const checkpointNamespace = job.metadata.checkpointNamespace;
    expect(checkpointNamespace).toEqual(expect.any(String));
    expect(checkpointNamespace).not.toBe(String(job.createdAt));

    const run = await buildAskRunEventMode({
      saver,
      instructions: originalInstructions,
      responses: ['Let me check with you.'],
      toolCalls: [
        {
          name: ASK_TOOL,
          args: { question: 'Proceed with the migration?' },
          id: 'tc_ask_ev1',
          type: 'tool_call',
        },
      ],
      runId: responseMessageId,
    });
    await run.processStream(
      { messages: [new HumanMessage('run the migration')] },
      runConfig(conversationId, checkpointNamespace),
    );

    const interrupt = run.getInterrupt();
    expect(interrupt?.payload?.type).toBe('ask_user_question');
    expect(interrupt.payload.question).toEqual({ question: 'Proceed with the migration?' });
    expect(bodyRuns).toBe(1);
    expect((await checkpointCounts(conversationId)).checkpoints).toBeGreaterThan(0);

    await GenerationJobManager.updateMetadata(conversationId, {
      endpoint: 'agents',
      agent_id: 'agent-ask-e2e',
      responseMessageId,
    });
    const pendingAction = buildPendingAction(interrupt.payload, {
      streamId: conversationId,
      conversationId,
      runId: responseMessageId,
      responseMessageId,
      ttlMs: 60_000,
      resumeContext: pickResumeContext({
        endpoint: 'agents',
        agent_id: 'agent-ask-e2e',
        customVariables,
      }),
    });
    expect(await GenerationJobManager.approvals.pause(conversationId, pendingAction)).toBe(true);

    let resumedModelCalls;
    const thinClient = {
      contentParts: [],
      artifactPromises: [],
      conversationId,
      responseMessageId,
      pendingApproval: null,
      async resumeCompletion({ resumeValue, abortController }) {
        const resumed = await buildAskRunEventMode({
          saver,
          instructions: this.instructions,
          responses: ['Migration underway.'],
          runId: responseMessageId,
        });
        expect(resumed.Graph.agentContexts.get('agent-ask-event').instructions).toBe(
          originalInstructions,
        );
        resumedModelCalls = jest.spyOn(resumed.Graph.overrideModel, '_streamResponseChunks');
        await resumed.resume(resumeValue, {
          ...runConfig(conversationId, checkpointNamespace),
          signal: (abortController ?? new AbortController()).signal,
        });
        this.contentParts.push({ type: 'text', text: 'Migration underway.' });
        return resumed;
      },
    };
    const initializeClient = jest.fn(async ({ endpointOption }) => {
      thinClient.instructions = replaceCustomVars({
        text: instructionTemplate,
        customVariables: endpointOption.customVariables,
      });
      return { client: thinClient };
    });

    const app = express();
    app.use(express.json());
    app.use(async (req, _res, next) => {
      req.user = { id: USER_ID };
      req.config = { endpoints: { agents: { checkpointer: MONGO_CFG } }, interfaceConfig: {} };
      // The production router restores saved context before building endpointOption.
      const pausedJob = await GenerationJobManager.getJob(req.body.conversationId);
      applyResumeContext(req.body, pausedJob.metadata.pendingAction.resumeContext);
      req.body.endpointOption = { customVariables: req.body.customVariables };
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) =>
      ResumeAgentController(req, res, next, initializeClient, jest.fn()),
    );

    const response = await request(app).post('/api/agents/chat/resume').send({
      conversationId,
      actionId: pendingAction.actionId,
      agent_id: 'agent-ask-e2e',
      endpoint: 'agents',
      answer: 'yes, proceed',
    });

    expect(response.status).toBe(200);
    await waitFor(async () => {
      const liveJob = await GenerationJobManager.getJob(conversationId);
      return liveJob?.status !== 'requires_action' && liveJob?.status !== 'running';
    });

    expect(bodyRuns).toBe(2);
    expect(resolvedAnswers).toEqual(['yes, proceed']);
    expect(initializeClient).toHaveBeenCalledTimes(1);
    expect(initializeClient.mock.calls[0][0].endpointOption.customVariables).toEqual(
      customVariables,
    );
    expect(thinClient.instructions).toBe(originalInstructions);
    const modelMessages = resumedModelCalls.mock.calls[0][0];
    expect(modelMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'run the migration' }),
        expect.objectContaining({ content: 'yes, proceed', tool_call_id: 'tc_ask_ev1' }),
      ]),
    );
    await waitFor(async () => (await checkpointCounts(conversationId)).checkpoints === 0);
  });
});
