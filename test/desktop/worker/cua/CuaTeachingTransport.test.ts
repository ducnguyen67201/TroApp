import { MCPServerStdio, mcpToFunctionTool, RunContext, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskMode, GuidanceReason, CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const presentationId = '33333333-3333-4333-8333-333333333333';
const teachingMessage = {
  lessonId: epoch,
  stepId: '22222222-2222-4222-8222-222222222222',
  sequence: 1,
  kind: 'instruction' as const,
  text: 'Private instruction',
};
const spatialRequest = {
  presentation_version: 3,
  presentation_id: presentationId,
  capture_id: 'original-capture',
  text_only: false,
  targets: [{ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }],
  drawing: {
    strokes: [
      {
        points: [
          { x: 0.4, y: 0.4 },
          { x: 0.5, y: 0.4 },
        ],
        closed: false,
      },
    ],
  },
};

function captureResult(captureId = 'original-capture'): CallToolResult {
  return {
    content: [{ type: 'image', data: 'cHJpdmF0ZS1zY3JlZW5zaG90', mimeType: 'image/png' }],
    structuredContent: {
      capture_id: captureId,
      display: 'primary',
      screen_width: 1200,
      screen_height: 800,
      screenshot_width: 1200,
      screenshot_height: 800,
      scale_factor: 1,
    },
  };
}

function presentationResult(receiptPresentationId = presentationId): CallToolResult {
  return {
    content: [],
    structuredContent: {
      status: 'presented',
      following: true,
      active: false,
      receipt: {
        presentation_version: 3,
        task_epoch: epoch,
        sequence_id: '44444444-4444-4444-8444-444444444444',
        presentation_id: receiptPresentationId,
        lesson_id: teachingMessage.lessonId,
        step_id: teachingMessage.stepId,
        message_presented: true,
        drawing_presented: true,
        text_only: false,
        interrupted: false,
        strokes_presented: [{ stroke_index: 0, trace_progress: 1, hold_ms_observed: 1100 }],
      },
    },
  };
}

function createNativeResponse(state: string): CallToolResult {
  if (state === 'unchanged') {
    return presentationResult();
  }
  if (state === 'foreign_receipt') {
    return presentationResult('66666666-6666-4666-8666-666666666666');
  }
  if (state === 'accepted' || state === 'completed') {
    return { content: [], structuredContent: { status: state, following: true, active: false } };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: 'Private native comparison' }],
    structuredContent: { status: 'refused', code: 'fresh_observation_required', reason: state },
  };
}

