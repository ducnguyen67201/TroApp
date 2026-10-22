import { z } from 'zod';
import { ContextWorkerResponseSchema } from '#contracts/DesktopContext.js';
import { ContextToolClient } from './context/ContextToolClient.js';
import { ClassroomToolResponseSchema } from '#contracts/Classroom.js';
import { ClassroomToolClient } from './teaching/ClassroomToolClient.js';
import { AgentProgressPhase, AgentProgressSchema } from '#contracts/CompanionHud.js';
import { TeachingLessonPhase } from '#contracts/DesktopObservation.js';
import { AgentFailureCode } from '#contracts/AgentSession.js';
import { setTracingDisabled } from '@openai/agents';
import { TaskModelClient, runWithTaskModel } from './agent/TaskModelClient.js';
import {
  AgentWorkerRequestSchema,
  AgentWorkerResponseSchema,
  type AgentWorkerCommand,
  type AgentResult,
} from '#contracts/AgentSession.js';
import { ComputerUseTaskRunner } from './agent/ComputerUseTaskRunner.js';
import { createAgentDebugLogger, createLoggedModelFetch } from './agent/AgentDebugLog.js';

const parentPort = process.parentPort;

let runner: ComputerUseTaskRunner | null = null;
let sessionId: string | null = null;
let model: TaskModelClient | null = null;
let connecting = false;
let activeRun: ReturnType<ComputerUseTaskRunner['runTask']> | null = null;
let activeRequestId: string | null = null;
let dailyLimitReached = false;
let classroomTools: ClassroomToolClient | null = null;
let contextTools: ContextToolClient | null = null;

function hasReachedDailyLimit(): boolean {
  return dailyLimitReached;
}

function reportThinking(): void {
  if (activeRequestId && sessionId) {
    parentPort.postMessage(
      AgentProgressSchema.parse({
        kind: 'progress',
        requestId: activeRequestId,
        sessionId,
        phase: AgentProgressPhase.THINKING,
      }),
    );
  }
}

let activeAbort: AbortController | null = null;

/* Screen content and model turns must not enter application traces. */
setTracingDisabled(true);

function sendResult(requestId: string, result: AgentResult): void {
  parentPort.postMessage(AgentWorkerResponseSchema.parse({ requestId, result }));
}

function clearModel(): void {
  model?.dispose();
  model = null;
}

function configureModelCredential(
  gatewayToken: string,
  gatewayBaseUrl: string,
  debugEnabled: boolean,
): void {
  const log = createAgentDebugLogger(debugEnabled);
  const modelFetch = createLoggedModelFetch(log);
  model?.dispose();
  model = new TaskModelClient(gatewayToken, gatewayBaseUrl, async (input, init) => {
    reportThinking();
    const response = await modelFetch(input, init);
    if (response.status === 429) {
      try {
        const raw: unknown = await response.clone().json();
        const parsed = z.object({ message: z.string() }).safeParse(raw);
        dailyLimitReached ||=
          parsed.success && parsed.data.message === 'Daily model allowance reached.';
      } catch {
        /* Failure classification is optional. */
      }
    }
    return response;
  });
}

