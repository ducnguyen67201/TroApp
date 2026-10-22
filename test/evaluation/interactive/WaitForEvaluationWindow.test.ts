import { MCPServerStdio, type CallToolResult } from '@openai/agents';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EvaluationWindowFailure,
  EvaluationWindowLimits,
  waitForEvaluationWindow,
  type EvaluationWindowConnection,
  type EvaluationWindowPorts,
  type EvaluationWindowDiagnostic,
} from './WaitForEvaluationWindow.js';

const connection = { command: '/synthetic/driver', args: ['mcp'], env: { PRIVATE: 'synthetic' } };
const target = {
  processId: 401,
  title: 'Tro evaluation - TrialOne - main.py',
  documentName: 'main.py',
};

function createWindowList(
  windows: readonly unknown[] = [
    {
      pid: target.processId,
      window_id: 77,
      title: target.title,
      is_on_screen: true,
      on_current_space: true,
    },
  ],
) {
  return { content: [], structuredContent: { windows } };
}

function createWindowState() {
  return {
    content: [{ type: 'text', text: 'private authored editor text' }],
    structuredContent: {
      pid: target.processId,
      window_id: 77,
      window_title: target.title,
      tree_markdown: 'AXWindow main.py; AXTab main.py; AXTextArea private authored source',
    },
  } satisfies CallToolResult;
}

function createFixture() {
  const server = {
    connect: vi.fn<EvaluationWindowConnection['connect']>().mockResolvedValue(undefined),
    callTool: vi
      .fn<EvaluationWindowConnection['callTool']>()
      .mockImplementation((name) =>
        Promise.resolve(name === 'list_windows' ? createWindowList() : createWindowState()),
      ),
    close: vi.fn<EvaluationWindowConnection['close']>().mockResolvedValue(undefined),
  } satisfies EvaluationWindowConnection;
  const ports = {
    now: vi.fn<EvaluationWindowPorts['now']>().mockReturnValue(250),
    createConnection: vi.fn<EvaluationWindowPorts['createConnection']>().mockReturnValue(server),
  } satisfies EvaluationWindowPorts;
  return { server, ports };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('records one bounded terminal failure with its operation and safe RPC code, without native content', async () => {
  const fixture = createFixture();
  fixture.server.callTool.mockRejectedValue(
    Object.assign(new Error('private native contents must not be recorded'), {
      name: 'McpError',
      code: -32603,
    }),
  );
  const record = vi
    .fn<(event: EvaluationWindowDiagnostic) => Promise<void>>()
    .mockResolvedValue(undefined);
  await expect(
    waitForEvaluationWindow(connection, target, undefined, fixture.ports, record),
  ).rejects.toThrow(EvaluationWindowFailure.PROBE_FAILED);
  expect(record).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]?.[0]).toMatchObject({
    operation: 'close',
    failedOperation: 'list_windows',
    failureCode: EvaluationWindowFailure.PROBE_FAILED,
    errorType: 'McpError',
    errorCode: -32603,
    attemptedLists: 1,
    completedLists: 0,
    attemptedStates: 0,
    candidateWindowObserved: false,
    contentObserved: false,
    cleanupConfirmed: true,
  });
  const text = JSON.stringify(record.mock.calls);
  expect(text).not.toContain('private');
  expect(text).not.toContain('main.py');
  expect(text).not.toContain('/synthetic');
});

it('drops arbitrary string error codes instead of recording untrusted error text', async () => {
  const fixture = createFixture();
  fixture.server.connect.mockRejectedValue(
    Object.assign(new Error('private connection failure'), {
      code: 'PRIVATE_ARBITRARY_ERROR_CODE',
    }),
  );
  const record = vi
    .fn<(event: EvaluationWindowDiagnostic) => Promise<void>>()
    .mockResolvedValue(undefined);
  await expect(
    waitForEvaluationWindow(connection, target, undefined, fixture.ports, record),
  ).rejects.toThrow(EvaluationWindowFailure.PROBE_FAILED);
  expect(record.mock.calls[0]?.[0]).toMatchObject({ failedOperation: 'connect', errorCode: null });
  expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_ARBITRARY_ERROR_CODE');
});

