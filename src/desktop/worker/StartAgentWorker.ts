import { z } from 'zod';
import { AgentProgressPhase, AgentProgressSchema } from '#contracts/CompanionHud.js';
import { AgentFailureCode } from '#contracts/AgentSession.js';
import { setDefaultOpenAIClient, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import {
  AgentWorkerRequestSchema,
  AgentWorkerResponseSchema,
  type AgentWorkerCommand,
  type AgentResult,
} from '#contracts/AgentSession.js';
import { ComputerUseTaskRunner } from './ComputerUseTaskRunner.js';
import { createAgentDebugLogger, createLoggedModelFetch } from './AgentDebugLog.js';

const parentPort = process.parentPort;

let runner: ComputerUseTaskRunner | null = null;
let sessionId: string | null = null;
let hasModelCredential = false;
let activeRun: ReturnType<ComputerUseTaskRunner['runTask']> | null = null;
let activeRequestId: string | null = null;
let dailyLimitReached = false;

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

async function runCommand(command: AgentWorkerCommand, requestId: string): Promise<AgentResult> {
  switch (command.kind) {
    case 'follow':
    case 'start': {
      if (runner !== null) {
        return { kind: 'failed', message: 'An agent session is already active.' };
      }

      /* This short-lived token authorizes only Tro's model gateway. The
         product's OpenAI provider key stays on the backend. */
      const log = createAgentDebugLogger(command.debugEnabled);
      if (command.kind === 'start') {
        setDefaultOpenAIClient(
          new OpenAI({
            apiKey: command.gatewayToken,
            baseURL: command.gatewayBaseUrl,
            fetch: async (input, init) => {
              reportThinking();
              const modelFetch = command.debugEnabled ? createLoggedModelFetch(log) : fetch;
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
  const parsed = AgentWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
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
