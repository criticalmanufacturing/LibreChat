import React from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import ChatRoute from '../ChatRoute';

const mockSetConversation = jest.fn();
const mockFetchConversation = jest.fn();
const mockHasSetConversation = { current: true };
let mockConversation: Partial<TConversation> = { conversationId: 'chat-a' };
const mockConfig = {};
let mockModelsData: Record<string, never> | undefined = mockConfig;
const mockRoles = { USER: {} };
let mockAssistantListMap = {};
let mockAgentsMap: Record<string, never> | undefined = {};
let mockAwaitsAgents = false;
let mockProjectQuery: { isLoading: boolean; data?: { _id: string } } = { isLoading: false };
const mockNewConversation = jest.fn(
  ({
    template,
    preset,
  }: {
    template?: Partial<TConversation>;
    preset?: Partial<TConversation>;
  }) => {
    mockConversation = { conversationId: 'new', ...template, ...preset };
    mockSetConversation();
  },
);

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useRecoilCallback: () => () => {},
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    useCreateConversationAtom: () => ({
      conversation: mockConversation,
      hasSetConversation: mockHasSetConversation,
    }),
  },
}));
jest.mock('~/store/temporary', () => ({ __esModule: true, default: {} }));
jest.mock('../useAuthRedirect', () => ({
  __esModule: true,
  default: () => ({ isAuthenticated: true, roles: mockRoles }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: mockModelsData }),
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
  useGetEndpointsQuery: () => ({ data: mockConfig }),
  useListAgentsQuery: () => ({}),
  useProjectQuery: () => mockProjectQuery,
  useGetConvoIdQuery: (id: string, options: { enabled: boolean }) => {
    const { useQuery: query } = jest.requireActual('@tanstack/react-query');
    return query(['conversation', id], () => mockFetchConversation(id), {
      ...options,
      retry: false,
      staleTime: Infinity,
    });
  },
}));
jest.mock('~/hooks', () => ({
  useAssistantListMap: () => mockAssistantListMap,
  useIdChangeEffect: () => {},
  useAppStartup: () => {},
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/Providers', () => ({
  ToolCallsMapProvider: ({ children }: { children: React.ReactNode }) => children,
  useAgentsMapContext: () => mockAgentsMap,
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => <span />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/utils', () => ({
  defaultSpecAwaitsAgents: () => mockAwaitsAgents,
  processValidSettings: () => ({}),
  getDefaultModelSpec: () => ({}),
  hasModelSelection: () => false,
  isNotFoundError: () => false,
  isTemporaryConversation: () => false,
  clearMessagesCache: jest.fn(),
  logger: { log: jest.fn() },
}));
jest.mock('~/components/Chat/ChatView', () => ({
  __esModule: true,
  default: () => <div data-testid="composer">{mockConversation.conversationId}</div>,
}));

function Harness() {
  const [, update] = React.useReducer((n: number) => n + 1, 0);
  mockSetConversation.mockImplementation(update);
  return <ChatRoute />;
}

function setup(initialEntries = ['/c/chat-a'], initialIndex = initialEntries.length - 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/c/:conversationId', element: <Harness /> }], {
    initialEntries,
    initialIndex,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

beforeEach(() => {
  mockConversation = { conversationId: 'chat-a' };
  mockHasSetConversation.current = true;
  mockAssistantListMap = {};
  mockModelsData = mockConfig;
  mockAgentsMap = {};
  mockAwaitsAgents = false;
  mockProjectQuery = { isLoading: false };
  mockFetchConversation.mockImplementation(async (id: string) => ({ conversationId: id }));
});

it.each(['project', 'agent'] as const)(
  'initializes customVariables after URL cleanup before the delayed hook runs while %s is pending',
  async (gate) => {
    const projectId = '0123456789abcdef01234567';
    const retainedSearch = gate === 'project' ? `?projectId=${projectId}` : '';
    const search = new URLSearchParams(retainedSearch);
    search.set('custom_name', 'Alice');
    search.set('custom_department', 'Engineering');
    mockConversation = { conversationId: 'new' };
    mockHasSetConversation.current = false;
    if (gate === 'project') {
      mockProjectQuery = { isLoading: true };
    } else {
      mockAgentsMap = undefined;
      mockAwaitsAgents = true;
    }

    const { router } = setup([`/c/new?${search.toString()}`]);
    expect(mockNewConversation).not.toHaveBeenCalled();

    await act(async () => {
      await router.navigate(`/c/new${retainedSearch}`, { replace: true });
    });
    expect(router.state.location.search).toBe(retainedSearch);
    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockConversation.customVariables).toBeUndefined();

    act(() => {
      if (gate === 'project') {
        mockProjectQuery = { isLoading: false, data: { _id: projectId } };
      } else {
        mockAgentsMap = {};
      }
      mockSetConversation();
    });

    await waitFor(() => expect(mockHasSetConversation.current).toBe(true));
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockConversation).toMatchObject({
      conversationId: 'new',
      customVariables: { name: 'Alice', department: 'Engineering' },
    });
    if (gate === 'project') {
      expect(mockConversation.chatProjectId).toBe(projectId);
    }
  },
);

