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
let activeRun: ReturnType<ComputerUseTaskRunner['runTask']> | null = null;
let activeAbort: AbortController | null = null;

/* Screen content and model turns must not enter application traces. */
setTracingDisabled(true);

function sendResult(requestId: string, result: AgentResult): void {
  parentPort.postMessage(AgentWorkerResponseSchema.parse({ requestId, result }));
}

async function runCommand(command: AgentWorkerCommand): Promise<AgentResult> {
  switch (command.kind) {
    case 'start': {
      if (runner !== null) {
        return { kind: 'failed', message: 'An agent session is already active.' };
      }

      /* This short-lived token authorizes only Tro's model gateway. The
         product's OpenAI provider key stays on the backend. */
      const log = createAgentDebugLogger(command.debugEnabled);
      setDefaultOpenAIClient(
        new OpenAI({
          apiKey: command.gatewayToken,
          baseURL: command.gatewayBaseUrl,
          ...(command.debugEnabled ? { fetch: createLoggedModelFetch(log) } : {}),
        }),
      );
      try {
        runner = await ComputerUseTaskRunner.connect(log, command.desktopDriver);
      } catch {
        return {
          kind: 'failed',
          message:
            process.platform === 'darwin'
              ? 'Desktop control could not start. Allow Tro Screen Recording and Accessibility in System Settings, then try again.'
              : 'Desktop control could not start. Restart Tro or reinstall the desktop app, then try again.',
        };
      }
      sessionId = command.sessionId;
      return { kind: 'started', sessionId };
    }
    case 'turn': {
      if (runner === null || sessionId !== command.sessionId) {
        return { kind: 'failed', message: 'Start an agent session first.' };
      }
      if (activeRun !== null) {
        return { kind: 'failed', message: 'Wait for the current task to finish.' };
      }

      activeAbort = new AbortController();
      const run = runner.runTask(command.message, command.locale, activeAbort.signal);
      activeRun = run;
      try {
        return await run;
      } catch {
        return {
          kind: 'failed',
          message: 'Could not complete the task. Check the connection and desktop access.',
        };
      } finally {
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
      return { kind: 'stopped' };
    }
  }
}

parentPort.on('message', (event) => {
  const parsed = AgentWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }

  void runCommand(parsed.data.command)
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
