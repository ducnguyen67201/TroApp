import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AgentChatWorker } from './AgentChatPorts.js';
import {
  AgentWorkerResponseSchema,
  type AgentWorkerCommand,
  type AgentResult,
} from '#contracts/AgentSession.js';

interface PendingRequest {
  resolve(result: AgentResult): void;
  timeout: NodeJS.Timeout;
}

const turnTimeoutMs = 120_000;
const startTimeoutMs = 30_000;
const stopTimeoutMs = 10_000;

/** Owns the one local computer-use process for the active chat session. */
export class AgentWorkerClient implements AgentChatWorker {
  private worker: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly workerEntryPath: string,
    private readonly debugEnabled: boolean,
  ) {}

  isRunning(): boolean {
    return this.worker !== null;
  }

  startCompanion(sessionId: string): Promise<AgentResult> {
    return this.startWorker({ kind: 'follow', sessionId, debugEnabled: this.debugEnabled });
  }

  start(sessionId: string, gatewayToken: string, gatewayBaseUrl: string): Promise<AgentResult> {
    return this.startWorker({
      kind: 'start',
      sessionId,
      gatewayToken,
      gatewayBaseUrl,
      debugEnabled: this.debugEnabled,
    });
  }

  private async startWorker(
    command: Extract<AgentWorkerCommand, { kind: 'start' | 'follow' }>,
  ): Promise<AgentResult> {
    if (this.worker !== null) {
      return { kind: 'failed', message: 'An agent session is already active.' };
    }

    /* Electron main starts this only after app.whenReady(). The agent and Cua
       MCP client run in the utility child, never in renderer or preload. */
    const child = utilityProcess.fork(this.workerEntryPath, [], {
      serviceName: 'Tro computer-use agent',
    });
    this.worker = child;
    child.on('message', (message: unknown) => {
      const parsed = AgentWorkerResponseSchema.safeParse(message);
      if (!parsed.success) {
        return;
      }

      const pending = this.pending.get(parsed.data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(parsed.data.requestId);
        pending.resolve(parsed.data.result);
      }
    });
    child.on('exit', () => {
      if (this.worker === child) {
        this.failPending('The local agent worker stopped.');
        this.worker = null;
      }
    });

    const ready = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => {
        resolve(true);
      });
      child.once('exit', () => {
        resolve(false);
      });
    });
    if (!ready) {
      return { kind: 'failed', message: 'Could not start the local agent worker.' };
    }

    const result = await this.send(command);
    if (result.kind !== 'started') {
      this.dispose();
    }
    return result;
  }

  sendMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<AgentResult> {
    return this.send({ kind: 'turn', sessionId, message, locale, mode });
  }

  async stop(sessionId: string): Promise<AgentResult> {
    if (this.worker === null) {
      return { kind: 'stopped' };
    }

    const result = await this.send({ kind: 'stop', sessionId });
    this.dispose();
    return result;
  }

  dispose(): void {
    this.failPending('The agent session ended.');
    this.worker?.kill();
    this.worker = null;
  }

  private send(command: AgentWorkerCommand): Promise<AgentResult> {
    const child = this.worker;
    if (child === null) {
      return Promise.resolve({ kind: 'failed', message: 'Start an agent session first.' });
    }

    const requestId = randomUUID();
    return new Promise<AgentResult>((resolve) => {
      let timeoutMs = turnTimeoutMs;
      if (command.kind === 'start' || command.kind === 'follow') {
        timeoutMs = startTimeoutMs;
      } else if (command.kind === 'stop') {
        timeoutMs = stopTimeoutMs;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ kind: 'failed', message: 'The agent request timed out.' });
        this.dispose();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timeout });
      try {
        child.postMessage({ requestId, command });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve({ kind: 'failed', message: 'The local agent worker is unavailable.' });
        this.dispose();
      }
    });
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ kind: 'failed', message });
    }
    this.pending.clear();
  }
}
