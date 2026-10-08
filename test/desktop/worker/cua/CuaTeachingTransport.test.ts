import { MCPServerStdio, mcpToFunctionTool, RunContext, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskMode, GuidanceReason, CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { TaskIssue } from '../../../../src/desktop/worker/cua/CuaTaskEvidence.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

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
    const call = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue(native);
    const logs: string[] = [];
    const server = new LoggedCuaServer(
      { name: 'Render diagnostics test', command: 'unused' },
      pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
    );
    const terminal = vi.fn<() => void>();
    server.beginTeachingTask(epoch, terminal);
    server.setHudGroup('private-group');
    try {
      const result = await server.showTeachingCue(
        {
          capture_id: 'private-capture',
          presentation_id: presentationId,
          presentation_version: 2,
          text_only: true,
          steps: [],
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
      expect(call).toHaveBeenCalledOnce();
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

  it('requires a completed native preview result, not an acceptance receipt', async () => {
    const call = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValue({ content: [], structuredContent: { status: 'accepted' } });
    const server = new LoggedCuaServer(
      { name: 'Preview evidence test', command: 'unused' },
      pino({ level: 'silent' }),
    );
    try {
      expect((await server.callToolResult('show_cursor_sequence', {})).isError).toBe(true);
      expect(server.taskEvidence.readIssue()).toBe(TaskIssue.GUIDANCE_FAILED);
      call.mockResolvedValue({
        content: [],
        structuredContent: { status: 'completed', following: true, active: false },
      });
      expect((await server.callToolResult('show_cursor_sequence', {})).isError).not.toBe(true);
      expect(server.taskEvidence.readIssue()).toBeNull();
    } finally {
      call.mockRestore();
    }
  });
});

describe('host-pinned V2 guidance', () => {
  const epoch = '11111111-1111-4111-8111-111111111111';
  const sequence = '22222222-2222-4222-8222-222222222222';
  const request = { presentation_version: 2, capture_id: 'capture', steps: [{ kind: 'circle' }] };

  it('requires literal V2 in the advertised schema and rejects omission before dispatch', async () => {
    const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
      {
        name: 'show_cursor_sequence',
        inputSchema: {
          type: 'object',
          properties: { session: { type: 'string' }, presentation_version: { type: 'integer' } },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'begin_cursor_guidance_task',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]);
    const call = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
    const stop = vi.fn();
    const server = new LoggedCuaServer(
      { name: 'V2', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.beginTeachingTask(epoch, stop);
    try {
      const tools = await server.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.inputSchema.properties).toEqual({
        presentation_version: { type: 'integer', const: 2 },
      });
      expect(tools[0]?.inputSchema.required).toContain('presentation_version');
      expect((await server.callToolResult('show_cursor_sequence', { steps: [] })).isError).toBe(
        true,
      );
      expect(call).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      list.mockRestore();
      call.mockRestore();
    }
  });

  it('retains takeover as terminal and never dispatches a later replay', async () => {
    const call = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockImplementation(async (name) => {
        await Promise.resolve();
        if (name === 'get_desktop_state') {
          return {
            content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
            structuredContent: {
              capture_id: 'capture',
              display: 'primary',
              screen_width: 1000,
              screen_height: 800,
              screenshot_width: 1000,
              screenshot_height: 800,
              scale_factor: 1,
            },
          };
        }
        if (name === CursorCompanionTool.REFRESH_CAPTURE) {
          return {
            content: [],
            structuredContent: {
              matched: true,
              capture_id: 'refreshed',
              reason: 'target_unchanged',
            },
          };
        }
        return {
          content: [],
          isError: true,
          structuredContent: {
            status: 'canceled',
            active: false,
            following: true,
            task_epoch: epoch,
            sequence_id: sequence,
            reason: 'user_takeover',
          },
        };
      });
    const stop = vi.fn();
    const server = new LoggedCuaServer(
      { name: 'V2', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.beginTeachingTask(epoch, stop);
    try {
      await server.callToolResult('get_desktop_state', {});
      await server.callToolResult('show_cursor_sequence', request);
      await server.callToolResult('show_cursor_sequence', request);
      expect(call.mock.calls.map(([name]) => name)).toEqual([
        'get_desktop_state',
        CursorCompanionTool.REFRESH_CAPTURE,
        CursorCompanionTool.SHOW_SEQUENCE,
      ]);
      expect(server.taskEvidence.readTeachingResult('Done')).toEqual({
        outcome: 'canceled',
        reason: 'user_takeover',
      });
    } finally {
      call.mockRestore();
    }
  });
});

describe('capture renewal before V2 native dispatch', () => {
  it.each([
    'unchanged',
    'changed',
    'geometry',
    'takeover',
    'refused',
    'malformed',
    'input_during_refresh',
  ])(
    'handles a delayed model with a %s capture without replay or private logging',
    async (state) => {
      const epoch = '11111111-1111-4111-8111-111111111111';
      const sequence = '22222222-2222-4222-8222-222222222222';
      const logs: string[] = [];
      const server = new LoggedCuaServer(
        { name: 'Capture renewal', command: 'unused' },
        pino({ level: 'debug' }, { write: (line: string) => logs.push(line) }),
      );
      let nowMs = 0;
      let canShow = true;
      server.setPreviewAdmission(() => Promise.resolve(canShow));
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
      const terminal = vi.fn<() => void>();
      server.beginTeachingTask(epoch, terminal);
      const call = vi
        .spyOn(MCPServerStdio.prototype, 'callToolResult')
        .mockImplementation(async (name) => {
          await Promise.resolve();
          if (name === 'get_desktop_state') {
            return {
              content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
              structuredContent: {
                capture_id: 'private-original-capture',
                display: 'primary',
                screen_width: 1200,
                screen_height: 800,
                screenshot_width: 1200,
                screenshot_height: 800,
                scale_factor: 1,
              },
            };
          }
          if (name === CursorCompanionTool.REFRESH_CAPTURE) {
            if (state === 'input_during_refresh') {
              canShow = false;
            }
            if (state === 'takeover') {
              server.taskEvidence.cancelGuidance(GuidanceReason.USER_TAKEOVER);
            }
            const matched =
              state === 'unchanged' || state === 'takeover' || state === 'input_during_refresh';
            return {
              content: [{ type: 'text', text: 'Private native diagnostic' }],
              isError: state === 'refused',
              structuredContent:
                state === 'malformed'
                  ? { matched: true }
                  : {
                      matched,
                      capture_id: matched ? 'private-refreshed-capture' : null,
                      reason: matched
                        ? 'target_unchanged'
                        : state === 'geometry'
                          ? 'geometry_changed'
                          : 'target_changed',
                    },
            };
          }
          return {
            content: [],
            structuredContent: {
              status: 'completed',
              following: true,
              active: false,
              receipt: {
                presentation_version: 2,
                task_epoch: epoch,
                sequence_id: sequence,
                completed_steps: 1,
              },
            },
          };
        });
      try {
        await server.callToolResult('get_desktop_state', { max_image_dimension: 1200 });
        nowMs = 6000;
        const pending = server.callToolResult('show_cursor_sequence', {
          presentation_version: 2,
          capture_id: 'private-original-capture',
          steps: [{ kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.05, duration_ms: 600 }],
        });
        if (state === 'refused' || state === 'malformed') {
          await expect(pending).rejects.toMatchObject({ code: 'capture_refresh_failed' });
          expect(terminal).toHaveBeenCalledOnce();
          expect(logs.join('')).toContain('cua.guidance.refresh_failed');
          expect(logs.join('')).not.toContain('Private native');
          expect(call.mock.calls.map(([name]) => name)).toEqual([
            'get_desktop_state',
            CursorCompanionTool.REFRESH_CAPTURE,
          ]);
          return;
        }
        const result = await pending;
        expect(call.mock.calls[1]?.[0]).toBe(CursorCompanionTool.REFRESH_CAPTURE);
        expect(call.mock.calls[1]?.[1]).toMatchObject({
          max_image_dimension: 1200,
          capture_id: 'private-original-capture',
        });
        if (state === 'unchanged') {
          expect(call.mock.calls.at(-1)?.[1]).toMatchObject({
            capture_id: 'private-refreshed-capture',
          });
          expect(result.isError).not.toBe(true);
          expect(server.taskEvidence.readTeachingResult('Click the highlighted control')).toEqual({
            outcome: 'demonstrated',
            answer: 'Click the highlighted control',
          });
          expect(terminal).not.toHaveBeenCalled();
        } else {
          expect(call.mock.calls.map(([name]) => name)).toEqual([
            'get_desktop_state',
            CursorCompanionTool.REFRESH_CAPTURE,
          ]);
          expect(result.isError).toBe(true);
          expect(server.taskEvidence.readTeachingResult('Done')).toEqual(
            state === 'takeover'
              ? { outcome: 'canceled', reason: 'user_takeover' }
              : { outcome: 'needs_input', reason: 'no_demonstration' },
          );
          expect(terminal).not.toHaveBeenCalled();
        }
        const output = logs.join('');
        expect(output).toContain('cua.guidance.capture_refreshed');
        expect(output).toContain('"captureAgeMs":6000');
        expect(output).not.toContain('private-');
        expect(output).not.toContain('Private native');
        expect(output).not.toContain('aW1hZ2U=');
      } finally {
        server.endTeachingTask();
        clock.mockRestore();
        call.mockRestore();
      }
    },
  );
});

it('never advertises or dispatches private HUD tools to a model in either task mode', async () => {
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
    {
      name: CursorCompanionTool.REFRESH_CAPTURE,
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
      expect((await server.callToolResult(CursorCompanionTool.REFRESH_CAPTURE, {})).isError).toBe(
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
    const result = await server.callToolResult(CursorCompanionTool.SHOW_SEQUENCE, {
      presentation_version: 2,
      capture_id: 'old',
      steps: [{ kind: 'circle' }],
    });
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
    const result = await server.callToolResult(CursorCompanionTool.SHOW_SEQUENCE, {
      presentation_version: 2,
      capture_id: 'not-observed',
      steps: [{ kind: 'circle' }],
    });
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
