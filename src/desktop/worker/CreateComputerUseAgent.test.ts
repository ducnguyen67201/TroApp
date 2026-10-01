import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

describe('computer-use agent tools', () => {
  it('exposes Cua MCP without duplicating desktop actions as local tools', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const agent = createComputerUseAgent(server);

    expect(agent.mcpServers).toContain(server);
    expect(agent.tools).toEqual([]);
  });
});