it('observes only the exact owned process, title and document before returning metadata', async () => {
  const fixture = createFixture();
  const result = await waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  expect(result).toEqual({
    processId: 401,
    windowId: 77,
    windowObserved: true,
    documentObserved: true,
    contentObserved: true,
    elapsedMs: 0,
  });
  expect(fixture.server.callTool.mock.calls.map(([name]) => name)).toEqual([
    'list_windows',
    'get_window_state',
  ]);
  expect(fixture.server.callTool.mock.calls[0]?.[1]).toEqual({ pid: 401, on_screen_only: false });
  expect(fixture.server.callTool.mock.calls[1]?.[1]).toMatchObject({
    pid: 401,
    window_id: 77,
    include_accessibility_tree: true,
    include_screenshot: true,
    max_elements: 256,
  });
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain('main.py');
  expect(JSON.stringify(result)).not.toContain('/synthetic');
});

it('does not accept another editor, hidden window or mismatched document', async () => {
  vi.useFakeTimers();
  const fixture = createFixture();
  fixture.server.callTool.mockResolvedValueOnce(
    createWindowList([
      { pid: 402, window_id: 77, title: target.title, is_on_screen: true },
      { pid: 401, window_id: 78, title: 'Another main.py', is_on_screen: true },
      { pid: 401, window_id: 79, title: target.title, is_on_screen: false },
      { pid: 401, window_id: 80, title: target.title, is_on_screen: true, on_current_space: false },
      { pid: 401, window_id: 81, title: target.title, is_on_screen: true, minimized: true },
    ]),
  );
  const result = waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  await vi.advanceTimersByTimeAsync(EvaluationWindowLimits.POLL_MS);
  await expect(result).resolves.toMatchObject({ windowId: 77 });
  expect(fixture.server.callTool.mock.calls.map(([name]) => name)).toEqual([
    'list_windows',
    'list_windows',
    'get_window_state',
  ]);
});

it('requires a matching scoped observation rather than trusting the window list alone', async () => {
  vi.useFakeTimers();
  const fixture = createFixture();
  fixture.server.callTool.mockResolvedValueOnce(createWindowList()).mockResolvedValueOnce({
    content: [{ type: 'text', text: 'other app content' }],
    structuredContent: {
      pid: 402,
      window_id: 77,
      window_title: target.title,
      tree_markdown: 'other app content',
    },
  });
  const result = waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  await vi.advanceTimersByTimeAsync(EvaluationWindowLimits.POLL_MS);
  await expect(result).resolves.toMatchObject({ processId: 401, windowId: 77 });
  expect(fixture.server.callTool).toHaveBeenCalledTimes(4);
});

it('rejects explicit refused results even if they contain a stale valid window or content', async () => {
  vi.useFakeTimers();
  const fixture = createFixture();
  const windows = createWindowList();
  const state = createWindowState();
  fixture.server.callTool
    .mockResolvedValueOnce({
      ...windows,
      structuredContent: { ...windows.structuredContent, status: 'refused' },
    })
    .mockResolvedValueOnce(windows)
    .mockResolvedValueOnce({
      ...state,
      structuredContent: { ...state.structuredContent, status: 'refused' },
    });
  const result = waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  await vi.advanceTimersByTimeAsync(EvaluationWindowLimits.POLL_MS * 2);
  await expect(result).resolves.toMatchObject({ windowId: 77 });
  expect(fixture.server.callTool.mock.calls.map(([name]) => name)).toEqual([
    'list_windows',
    'list_windows',
    'get_window_state',
    'list_windows',
    'get_window_state',
  ]);
});

it('accepts an exact-window screenshot only when the driver validated its frame', async () => {
  const fixture = createFixture();
  fixture.server.callTool.mockResolvedValueOnce(createWindowList()).mockResolvedValueOnce({
    content: [{ type: 'image', data: 'synthetic-image-bytes' }],
    structuredContent: {
      pid: 401,
      window_id: 77,
      window_title: target.title,
      screenshot_frame_valid: true,
    },
  });
  await expect(
    waitForEvaluationWindow(connection, target, undefined, fixture.ports),
  ).resolves.toMatchObject({
    contentObserved: true,
  });
});

