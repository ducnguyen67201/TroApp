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
});
