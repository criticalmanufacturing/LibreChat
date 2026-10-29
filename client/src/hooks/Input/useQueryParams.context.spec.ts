// useQueryParams.spec.ts
jest.mock('recoil', () => {
  const originalModule = jest.requireActual('recoil');
  return {
    ...originalModule,
    atom: jest.fn().mockImplementation((config) => ({
      key: config.key,
      default: config.default,
    })),
    useRecoilValue: jest.fn(),
  };
});

// Move mock store definition after the mocks
jest.mock('~/store', () => ({
  modularChat: { key: 'modularChat', default: false },
  availableTools: { key: 'availableTools', default: [] },
}));

import { renderHook, act } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import useQueryParams from './useQueryParams';
import { useChatContext, useChatFormContext } from '~/Providers';
import useSubmitMessage from '~/hooks/Messages/useSubmitMessage';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import store from '~/store';

// Other mocks
jest.mock('react-router-dom', () => ({
  useSearchParams: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
  useChatFormContext: jest.fn(),
}));

jest.mock('~/hooks/Messages/useSubmitMessage', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/hooks/Conversations/useDefaultConvo', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: jest.fn(),
}));

jest.mock('~/hooks/Agents/useAgentsMap', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}));
jest.mock('~/hooks/Agents/useAgentDefaultPermissionLevel', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}));

jest.mock('~/utils', () => {
  const actualUtils = jest.requireActual('~/utils');
  return {
    ...actualUtils,
    // Only mock logger to suppress test output
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    // Mock theme utilities that interact with DOM
    getInitialTheme: jest.fn(() => 'light'),
    applyFontSize: jest.fn(),
  };
});

// Mock data-provider hooks while preserving real exports like startupConfigKey
jest.mock('~/data-provider', () => {
  const actual = jest.requireActual<typeof import('~/data-provider')>('~/data-provider');
  return {
    ...actual,
    useGetAgentByIdQuery: jest.fn(() => ({
      data: null,
      isLoading: false,
      error: null,
    })),
    useListAgentsQuery: jest.fn(() => ({
      data: null,
      isLoading: false,
      error: null,
    })),
  };
});

// Mock global window.history
global.window = Object.create(window);
global.window.history = {
  replaceState: jest.fn(),
  pushState: jest.fn(),
  go: jest.fn(),
  back: jest.fn(),
  forward: jest.fn(),
  length: 1,
  scrollRestoration: 'auto',
  state: null,
};

