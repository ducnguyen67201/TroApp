import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { ComputerUseInstructions } from './ComputerUseInstructions.js';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

describe('computer-use agent tools', () => {
  it('combines teaching restrictions with the selected reply language', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const agent = createComputerUseAgent(server, DesktopLocale.VIETNAMESE, AgentTaskMode.TEACH);
    expect(agent.instructions).toContain('Respond to the user in Vietnamese');
    expect(agent.instructions).toContain('This task is teaching');
  });

  it('exposes Cua MCP without duplicating desktop actions as local tools', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const agent = createComputerUseAgent(server, DesktopLocale.ENGLISH);

    expect(agent.mcpServers).toContain(server);
    expect(agent.tools).toEqual([]);
  });

  it('uses the task locale when reusing the same Cua connection', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const vietnameseAgent = createComputerUseAgent(server, DesktopLocale.VIETNAMESE);
    const englishAgent = createComputerUseAgent(server, DesktopLocale.ENGLISH);

    expect(vietnameseAgent.instructions).toContain(ComputerUseInstructions);
    expect(vietnameseAgent.instructions).toContain('Respond to the user in Vietnamese');
    expect(englishAgent.instructions).toContain(ComputerUseInstructions);
    expect(englishAgent.instructions).toContain('Respond to the user in English');
    expect(englishAgent.instructions).not.toContain('Respond to the user in Vietnamese');
    expect(vietnameseAgent.instructions).toContain('Respond to the user in Vietnamese');
    expect(vietnameseAgent.mcpServers).toContain(server);
    expect(englishAgent.mcpServers).toContain(server);
  });
});