describe('Cua tool schemas presented to the Agents SDK', () => {
  it('reports a native text-only render timeout without replaying or logging its content', async () => {
    const epoch = '11111111-1111-4111-8111-111111111111';
    const presentationId = '33333333-3333-4333-8333-333333333333';
    const native: CallToolResult = {
      content: [{ type: 'text', text: 'Private native message' }],
      isError: true,
      structuredContent: {
        status: 'failed',
        active: false,
        following: true,
        task_epoch: epoch,
        sequence_id: '44444444-4444-4444-8444-444444444444',
        code: GuidanceReason.RENDER_TIMEOUT,
      },
    };
    const call = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValueOnce(captureResult('private-capture'))
      .mockResolvedValue(native);
    const logs: string[] = [];
    const server = new LoggedCuaServer(
      { name: 'Render diagnostics test', command: 'unused' },
      pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
    );
    const terminal = vi.fn<() => void>();
    server.beginTeachingTask(epoch, terminal);
    server.setHudGroup('private-group');
    try {
      await server.callToolResult('get_desktop_state', {});
      const result = await server.showTeachingCue(
        {
          capture_id: 'private-capture',
          presentation_id: presentationId,
          presentation_version: 3,
          text_only: true,
          drawing: null,
        },
        {
          lessonId: epoch,
          stepId: '22222222-2222-4222-8222-222222222222',
          sequence: 3,
          kind: 'instruction',
          text: 'Private typing instruction',
        },
        DesktopLocale.ENGLISH,
      );
      expect(result.structuredContent).toEqual(native.structuredContent);
      expect(result.isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
      expect(terminal).toHaveBeenCalledOnce();
      const encoded = logs.join('');
      expect(encoded).toContain('cua.response');
      expect(encoded).not.toContain('cua.render.');
      expect(encoded).toContain('render_timeout');
      expect(encoded).not.toContain('Private');
      expect(encoded).not.toContain('private-capture');
      expect(encoded).not.toContain('private-group');
    } finally {
      call.mockRestore();
    }
  });

  it.each(['silent', 'debug'])(
    'passes capture IDs and screenshots through the SDK with %s logging',
    async (level) => {
      const captureId = 'capture_0123456789abcdef0123456789abcdef_0000000000000001';
      const metadata = { capture_id: captureId, screenshot_width: 1200, screenshot_height: 800 };
      const image = { type: 'image' as const, data: 'synthetic-image', mimeType: 'image/png' };
      const call = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
        content: [image, { type: 'text', text: 'desktop screenshot 1200x800 px' }],
        structuredContent: metadata,
      });
      const server = new LoggedCuaServer(
        { name: 'Metadata test', command: 'unused' },
        pino({ level }, { write() {} }),
      );
      const agentTool = mcpToFunctionTool(
        {
          name: 'get_desktop_state',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true },
        },
        server,
        false,
      );
      try {
        const output: unknown = await agentTool.invoke(new RunContext(), '{}');
        expect(output).toEqual(
          expect.arrayContaining([
            image,
            { type: 'text', text: 'desktop screenshot 1200x800 px' },
            { type: 'text', text: JSON.stringify(metadata) },
          ]),
        );
        expect(call).toHaveBeenCalledTimes(1);
      } finally {
        call.mockRestore();
      }
    },
  );

  it('preserves window targets and refusal details in the agent-visible result', async () => {
    const call = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
    const server = new LoggedCuaServer(
      { name: 'Window metadata test', command: 'unused' },
      pino({ level: 'silent' }),
    );
    try {
      const windows = { windows: [{ pid: 123, window_id: 456, title: 'Synthetic window' }] };
      call.mockResolvedValue({
        content: [{ type: 'text', text: 'Found 1 window.' }],
        structuredContent: windows,
      });
      expect((await server.callToolResult('list_windows', {})).content).toContainEqual({
        type: 'text',
        text: JSON.stringify(windows),
      });
      const refusal = {
        status: 'refused',
        refusal: { code: 'synthetic_refusal', message: 'Refresh the window.' },
      };
      call.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Refused.' }],
        structuredContent: refusal,
      });
      const result = await server.callToolResult('get_browser_state', {});
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify(refusal) });
    } finally {
      call.mockRestore();
    }
  });

  it('uses Cua read-only annotations to identify calls needing a later observation', async () => {
    const tools = [
      {
        name: 'launch_app',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      {
        name: 'get_window_state',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ];
    const listTools = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(tools);
    const server = new LoggedCuaServer(
      { name: 'Cua annotations test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      await server.listTools();
      expect(server.taskEvidence.isMutation('launch_app')).toBe(true);
      expect(server.taskEvidence.isMutation('get_window_state')).toBe(false);
    } finally {
      listTools.mockRestore();
    }
  });

  it('keeps open arguments non-strict without triggering strict conversion warnings', async () => {
    const cuaTool = {
      name: 'browser_click',
      description: 'Click a bound page element.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          target_id: { type: 'string' },
          tab_id: { type: 'string' },
        },
        required: ['target_id', 'tab_id'],
        additionalProperties: true,
      },
    };
    const listTools = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([cuaTool]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new LoggedCuaServer(
      { name: 'Cua schema test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      const [preparedTool] = await server.listTools();
      expect(preparedTool).toBeDefined();
      if (!preparedTool) {
        return;
      }
      const agentTool = mcpToFunctionTool(preparedTool, server, false);

      expect(cuaTool.inputSchema.additionalProperties).toBe(true);
      expect(preparedTool.inputSchema.additionalProperties).toBe(false);
      expect(agentTool.strict).toBe(false);
      expect(agentTool.parameters).toEqual(cuaTool.inputSchema);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      listTools.mockRestore();
      warning.mockRestore();
    }
  });

  it('records a failed Cua action even when debug logging is disabled', async () => {
    const failedResult: CallToolResult = {
      content: [{ type: 'text', text: 'Could not activate window.' }],
      structuredContent: { code: 'bring_to_front_window_not_found' },
      isError: true,
    };
    const callTool = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValue(failedResult);
    const server = new LoggedCuaServer(
      { name: 'Cua result test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );

    try {
      await server.callToolResult('bring_to_front', { pid: 7, window_id: 12 });
      expect(server.taskEvidence.readSnapshot().failureCount).toBe(1);
    } finally {
      callTool.mockRestore();
    }
  });
  it('rejects hidden actions, host controls and session spoofing before native dispatch in teaching mode', async () => {
    const call = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValue({ content: [] });
    const server = new LoggedCuaServer(
      { name: 'Teaching policy test', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.setTaskMode('teach');
    try {
      for (const name of [
        'click',
        'drag',
        'type_text',
        'hotkey',
        'browser_navigate',
        'run_code',
        'future_tool',
        'set_cursor_companion_mode',
      ]) {
        expect((await server.callToolResult(name, {})).isError).toBe(true);
      }
      expect(
        (await server.callToolResult('get_desktop_state', { session: 'another-agent' })).isError,
      ).toBe(true);
      expect(
        (await server.callToolResult('get_desktop_state', { _session_id: 'another-agent' }))
          .isError,
      ).toBe(true);
      expect(call).not.toHaveBeenCalled();
      server.beginTeachingTask('11111111-1111-4111-8111-111111111111', () => {});
      await server.callToolResult('bring_to_front', { pid: 1, window_id: 2 });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      call.mockRestore();
    }
  });
});

describe('host-owned V3 presentation', () => {
  it('keeps the native presentation private and refuses legacy model tools', async () => {
    const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
      {
        name: CursorCompanionTool.PRESENT_GUIDANCE,
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: CursorCompanionTool.BEGIN_TASK,
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]);
    const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
    const server = new LoggedCuaServer(
      { name: 'Private V3', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.beginTeachingTask(epoch, () => {});
    try {
      expect(await server.listTools()).toEqual([]);
      expect(
        (await server.callToolResult(CursorCompanionTool.PRESENT_GUIDANCE, spatialRequest)).isError,
      ).toBe(true);
      expect((await server.callToolResult('show_cursor_sequence', {})).isError).toBe(true);
      expect(native).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      native.mockRestore();
      server.endTeachingTask();
    }
  });

  it.each([
    'unchanged',
    'target_changed',
    'geometry_changed',
    'capture_unavailable',
    'accepted',
    'completed',
    'foreign_receipt',
  ])(
    'uses one native refresh/render request and validates %s evidence without private content logs',
    async (state) => {
      const logs: string[] = [];
      const terminal = vi.fn<() => void>();
      const server = new LoggedCuaServer(
        { name: 'V3 native freshness', command: 'unused' },
        pino({ level: 'debug' }, { write: (line: string) => logs.push(line) }),
      );
      server.beginTeachingTask(epoch, terminal);
      server.setHudGroup('55555555-5555-4555-8555-555555555555');
      const response = createNativeResponse(state);
      const native = vi
        .spyOn(MCPServerStdio.prototype, 'callToolResult')
        .mockResolvedValueOnce(captureResult())
        .mockResolvedValue(response);
      try {
        await server.callToolResult('get_desktop_state', { max_image_dimension: 1200 });
        const result = await server.showTeachingCue(
          spatialRequest,
          teachingMessage,
          DesktopLocale.ENGLISH,
        );
        expect(native.mock.calls.map(([name]) => name)).toEqual([
          'get_desktop_state',
          CursorCompanionTool.PRESENT_GUIDANCE,
        ]);
        expect(native.mock.calls[1]?.[1]).toMatchObject({
          ...spatialRequest,
          max_image_dimension: 1200,
          teaching_message: teachingMessage,
          teaching_locale: 'en',
        });
        expect(native.mock.calls[1]?.[1]?.drawing).toEqual(spatialRequest.drawing);
        if (state === 'unchanged') {
          expect(result.isError).not.toBe(true);
          expect(server.taskEvidence.readTeachingResult('Continue')).toEqual({
            outcome: 'demonstrated',
            answer: 'Continue',
          });
          expect(terminal).not.toHaveBeenCalled();
        } else if (['target_changed', 'geometry_changed', 'capture_unavailable'].includes(state)) {
          expect(result.isError).toBe(true);
          expect(server.taskEvidence.hasPendingGuidance()).toBe(false);
          expect(server.taskEvidence.hasTerminalGuidance()).toBe(false);
          expect(terminal).not.toHaveBeenCalled();
          native.mockResolvedValue(presentationResult());
          expect(
            (await server.showTeachingCue(spatialRequest, teachingMessage, DesktopLocale.ENGLISH))
              .isError,
          ).not.toBe(true);
        } else {
          expect(result.isError).toBe(true);
          expect(server.taskEvidence.readTeachingResult('Continue')).toEqual({
            outcome: 'failed',
            reason: 'transport_failed',
          });
          expect(terminal).toHaveBeenCalledOnce();
        }
        const encoded = logs.join('');
        expect(encoded).not.toContain('Private instruction');
        expect(encoded).not.toContain('Private native comparison');
        expect(encoded).not.toContain('cHJpdmF0ZS1zY3JlZW5zaG90');
      } finally {
        native.mockRestore();
        server.endTeachingTask();
      }
    },
  );

  it('retains takeover as terminal and never dispatches a later replay', async () => {
    const canceled: CallToolResult = {
      content: [],
      isError: true,
      structuredContent: {
        status: 'canceled',
        active: false,
        following: true,
        task_epoch: epoch,
        sequence_id: '44444444-4444-4444-8444-444444444444',
        reason: 'user_takeover',
      },
    };
    const native = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValueOnce(captureResult())
      .mockResolvedValue(canceled);
    const server = new LoggedCuaServer(
      { name: 'V3 takeover', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.beginTeachingTask(epoch, () => {});
    try {
      await server.callToolResult('get_desktop_state', {});
      await server.showTeachingCue(spatialRequest, teachingMessage, DesktopLocale.ENGLISH);
      await server.showTeachingCue(spatialRequest, teachingMessage, DesktopLocale.ENGLISH);
      expect(native).toHaveBeenCalledTimes(2);
      expect(server.taskEvidence.readTeachingResult('Done')).toEqual({
        outcome: 'canceled',
        reason: 'user_takeover',
      });
    } finally {
      native.mockRestore();
      server.endTeachingTask();
    }
  });
});

it('never advertises or dispatches private HUD tools to a model in either task mode', async () => {
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
    {
      name: CursorCompanionTool.PRESENT_GUIDANCE,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'set_companion_hud',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'bind_companion_hud_cursor',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'send_companion_hud_command',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ]);
  const server = new LoggedCuaServer(
    { name: 'HUD policy', command: 'unused' },
    pino({ level: 'silent' }),
  );
  try {
    for (const mode of Object.values(AgentTaskMode)) {
      server.setTaskMode(mode);
      expect(await server.listTools()).toEqual([]);
      expect((await server.callToolResult(CursorCompanionTool.PRESENT_GUIDANCE, {})).isError).toBe(
        true,
      );
      expect((await server.callToolResult('set_companion_hud', {})).isError).toBe(true);
      expect((await server.callToolResult('bind_companion_hud_cursor', {})).isError).toBe(true);
      expect((await server.callToolResult('send_companion_hud_command', {})).isError).toBe(true);
    }
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    list.mockRestore();
  }
});

it('does not let the teaching model cancel the lesson', async () => {
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const server = new LoggedCuaServer(
    { name: 'Teaching policy', command: 'unused' },
    pino({ level: 'silent' }),
  );
  server.beginTeachingTask('11111111-1111-4111-8111-111111111111', () => {});
  try {
    const result = await server.callToolResult('cancel_cursor_sequence', {});
    expect(result.isError).toBe(true);
    expect(native).not.toHaveBeenCalled();
  } finally {
    server.endTeachingTask();
    native.mockRestore();
  }
});

it('requires a fresh observation before stale coordinates without ending the lesson epoch', async () => {
  const native = vi
    .spyOn(MCPServerStdio.prototype, 'callToolResult')
    .mockResolvedValue({ content: [] });
  const server = new LoggedCuaServer(
    { name: 'Observation admission', command: 'unused' },
    pino({ level: 'silent' }),
  );
  const terminal = vi.fn<() => void>();
  server.beginTeachingTask('11111111-1111-4111-8111-111111111111', terminal);
  server.setPreviewAdmission(() => Promise.resolve(false));
  const stale = vi.fn<() => void>();
  try {
    const result = await server.showTeachingCue(
      { ...spatialRequest, capture_id: 'old' },
      teachingMessage,
      DesktopLocale.ENGLISH,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('fresh_observation_required');
    expect(stale).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(server.taskEvidence.hasTerminalGuidance()).toBe(false);
    expect(server.taskEvidence.hasPendingGuidance()).toBe(false);
  } finally {
    server.endTeachingTask();
    native.mockRestore();
  }
});

it('keeps all desktop observation controls private in both modes', async () => {
  const names = ['begin_desktop_watch', 'read_desktop_watch', 'end_desktop_watch'];
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(
    names.map((name) => ({
      name,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    })),
  );
  const server = new LoggedCuaServer(
    { name: 'Observer policy', command: 'unused' },
    pino({ level: 'silent' }),
  );
  try {
    for (const mode of Object.values(AgentTaskMode)) {
      server.setTaskMode(mode);
      expect(await server.listTools()).toEqual([]);
      for (const name of names) {
        expect((await server.callToolResult(name, {})).isError).toBe(true);
      }
    }
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    list.mockRestore();
  }
});

it('reports failed native watch admission without exposing payloads or logging routine polls', async () => {
  const logs: string[] = [];
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
    isError: true,
    content: [{ type: 'text', text: 'private native detail' }],
    structuredContent: { code: 'invalid_arguments', detail: 'private session metadata' },
  });
  const server = new LoggedCuaServer(
    { name: 'Host diagnostics', command: 'unused' },
    pino({ level: 'debug' }, { write: (line: string) => logs.push(line) }),
  );
  try {
    await server.callHostTool('begin_desktop_watch', { watch_id: 'private-watch-id' });
    expect(logs.join('')).toContain('cua.host.response');
    expect(logs.join('')).toContain('"level":50');
    expect(logs.join('')).toContain('invalid_arguments');
    expect(logs.join('')).not.toContain('private-');
    expect(logs.join('')).not.toContain('private native');
    expect(logs.join('')).not.toContain('private session');
    logs.length = 0;
    native.mockResolvedValue({ content: [], structuredContent: { ready: true } });
    await server.callHostTool('read_desktop_watch', { watch_id: 'private-watch-id' });
    expect(logs).toEqual([]);
    native.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'watch_lost' }] });
    await server.callHostTool('read_desktop_watch', { watch_id: 'private-watch-id' });
    expect(logs.join('')).toContain('watch_lost');
    expect(logs.join('')).not.toContain('private-watch-id');
  } finally {
    native.mockRestore();
  }
});

it('refuses an unobserved capture instead of bypassing the local target check', async () => {
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const server = new LoggedCuaServer(
    { name: 'Capture provenance', command: 'unused' },
    pino({ level: 'silent' }),
  );
  const stale = vi.fn<() => void>();
  server.beginTeachingTask('11111111-1111-4111-8111-111111111111', () => {});
  try {
    const result = await server.showTeachingCue(
      { ...spatialRequest, capture_id: 'not-observed' },
      teachingMessage,
      DesktopLocale.ENGLISH,
    );
    expect(result.isError).toBe(true);
    expect(native).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    expect(server.taskEvidence.hasTerminalGuidance()).toBe(false);
  } finally {
    server.endTeachingTask();
    native.mockRestore();
  }
});

it('keeps successful following renewals quiet while retaining transitions and failures', async () => {
  const logs: string[] = [];
  const following: CallToolResult = {
    content: [{ type: 'text', text: 'following' }],
    structuredContent: { status: 'following', following: true, active: false },
  };
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue(following);
  const server = new LoggedCuaServer(
    { name: 'Following diagnostics', command: 'unused' },
    pino({ level: 'debug' }, { write: (line: string) => logs.push(line) }),
  );
  const follow = { mode: 'follow', label: 'Tro' };
  try {
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs.join('')).toContain('cua.host.request');
    expect(logs.join('')).toContain('cua.host.response');
    logs.length = 0;
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs).toEqual([]);

    native.mockResolvedValue({ isError: true, content: [] });
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs.join('')).toContain('"level":50');
    expect(logs.join('')).toContain('cua.host.response');
    logs.length = 0;
    native.mockResolvedValue(following);
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs.join('')).toContain('cua.host.request');

    logs.length = 0;
    native.mockResolvedValue({ content: [], structuredContent: { following: true } });
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs.join('')).toContain('cua.host.response');

    native.mockResolvedValue(following);
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    logs.length = 0;
    native.mockRejectedValue(new Error('Disconnected'));
    await expect(server.callHostTool(CursorCompanionTool.SET_MODE, follow)).rejects.toThrow(
      'Disconnected',
    );
    expect(logs.join('')).toContain('cua.host.failed');

    native.mockResolvedValue({
      content: [],
      structuredContent: { status: 'hidden', following: false, active: false },
    });
    logs.length = 0;
    await server.callHostTool(CursorCompanionTool.SET_MODE, { mode: 'hidden' });
    expect(logs.join('')).toContain('cua.host.request');
    native.mockResolvedValue(following);
    logs.length = 0;
    await server.callHostTool(CursorCompanionTool.SET_MODE, follow);
    expect(logs.join('')).toContain('cua.host.request');
  } finally {
    native.mockRestore();
  }
});

it('binds a new native lesson through the private host path and refuses failed context admission', async () => {
  const server = new LoggedCuaServer(
    { name: 'HUD lesson context', command: 'unused' },
    pino({ level: 'silent' }),
  );
  const host = vi
    .spyOn(server, 'callHostTool')
    .mockResolvedValue({ content: [], structuredContent: { applied: true } });
  const group = '11111111-1111-4111-8111-111111111111';
  const lessonId = '22222222-2222-4222-8222-222222222222';
  await server.bindTeachingLesson(lessonId);
  expect(host).not.toHaveBeenCalled();
  server.setHudGroup(group);
  await server.bindTeachingLesson(lessonId);
  expect(host).toHaveBeenCalledWith('bind_companion_hud_cursor', { group, lessonId });
  host.mockResolvedValueOnce({ content: [], isError: true });
  await expect(server.bindTeachingLesson(lessonId)).rejects.toThrow(
    'Native teaching context unavailable',
  );
  host.mockRestore();
});
