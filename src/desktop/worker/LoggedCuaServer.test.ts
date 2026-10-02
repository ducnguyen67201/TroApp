import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { MCPServerStdio, mcpToFunctionTool, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { TaskIssue } from './CuaTaskEvidence.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

describe('Cua tool schemas presented to the Agents SDK', () => {
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
      const accepted: CallToolResult = { content: [], structuredContent: {} };
      server.taskEvidence.record('launch_app', accepted);
      expect(server.taskEvidence.readIssue()).toBe(TaskIssue.OBSERVATION_MISSING);

      server.taskEvidence.record('get_window_state', accepted);
      expect(server.taskEvidence.readIssue()).toBeNull();
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
      expect(server.taskEvidence.readIssue()).toBe(TaskIssue.DESKTOP_ACTION_FAILED);
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

// Host presentation operations stay outside model discovery and invocation.
it('refuses private HUD operations in both task modes', async () => {
  const { canCallCuaTool } = await import('./CuaTeachingPolicy.js');
  const { CompanionHudTool } = await import('#contracts/CompanionHud.js');
  for (const mode of Object.values(AgentTaskMode)) {
    for (const name of Object.values(CompanionHudTool)) {
      expect(canCallCuaTool(name, mode)).toBe(false);
    }
  }
});
