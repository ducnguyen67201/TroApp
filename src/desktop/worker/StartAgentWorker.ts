import { z } from 'zod';
import { ClassroomToolResponseSchema } from '#contracts/Classroom.js';
import { ClassroomToolClient } from './teaching/ClassroomToolClient.js';
import { AgentProgressPhase, AgentProgressSchema } from '#contracts/CompanionHud.js';
import { TeachingLessonPhase } from '#contracts/DesktopObservation.js';
import { AgentFailureCode } from '#contracts/AgentSession.js';
import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
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
let hasModelCredential = false;
let activeRun: ReturnType<ComputerUseTaskRunner['runTask']> | null = null;
let activeRequestId: string | null = null;
let dailyLimitReached = false;
let classroomTools: ClassroomToolClient | null = null;

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

function configureModelCredential(
  gatewayToken: string,
  gatewayBaseUrl: string,
  debugEnabled: boolean,
): void {
  const log = createAgentDebugLogger(debugEnabled);
  const modelFetch = createLoggedModelFetch(log);
  setDefaultOpenAIClient(
    new OpenAI({
      apiKey: gatewayToken,
      baseURL: gatewayBaseUrl,
      maxRetries: 0,
      fetch: async (input, init) => {
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
      },
    }),
  );
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
      configureModelCredential(command.gatewayToken, command.gatewayBaseUrl, command.debugEnabled);
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
    case 'follow':
    case 'start': {
      if (runner !== null) {
        return { kind: 'failed', message: 'An agent session is already active.' };
      }

      /* This short-lived token authorizes only Tro's model gateway. The
         product's OpenAI provider key stays on the backend. */
      const log = createAgentDebugLogger(command.debugEnabled);
      if (command.kind === 'start') {
        configureModelCredential(
          command.gatewayToken,
          command.gatewayBaseUrl,
          command.debugEnabled,
        );
      }
      try {
        runner = await ComputerUseTaskRunner.connect(
          log,
          command.desktopDriver,
          command.kind === 'follow',
          command.hudGroup,
        );
      } catch {
        return {
          kind: 'failed',
          message:
            process.platform === 'darwin'
              ? 'Desktop control could not start. Allow Tro Screen Recording and Accessibility in System Settings, then try again.'
              : 'Desktop control could not start. Restart Tro or reinstall the desktop app, then try again.',
        };
      }
      hasModelCredential = command.kind === 'start';
      sessionId = command.sessionId;
      return { kind: 'started', sessionId };
    }
    case 'turn': {
      if (runner === null || sessionId !== command.sessionId || !hasModelCredential) {
        return { kind: 'failed', message: 'Start an agent session first.' };
      }
      if (activeRun !== null) {
        return { kind: 'failed', message: 'Wait for the current task to finish.' };
      }

      activeRequestId = requestId;
      dailyLimitReached = false;
      activeAbort = new AbortController();
      const context = command.classroomContext;
      const toolClient = context
        ? new ClassroomToolClient(
            (message) => {
              parentPort.postMessage(message);
            },
            requestId,
            context.participation.id,
            activeAbort.signal,
          )
        : null;
      classroomTools = toolClient;
      const run = runner.runTask(
        command.message,
        command.locale,
        activeAbort.signal,
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
      );
      activeRun = run;
      try {
        return await run;
      } catch {
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
      hasModelCredential = false;
      return { kind: 'stopped' };
    }
  }
}

parentPort.on('message', (event) => {
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