async function runCommand(command: AgentWorkerCommand, requestId: string): Promise<AgentResult> {
  if (command.kind === 'activity') {
    return { kind: 'failed', message: 'Activity is a one-way worker signal.' };
  }
  if (command.kind === 'locale') {
    return runner && sessionId === command.sessionId && runner.updateTeachingLocale(command.locale)
      ? { kind: 'started', sessionId: command.sessionId }
      : { kind: 'failed', message: 'No active teaching lesson.' };
  }
  switch (command.kind) {
    case 'credential': {
      if (!runner || sessionId !== command.sessionId) {
        return { kind: 'failed', message: 'The agent session ended.' };
      }
      if (!model) {
        return { kind: 'failed', message: 'No model task is bound.' };
      }
      model.refreshCredential(command.gatewayToken);
      return { kind: 'started', sessionId: command.sessionId };
    }
    case 'answer': {
      if (!runner || sessionId !== command.sessionId || !activeRun) {
        return { kind: 'failed', message: 'The teaching lesson ended.' };
      }
      return runner.submitTeachingAnswer(command.lessonId, command.message)
        ? { kind: 'accepted', lessonId: command.lessonId }
        : { kind: 'failed', message: 'The lesson is not waiting for an answer.' };
    }
    case 'prepare':
    case 'start': {
      if (activeRun || connecting || model) {
        return { kind: 'failed', message: 'An agent task is already active.' };
      }
      connecting = true;
      try {
        runner ??= await ComputerUseTaskRunner.connect(
          createAgentDebugLogger(command.debugEnabled),
          command.desktopDriver,
          false,
          command.hudGroup,
        );
        if (command.kind === 'start') {
          configureModelCredential(
            command.gatewayToken,
            command.gatewayBaseUrl,
            command.debugEnabled,
          );
        }
        sessionId = command.sessionId;
        return { kind: 'started', sessionId };
      } catch {
        clearModel();
        return {
          kind: 'failed',
          message: 'Desktop control could not start. Check desktop permissions.',
        };
      } finally {
        connecting = false;
      }
    }
    case 'finish': {
      if (command.sessionId !== sessionId || activeRun || connecting || !model) {
        return { kind: 'failed', message: 'The agent task is not settled.' };
      }
      clearModel();
      classroomTools?.dispose();
      classroomTools = null;
      sessionId = null;
      return { kind: 'stopped' };
    }
    case 'turn': {
      if (runner === null || sessionId !== command.sessionId || !model) {
        return { kind: 'failed', message: 'Start an agent session first.' };
      }
      if (activeRun !== null) {
        return { kind: 'failed', message: 'Wait for the current task to finish.' };
      }

      activeRequestId = requestId;
      dailyLimitReached = false;
      const abort = new AbortController();
      activeAbort = abort;
      const context = command.classroomContext;
      const toolClient = context
        ? new ClassroomToolClient(
            (message) => {
              parentPort.postMessage(message);
            },
            requestId,
            context.participation.id,
            abort.signal,
          )
        : null;
      classroomTools = toolClient;
      const activeRunner = runner;
      const activityContext = command.activityContext;
      const contextClient = activityContext?.enabled
        ? new ContextToolClient(
            (message) => {
              parentPort.postMessage(message);
            },
            requestId,
            abort.signal,
          )
        : null;
      contextTools = contextClient;
      const run = runWithTaskModel(model, () =>
        activeRunner.runTask(
          command.message,
          command.locale,
          abort.signal,
          command.mode,
          (phase) => {
            parentPort.postMessage(
              AgentProgressSchema.parse({
                kind: 'progress',
                requestId,
                sessionId: command.sessionId,
                phase,
              }),
            );
          },
          (
            instruction,
            phase,
            lessonId,
            teachingMessage,
            locale,
            presentationPending,
            presentationRevoked,
            canAcceptAnswer,
          ) => {
            parentPort.postMessage(
              AgentProgressSchema.parse({
                kind: 'progress',
                requestId,
                sessionId: command.sessionId,
                phase:
                  phase === TeachingLessonPhase.WAITING
                    ? AgentProgressPhase.WAITING
                    : phase === TeachingLessonPhase.NEEDS_INPUT
                      ? AgentProgressPhase.NEEDS_INPUT
                      : phase === TeachingLessonPhase.PAUSED
                        ? AgentProgressPhase.PAUSED
                        : phase === TeachingLessonPhase.OBSERVING
                          ? AgentProgressPhase.THINKING
                          : AgentProgressPhase.SHOWING,
                ...(lessonId ? { lessonId } : {}),
                teachingStep: instruction,
                ...(teachingMessage ? { teachingMessage } : {}),
                ...(presentationPending ? { presentationPending } : {}),
                ...(presentationRevoked ? { presentationRevoked } : {}),
                ...(canAcceptAnswer ? { canAcceptAnswer } : {}),
                ...(locale ? { locale } : {}),
              }),
            );
          },
          context && toolClient
            ? { context, callTool: (command) => toolClient.request(command) }
            : undefined,
          activityContext && contextClient
            ? { scope: activityContext, request: (command) => contextClient.request(command) }
            : undefined,
        ),
      );
      activeRun = run;
      try {
        return await run;
      } catch {
        // Uncertain task/native cleanup must never be reused. Main retires this worker.
        clearModel();
        if (hasReachedDailyLimit()) {
          return {
            kind: 'failed',
            message: 'Daily model allowance reached.',
            code: AgentFailureCode.DAILY_LIMIT,
          };
        }
        return {
          kind: 'failed',
          message: 'Could not complete the task. Check the connection and desktop access.',
        };
      } finally {
        toolClient?.dispose();
        contextClient?.dispose();
        contextTools = null;
        classroomTools = null;
        activeRequestId = null;
        activeRun = null;
        activeAbort = null;
      }
    }
    case 'stop': {
      if (runner === null || sessionId !== command.sessionId) {
        return { kind: 'stopped' };
      }

      activeAbort?.abort();
      try {
        await activeRun;
      } catch {
        /* The canceled run must settle before its screenshots are discarded. */
      }
      await runner.close();
      runner = null;
      sessionId = null;
      clearModel();
      return { kind: 'stopped' };
    }
  }
}

parentPort.on('message', (event) => {
  const contextResponse = ContextWorkerResponseSchema.safeParse(event.data);
  if (contextResponse.success) {
    contextTools?.receive(contextResponse.data);
    return;
  }
  const classroomResponse = ClassroomToolResponseSchema.safeParse(event.data);
  if (classroomResponse.success) {
    classroomTools?.receive(classroomResponse.data);
    return;
  }
  const parsed = AgentWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }

  const command = parsed.data.command;
  if (command.kind === 'activity') {
    if (command.sessionId === sessionId && command.taskRequestId === activeRequestId) {
      runner?.recordStudentActivity(command.activity);
    }
    return;
  }

  void runCommand(parsed.data.command, parsed.data.requestId)
    .then((result) => {
      sendResult(parsed.data.requestId, result);
    })
    .catch(() => {
      sendResult(parsed.data.requestId, {
        kind: 'failed',
        message: 'The local agent worker could not complete the request.',
      });
    });
});
