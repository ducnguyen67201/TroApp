import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createComputerUseInstructions } from './ComputerUseInstructions.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import type { TaskContext } from './TaskContext.js';
import { DefineTaskGoalSchema } from './TaskGoal.js';
import { CompletionProposalSchema } from './TaskCompletionProposal.js';
import type { TaskControls } from './TaskExecutionPorts.js';
import { TeachingReplySchema } from './TeachingReply.js';

/** Cua publishes its own tool catalog over MCP; Tro does not map actions. */
export function createComputerUseAgent(
  desktopServer: LoggedCuaServer,
  locale: DesktopLocale,
  controls: TaskControls,
): Agent<TaskContext, typeof CompletionProposalSchema> {
  return new Agent<TaskContext, typeof CompletionProposalSchema>({
    name: 'Tro computer-use assistant',
    model: 'gpt-5.4',
    instructions: createComputerUseInstructions(locale),
    mcpServers: [desktopServer],
    mcpConfig: { convertSchemasToStrict: false },
    modelSettings: { parallelToolCalls: false },
    outputType: CompletionProposalSchema,
    tools: [
      tool({
        name: 'define_task_goal',
        description:
          'Define the user requested outcome before desktop writes. Keep required criteria minimal and faithful. Wait for the returned IDs before taking actions.',
        parameters: DefineTaskGoalSchema,
        execute: (input) => controls.defineGoal(input),
      }),
      tool({
        name: 'verify_task',
        description:
          'When you believe the task is finished, ask the read-only verification agent to check the original request and observations. Wait for its verdict before final output; return its id as verificationId.',
        parameters: z.strictObject({}),
        errorFunction: null,
        execute: () => controls.requestVerification(),
      }),
    ],
  });
}

/**
 * Show me starts with desktop observation; the SDK releases the forced tool
 * choice after that call. Native receipts still settle presentation success.
 */
export function createTeachingAgent(
  desktopServer: LoggedCuaServer,
  locale: DesktopLocale,
): Agent<unknown, typeof TeachingReplySchema> {
  return new Agent({
    name: 'Tro teaching assistant',
    model: 'gpt-5.4',
    instructions: createComputerUseInstructions(locale, AgentTaskMode.TEACH),
    mcpServers: [desktopServer],
    mcpConfig: { convertSchemasToStrict: false },
    modelSettings: { parallelToolCalls: false, toolChoice: 'get_desktop_state' },
    resetToolChoice: true,
    outputType: TeachingReplySchema,
  });
}