it.each(['models', 'assistants'] as const)(
  'includes customVariables in the first %s initialization without waiting for the URL hook',
  (catalog) => {
    mockConversation = { conversationId: 'new' };
    mockHasSetConversation.current = false;
    if (catalog === 'assistants') {
      mockModelsData = undefined;
      mockAssistantListMap = { assistants: {}, azureAssistants: {} };
    }

    setup(['/c/new?custom_name=Alice&custom_empty=&custom_=ignored']);

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockConversation.customVariables).toEqual({ name: 'Alice', empty: '' });
  },
);

it('discards pending URL variables when leaving the new-chat route', async () => {
  mockConversation = { conversationId: 'new' };
  mockHasSetConversation.current = false;
  mockAgentsMap = undefined;
  mockAwaitsAgents = true;
  const { router } = setup(['/c/new?custom_name=Alice']);

  await act(async () => {
    await router.navigate('/c/chat-a');
  });
  await waitFor(() => expect(mockConversation.conversationId).toBe('chat-a'));
  await act(async () => {
    await router.navigate('/c/new');
  });
  expect(mockConversation.conversationId).toBe('chat-a');

  act(() => {
    mockAgentsMap = {};
    mockSetConversation();
  });

  await waitFor(() => expect(mockConversation.conversationId).toBe('new'));
  expect(mockConversation.customVariables).toBeUndefined();
});

it.each(['project', 'agent'] as const)(
  'preserves customVariables after URL cleanup while %s initialization is pending',
  async (gate) => {
    const projectId = '0123456789abcdef01234567';
    const customVariables = { name: 'Alice', department: 'Engineering' };
    const retainedSearch = gate === 'project' ? `?projectId=${projectId}` : '';
    const initialSearch = new URLSearchParams(retainedSearch);
    initialSearch.set('custom_name', customVariables.name);
    initialSearch.set('custom_department', customVariables.department);
    mockConversation = { conversationId: 'new' };
    mockHasSetConversation.current = false;
    if (gate === 'project') {
      mockProjectQuery = { isLoading: true };
    } else {
      mockAgentsMap = undefined;
      mockAwaitsAgents = true;
    }

    const { router } = setup([`/c/new?${initialSearch.toString()}`]);
    expect(mockNewConversation).not.toHaveBeenCalled();

    // Simulate useQueryParams applying its preset and replacing the URL after cleanup.
    await act(async () => {
      mockNewConversation({ preset: { customVariables } });
      await router.navigate(`/c/new${retainedSearch}`, { replace: true });
    });
    expect(router.state.location.search).toBe(retainedSearch);
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockHasSetConversation.current).toBe(false);
    expect(mockConversation.customVariables).toEqual(customVariables);

    act(() => {
      if (gate === 'project') {
        mockProjectQuery = { isLoading: false, data: { _id: projectId } };
      } else {
        mockAgentsMap = {};
      }
      mockSetConversation();
    });

    await waitFor(() => expect(mockHasSetConversation.current).toBe(true));
    expect(mockNewConversation).toHaveBeenCalledTimes(2);
    expect(mockConversation).toMatchObject({ conversationId: 'new', customVariables });
    if (gate === 'project') {
      expect(mockConversation.chatProjectId).toBe(projectId);
    }
  },
);

