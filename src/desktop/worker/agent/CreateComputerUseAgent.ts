import { Agent, tool } from '@openai/agents';
import {
  createClassroomTeachingTools,
  type ClassroomTeachingSession,
} from '../teaching/ClassroomTeachingTools.js';
import { z } from 'zod';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  createComputerUseInstructions,
  ClassroomMaterialInstructions,
} from './ComputerUseInstructions.js';
import { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import type { TaskContext } from '../execution/TaskContext.js';
import { DefineTaskGoalSchema } from '../execution/TaskGoal.js';
import { CompletionProposalSchema } from '../execution/TaskCompletionProposal.js';
import type { TaskControls } from '../execution/TaskExecutionPorts.js';
import {
  TeachingProposalRecovery,
  type TeachingProposalRejection,
} from '../teaching/TeachingProposalRecovery.js';
import { TeachingReplySchema } from '../teaching/TeachingReply.js';
import {
  DefineTeachingGoalSchema,
  ReviseTeachingGoalSchema,
  PresentTeachingStepSchema,
  type PresentTeachingStep,
} from '#contracts/TeachingStep.js';

export interface TeachingAgentControls {
  defineGoal(input: z.infer<typeof DefineTeachingGoalSchema>): Record<string, unknown>;
  reviseGoal(input: z.infer<typeof ReviseTeachingGoalSchema>): Record<string, unknown>;
  presentStep(input: PresentTeachingStep): Promise<Record<string, unknown>>;
  reportInvalidProposal?(rejection: TeachingProposalRejection): void;
}

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
 * The host supplies the initial desktop observation. The model proposes typed
 * teaching steps; correlated native receipts authorize their presentation.
 */
export function createTeachingAgent(
  desktopServer: LoggedCuaServer,
  locale: DesktopLocale,
  controls: TeachingAgentControls,
  classroom?: ClassroomTeachingSession,
): Agent<unknown, typeof TeachingReplySchema> {
  const recovery = new TeachingProposalRecovery((rejection) =>
    controls.reportInvalidProposal?.(rejection),
  );
  return new Agent({
    name: 'Tro teaching assistant',
    model: 'gpt-5.4',
    instructions: `${createComputerUseInstructions(locale, AgentTaskMode.TEACH)}\n${classroom ? ClassroomMaterialInstructions : ''}`,
    mcpServers: [desktopServer],
    mcpConfig: { convertSchemasToStrict: false },
    modelSettings: { parallelToolCalls: false },
    outputType: TeachingReplySchema,
    tools: [
      ...(classroom ? createClassroomTeachingTools(classroom) : []),
      tool({
        name: 'define_teaching_goal',
        description:
          'Interpret the original request once. The host returns criterion IDs and a goal revision ID; wait for them.',
        parameters: DefineTeachingGoalSchema,
        execute: (input) => controls.defineGoal(input),
      }),
      tool({
        name: 'revise_teaching_goal',
        description:
          'Explicitly revise the interpretation when current evidence requires it. Cite the previous revision and capture; explain why the original request is still honored.',
        parameters: ReviseTeachingGoalSchema,
        execute: (input) => controls.reviseGoal(input),
      }),
      tool({
        name: 'present_teaching_step',
        description:
          'Present one reachable checkpoint with a typed action. The host derives drawing and input targets together. Click, drag, scroll, highlight and unfocused typing require a paired native drawing receipt. Read admitted and presentationId before yielding. A final chat cannot substitute for this tool.',
        /* Publish the JSON shape, then validate semantic refinements ourselves.
         * The SDK redacts invalid-input diagnostics before its error callback. */
        /* Spreading strips Zod's non-enumerable Standard Schema validator so
         * the SDK parses JSON and Tro owns the canonical validation below. */
        parameters: {
          ...z.toJSONSchema(PresentTeachingStepSchema, {
            unrepresentable: 'any',
            override: ({ jsonSchema }) => {
              /* Unique kind literals make these branches exclusive. OpenAI strict
               * tools support anyOf, while Zod emits oneOf for discriminated unions. */
              if (jsonSchema.oneOf) {
                jsonSchema.anyOf = jsonSchema.oneOf;
                delete jsonSchema.oneOf;
              }
            },
          }),
        },
        errorFunction: (_context, error) => recovery.rejectInput(error),
        execute: (input) => {
          const parsed = PresentTeachingStepSchema.safeParse(input);
          if (!parsed.success) {
            return recovery.rejectFields(
              parsed.error.issues.slice(0, 8).map((issue) => ({
                path: issue.path.map(String).join('.').slice(0, 200),
                code: issue.code,
              })),
            );
          }
          return controls.presentStep(parsed.data);
        },
      }),
    ],
  });
}
