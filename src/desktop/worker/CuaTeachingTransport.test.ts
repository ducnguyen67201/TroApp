import { MCPServerStdio, mcpToFunctionTool, RunContext, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { TaskIssue } from './CuaTaskEvidence.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

describe('Cua tool schemas presented to the Agents SDK', () => {
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
    const call = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
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
    });
    const stop = vi.fn();
    const server = new LoggedCuaServer(
      { name: 'V2', command: 'unused' },
      pino({ level: 'silent' }),
    );
    server.beginTeachingTask(epoch, stop);
    try {
      await server.callToolResult('show_cursor_sequence', request);
      await server.callToolResult('show_cursor_sequence', request);
      expect(call).toHaveBeenCalledOnce();
      expect(server.taskEvidence.readTeachingResult('Done')).toEqual({
        outcome: 'canceled',
        reason: 'user_takeover',
      });
    } finally {
      call.mockRestore();
    }
  });
});

it('never advertises or dispatches private HUD tools to a model in either task mode', async () => {
  const native = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
  const list = vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
    {
      name: 'set_companion_hud',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'bind_companion_hud_cursor',
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
      expect((await server.callToolResult('set_companion_hud', {})).isError).toBe(true);
      expect((await server.callToolResult('bind_companion_hud_cursor', {})).isError).toBe(true);
    }
    expect(native).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    list.mockRestore();
  }
});
