import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { ComputerUseInstructions } from './ComputerUseInstructions.js';
import { createComputerUseAgent, createTeachingAgent } from './CreateComputerUseAgent.js';
import { TaskContext } from './TaskContext.js';
import { CompletionProposalSchema } from './TaskCompletionProposal.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

describe('computer-use agent tools', () => {
  it('combines teaching restrictions with the selected reply language', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const agent = createTeachingAgent(server, DesktopLocale.VIETNAMESE);
    expect(agent.instructions).toContain('Respond to the user in Vietnamese');
    expect(agent.instructions).toContain('This task is teaching');
    expect(agent.instructions).not.toContain(ComputerUseInstructions);
    expect(agent.instructions).toContain('presentation_version: 2');
    expect(agent.instructions).toContain('never retry or replay');
  });

  it('exposes Cua MCP without duplicating desktop actions as local tools', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const task = new TaskContext(server.taskEvidence, new AbortController().signal);
    const agent = createComputerUseAgent(server, DesktopLocale.ENGLISH, {
      defineGoal: (input) => task.defineGoal(input),
      requestVerification: () => Promise.resolve(null),
    });
    task.dispose();

    expect(agent.mcpServers).toContain(server);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['define_task_goal', 'verify_task']);
    expect(agent.outputType).toBe(CompletionProposalSchema);
    expect(agent.modelSettings.parallelToolCalls).toBe(false);
  });

  it('uses the task locale when reusing the same Cua connection', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const task = new TaskContext(server.taskEvidence, new AbortController().signal);
    const vietnameseAgent = createComputerUseAgent(server, DesktopLocale.VIETNAMESE, {
      defineGoal: (input) => task.defineGoal(input),
      requestVerification: () => Promise.resolve(null),
    });
    const englishAgent = createComputerUseAgent(server, DesktopLocale.ENGLISH, {
      defineGoal: (input) => task.defineGoal(input),
      requestVerification: () => Promise.resolve(null),
    });
    task.dispose();

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
