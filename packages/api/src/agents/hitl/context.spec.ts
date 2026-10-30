import { buildPendingAction, pickResumeContext, applyResumeContext } from './policy';

describe('MES context across ask-user resume', () => {
  it('restores the paused MES variables and removes variables absent from the saved context', () => {
    const customVariables = {
      entityType: 'Material',
      entityId: 'material-1',
      attachmentIds: '["attachment-1"]',
      culture: 'en-US',
      timeZone: 'Europe/London',
    };
    const action = buildPendingAction(
      { type: 'ask_user_question', question: { question: 'Which operation?' } },
      {
        streamId: 'mes-chat',
        resumeContext: pickResumeContext({ endpoint: 'agents', customVariables }),
      },
    );
    // Job storage serializes this context; resume must work after a reload or replica change.
    const persisted: typeof action = JSON.parse(JSON.stringify(action));
    expect(persisted.resumeContext?.customVariables).toEqual(customVariables);
    const body: Record<string, unknown> = {
      conversationId: 'mes-chat',
      answer: 'Inspect',
      customVariables: { entityId: 'another-material' },
    };
    applyResumeContext(body, persisted.resumeContext);
    expect(body.customVariables).toEqual(customVariables);
    expect(body.answer).toBe('Inspect');

    applyResumeContext(body, { endpoint: 'agents' });
    expect(body).not.toHaveProperty('customVariables');
  });
});
