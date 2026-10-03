import { MCPServerStdio } from '@openai/agents';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { ReadOnlyCuaServer } from '../../../../src/desktop/worker/cua/ReadOnlyCuaServer.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifier Cua capability boundary', () => {
  it('requires both the observation allowlist and driver read-only annotation', async () => {
    const tools = [
      { name: 'get_window_state', annotations: { readOnlyHint: true } },
      { name: 'launch_app', annotations: { readOnlyHint: false } },
      { name: 'clipboard_read', annotations: { readOnlyHint: true } },
      { name: 'get_desktop_state', annotations: { readOnlyHint: false } },
    ].map((tool) => ({
      ...tool,
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false,
      },
    }));
    vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(tools);
    const driver = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockResolvedValue({ content: [] });
    const server = new LoggedCuaServer(
      { name: 'read-only fixture', command: 'unused' },
      pino({ level: 'silent' }),
    );
    const view = new ReadOnlyCuaServer(server);
    expect((await view.listTools()).map((tool) => tool.name)).toEqual(['get_window_state']);
    await expect(view.callToolResult('launch_app', {})).rejects.toThrow('only observe');
    await expect(view.callToolResult('get_desktop_state', {})).rejects.toThrow('only observe');
    await expect(view.callToolResult('clipboard_read', {})).rejects.toThrow('only observe');
    expect(driver).not.toHaveBeenCalled();
    await view.callTool('get_window_state', {});
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it('borrows the connection without closing or reconnecting the main transport', async () => {
    const connect = vi.spyOn(MCPServerStdio.prototype, 'connect');
    const close = vi.spyOn(MCPServerStdio.prototype, 'close');
    const server = new LoggedCuaServer(
      { name: 'lifecycle fixture', command: 'unused' },
      pino({ level: 'silent' }),
    );
    const view = new ReadOnlyCuaServer(server);
    await view.connect();
    await view.close();
    await view.invalidateToolsCache();
    expect(connect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