it('does not carry customVariables from a saved conversation into a new chat', async () => {
  mockConversation = { conversationId: 'chat-a', customVariables: { name: 'Alice' } };
  const { router } = setup();

  await act(async () => {
    await router.navigate('/c/new');
  });

  await waitFor(() => expect(mockConversation.conversationId).toBe('new'));
  expect(mockConversation.customVariables).toBeUndefined();
});

it('reconciles Back and Forward with each route, including new chat', async () => {
  const { router } = setup(['/c/new', '/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('new'));
  await act(async () => {
    await router.navigate(1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
});

it('does not reset a new conversation when its server id arrives before the URL', async () => {
  mockConversation = { conversationId: 'new' };
  const { router } = setup(['/c/new']);
  act(() => {
    mockConversation = { conversationId: 'created-chat' };
    mockSetConversation();
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  await act(async () => {
    await router.navigate('/c/created-chat', { replace: true });
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  expect(mockFetchConversation).not.toHaveBeenCalled();
});

it('reuses the full cached record when returning through history', async () => {
  const { client, router } = setup(['/c/chat-b', '/c/chat-a']);
  client.setQueryData(['conversation', 'chat-b'], {
    conversationId: 'chat-b',
    model: 'saved-model',
  });
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() =>
    expect(mockConversation).toMatchObject({ conversationId: 'chat-b', model: 'saved-model' }),
  );
  expect(mockFetchConversation).not.toHaveBeenCalled();
});

it('keeps the departing composer mounted but hidden until the destination record arrives', async () => {
  let resolveRecord: (value: Partial<TConversation>) => void = () => {};
  mockFetchConversation.mockReturnValue(
    new Promise<Partial<TConversation>>((resolve) => {
      resolveRecord = resolve;
    }),
  );
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  const composer = screen.getByTestId('composer');
  await act(async () => {
    await router.navigate(-1);
  });
  expect(screen.getByTestId('composer')).toBe(composer);
  expect(composer).not.toBeVisible();
  await act(async () => {
    resolveRecord({ conversationId: 'chat-b' });
  });
  await waitFor(() => expect(composer).toBeVisible());
  expect(composer).toHaveTextContent('chat-b');
});

it('ignores a response for a route left while its record was loading', async () => {
  let resolveRecord: (value: Partial<TConversation>) => void = () => {};
  mockFetchConversation.mockReturnValue(
    new Promise<Partial<TConversation>>((resolve) => {
      resolveRecord = resolve;
    }),
  );
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await act(async () => {
    await router.navigate(1);
  });
  await act(async () => {
    resolveRecord({ conversationId: 'chat-b' });
  });
  expect(screen.getByTestId('composer')).toHaveTextContent('chat-a');
  expect(mockNewConversation).not.toHaveBeenCalled();
});

it('allows retry after a failed history load without replacing the departing draft', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockFetchConversation.mockRejectedValueOnce(new Error('offline'));
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await screen.findByRole('alert');
  expect(mockConversation.conversationId).toBe('chat-a');
  expect(screen.getByTestId('composer')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(screen.getByTestId('composer')).toBeVisible());
  expect(mockConversation.conversationId).toBe('chat-b');
  expect(consoleError).toHaveBeenCalledWith(new Error('offline'));
});

it('waits for the conversation record even when assistant catalogs are already loaded', async () => {
  mockAssistantListMap = { assistants: {}, azureAssistants: {} };
  mockFetchConversation.mockReturnValue(new Promise(() => {}));
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  expect(mockConversation.conversationId).toBe('chat-a');
  expect(screen.getByTestId('composer')).not.toBeVisible();
});

it('reconciles a remounted chat route with conversation state retained by the shell', async () => {
  setup(['/c/chat-b']);
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
  expect(mockFetchConversation).toHaveBeenCalledWith('chat-b');
});