it('times out for metadata-only or refused observations and closes its connection', async () => {
  vi.useFakeTimers();
  const fixture = createFixture();
  fixture.server.callTool.mockImplementation((name) =>
    Promise.resolve(
      name === 'list_windows'
        ? createWindowList()
        : {
            content: [{ type: 'image', data: 'unverified-image' }],
            structuredContent: {
              pid: 401,
              window_id: 77,
              window_title: target.title,
              tree_markdown: '',
              elements: [],
              screenshot_frame_valid: false,
            },
          },
    ),
  );
  const result = waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  const rejected = expect(result).rejects.toThrow(EvaluationWindowFailure.TIMED_OUT);
  await vi.advanceTimersByTimeAsync(EvaluationWindowLimits.READY_MS);
  await rejected;
  expect(fixture.server.close).toHaveBeenCalledOnce();
});

it('does not create a connection when the request has already been cancelled', async () => {
  const fixture = createFixture();
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    waitForEvaluationWindow(connection, target, cancellation.signal, fixture.ports),
  ).rejects.toThrow(EvaluationWindowFailure.CANCELLED);
  expect(fixture.ports.createConnection).not.toHaveBeenCalled();
});

it('waits for an in-flight connection to settle before confirming cancellation cleanup', async () => {
  const fixture = createFixture();
  let completeConnection = (): void => {
    throw new Error('Synthetic connection was not started.');
  };
  fixture.server.connect.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completeConnection = resolve;
      }),
  );
  const cancellation = new AbortController();
  const result = waitForEvaluationWindow(connection, target, cancellation.signal, fixture.ports);
  const rejected = expect(result).rejects.toThrow(EvaluationWindowFailure.CANCELLED);
  cancellation.abort();
  expect(fixture.server.close).not.toHaveBeenCalled();
  completeConnection();
  await rejected;
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.server.callTool).not.toHaveBeenCalled();
});

it('reports safe failure codes without raw driver errors or credentials', async () => {
  const fixture = createFixture();
  fixture.server.callTool.mockRejectedValue(new Error('private-token raw error'));
  await expect(
    waitForEvaluationWindow(connection, target, undefined, fixture.ports),
  ).rejects.toThrow(EvaluationWindowFailure.PROBE_FAILED);
  expect(fixture.server.close).toHaveBeenCalledOnce();
});

it('rejects an unconfirmed transport cleanup even after readiness was observed', async () => {
  vi.useFakeTimers();
  const fixture = createFixture();
  fixture.server.close.mockImplementation(() => new Promise<void>(() => {}));
  const result = waitForEvaluationWindow(connection, target, undefined, fixture.ports);
  const rejected = expect(result).rejects.toThrow(EvaluationWindowFailure.CLEANUP_UNCONFIRMED);
  await vi.advanceTimersByTimeAsync(EvaluationWindowLimits.CLEANUP_MS);
  await rejected;
});

it('does not fulfill readiness when cancellation arrives during transport cleanup', async () => {
  const fixture = createFixture();
  const cancellation = new AbortController();
  fixture.server.close.mockImplementation(() => {
    cancellation.abort();
    return Promise.resolve();
  });
  await expect(
    waitForEvaluationWindow(connection, target, cancellation.signal, fixture.ports),
  ).rejects.toThrow(EvaluationWindowFailure.CANCELLED);
  expect(fixture.server.close).toHaveBeenCalledOnce();
});

it('uses only the host connection with read-only native tool calls in the default transport', async () => {
  vi.spyOn(MCPServerStdio.prototype, 'connect').mockResolvedValue(undefined);
  const call = vi
    .spyOn(MCPServerStdio.prototype, 'callToolResult')
    .mockResolvedValueOnce(createWindowList())
    .mockResolvedValueOnce(createWindowState());
  const close = vi.spyOn(MCPServerStdio.prototype, 'close').mockResolvedValue(undefined);
  await expect(waitForEvaluationWindow(connection, target)).resolves.toMatchObject({
    windowId: 77,
  });
  expect(call.mock.calls.map(([name]) => name)).toEqual(['list_windows', 'get_window_state']);
  expect(close).toHaveBeenCalledOnce();
});
