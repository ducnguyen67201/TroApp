import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { ComputerUseInstructions } from '../../../../src/desktop/worker/agent/ComputerUseInstructions.js';
import {
  createComputerUseAgent,
  createTeachingAgent,
} from '../../../../src/desktop/worker/agent/CreateComputerUseAgent.js';
import { TaskContext } from '../../../../src/desktop/worker/execution/TaskContext.js';
import { CompletionProposalSchema } from '../../../../src/desktop/worker/execution/TaskCompletionProposal.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { TeachingReplySchema } from '../../../../src/desktop/worker/teaching/TeachingReply.js';

describe('computer-use agent tools', () => {
  it('combines teaching restrictions with the selected reply language', () => {
    const server = new LoggedCuaServer(
      { name: 'Cua agent test', command: 'unused-in-this-test', args: ['mcp'] },
      pino({ level: 'silent' }),
    );
    const agent = createTeachingAgent(server, DesktopLocale.VIETNAMESE, {
      defineGoal: () => ({ admitted: true }),
      reviseGoal: () => ({ admitted: true }),
      presentStep: () => Promise.resolve({ admitted: true }),
    });
    expect(agent.instructions).toContain('Respond to the user in Vietnamese');
    expect(agent.instructions).not.toContain(ComputerUseInstructions);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'define_teaching_goal',
      'revise_teaching_goal',
      'present_teaching_step',
    ]);
    const presentationTool = agent.tools.find((tool) => tool.name === 'present_teaching_step');
    expect(presentationTool?.type).toBe('function');
    if (presentationTool?.type === 'function') {
      expect(presentationTool.parameters.required).toContain('drawing');
      expect(JSON.stringify(presentationTool.parameters)).toContain('strokes');
    }
    expect(agent.outputType).toBe(TeachingReplySchema);
    expect(agent.modelSettings.toolChoice).toBeUndefined();
    expect(agent.resetToolChoice).toBe(true);
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