describe('useQueryParams', () => {
  // Setup common mocks before each test
  beforeEach(() => {
    jest.useFakeTimers();

    // Reset mock for window.history.replaceState
    jest.spyOn(window.history, 'replaceState').mockClear();

    // Reset data-provider mocks
    const dataProvider = jest.requireMock('~/data-provider');
    (dataProvider.useGetAgentByIdQuery as jest.Mock).mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
    });

    // Create mocks for all dependencies
    const mockSearchParams = new URLSearchParams();
    (useSearchParams as jest.Mock).mockReturnValue([mockSearchParams, jest.fn()]);

    const mockQueryClient = {
      getQueryData: jest.fn().mockImplementation((key) => {
        if (key === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        if (key === 'endpoints') {
          return {};
        }
        return null;
      }),
    };
    (useQueryClient as jest.Mock).mockReturnValue(mockQueryClient);

    (useRecoilValue as jest.Mock).mockImplementation((atom) => {
      if (atom === store.modularChat) return false;
      if (atom === store.availableTools) return [];
      return null;
    });

    const mockConversation = { model: null, endpoint: null };
    const mockNewConversation = jest.fn();
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: mockConversation,
      newConversation: mockNewConversation,
    });

    const mockMethods = {
      setValue: jest.fn(),
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: jest.fn((callback) => () => callback({ text: 'test message' })),
    };
    (useChatFormContext as jest.Mock).mockReturnValue(mockMethods);

    const mockSubmitMessage = jest.fn();
    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    const mockGetDefaultConversation = jest.fn().mockReturnValue({});
    (useDefaultConvo as jest.Mock).mockReturnValue(mockGetDefaultConversation);

    // Mock useAuthContext
    const { useAuthContext } = jest.requireMock('~/hooks/AuthContext');
    (useAuthContext as jest.Mock).mockReturnValue({
      user: { id: 'test-user-id' },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // Helper function to set URL parameters for testing
  const setUrlParams = (params: Record<string, string>) => {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      searchParams.set(key, value);
    });
    (useSearchParams as jest.Mock).mockReturnValue([searchParams, jest.fn()]);
  };

  describe('pending auto-submission', () => {
    const setup = (matches: boolean, allowAutoSubmit = true) => {
      const conversation = {
        endpoint: 'agents',
        agent_id: 'agent_entity',
        customVariables: { entityType: 'Material', entityId: 'material-1' },
      };
      const newConversation = jest.fn();
      (useChatContext as jest.Mock).mockReturnValue({
        conversation: matches ? conversation : { endpoint: null },
        newConversation,
      });
      (useQueryClient as jest.Mock).mockReturnValue({
        getQueryData: jest.fn((key) =>
          key[0] === 'startupConfig' ? { interface: { autoSubmitFromUrl: allowAutoSubmit } } : null,
        ),
      });
      const submitMessage = jest.fn();
      (useSubmitMessage as jest.Mock).mockReturnValue({ submitMessage });
      setUrlParams({
        q: 'Summarize',
        submit: 'true',
        agent_id: conversation.agent_id,
        custom_entityType: 'Material',
        custom_entityId: 'material-1',
        projectId: 'project-1',
      });
      const textAreaRef = { current: document.createElement('textarea') };
      const hook = renderHook(() => {
        const methods = useForm({ defaultValues: { text: '' } });
        (useChatFormContext as jest.Mock).mockReturnValue(methods);
        useQueryParams({ textAreaRef });
        return methods;
      });
      return { ...hook, conversation, newConversation, submitMessage };
    };

    const tick = async (milliseconds = 100) => {
      await act(async () => {
        jest.advanceTimersByTime(milliseconds);
      });
    };

    it('submits once when the route has already applied the agent and custom variables', async () => {
      const { newConversation, submitMessage, rerender } = setup(true);
      await tick();
      expect(newConversation).not.toHaveBeenCalled();
      expect(submitMessage).toHaveBeenCalledTimes(1);
      expect(submitMessage).toHaveBeenCalledWith({ text: 'Summarize' });
      const setSearchParams = (useSearchParams as jest.Mock).mock.results[0].value[1];
      expect(setSearchParams.mock.calls[0][0].toString()).toBe('projectId=project-1');
      rerender();
      await tick(4000);
      expect(submitMessage).toHaveBeenCalledTimes(1);
    });

    it('retains the fallback when available tools change before settings apply', async () => {
      const { submitMessage, rerender } = setup(false);
      await tick();
      expect(submitMessage).not.toHaveBeenCalled();
      await tick(2000);
      (useRecoilValue as jest.Mock).mockImplementation((atom) =>
        atom === store.availableTools ? {} : false,
      );
      rerender();
      await tick(1000);
      expect(submitMessage).toHaveBeenCalledTimes(1);
    });

    it('rearms the fallback with the current submission callback', async () => {
      const { submitMessage, rerender } = setup(false);
      await tick();
      const latestSubmitMessage = jest.fn();
      (useSubmitMessage as jest.Mock).mockReturnValue({ submitMessage: latestSubmitMessage });
      rerender();
      await tick(3000);
      expect(submitMessage).not.toHaveBeenCalled();
      expect(latestSubmitMessage).toHaveBeenCalledTimes(1);
    });

    it('submits once after asynchronous settings apply and cancels the fallback', async () => {
      const { submitMessage, conversation, newConversation, rerender } = setup(false);
      await tick();
      expect(submitMessage).not.toHaveBeenCalled();
      (useChatContext as jest.Mock).mockReturnValue({ conversation, newConversation });
      await act(async () => rerender());
      expect(submitMessage).toHaveBeenCalledTimes(1);
      await tick(4000);
      expect(submitMessage).toHaveBeenCalledTimes(1);
    });

    it('clears the pending fallback on unmount', async () => {
      const { submitMessage, unmount } = setup(false);
      await tick();
      unmount();
      await tick(4000);
      expect(submitMessage).not.toHaveBeenCalled();
    });

    it('respects the configuration disabling automatic URL submission', async () => {
      const { submitMessage, result } = setup(true, false);
      await tick();
      expect(result.current.getValues('text')).toBe('Summarize');
      await tick(4000);
      expect(submitMessage).not.toHaveBeenCalled();
    });
  });
});
