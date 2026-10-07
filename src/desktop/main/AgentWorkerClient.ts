import type { StudentInputPort } from './input/GlobalStudentInput.js';
import {
  ClassroomToolRequestSchema,
  ClassroomToolResponseSchema,
  ClassroomFailure,
  type TeachingContext,
  type ClassroomToolCommand,
  type ClassroomReply,
} from '#contracts/Classroom.js';
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
import type { DesktopDriverPort } from './DesktopDriverPort.js';
import { AgentProgressSchema, type AgentProgress } from '#contracts/CompanionHud.js';
import type { DesktopDriverConnection } from '#contracts/DesktopDriver.js';

interface PendingRequest {
  resolve(result: AgentResult): void;
  timeout: NodeJS.Timeout | null;
}

const turnTimeoutMs = 120_000;
const startTimeoutMs = 30_000;
const stopTimeoutMs = 10_000;

/** Owns the one local computer-use process for the active chat session. */
export class AgentWorkerClient implements AgentChatWorker {
  private worker: UtilityProcess | null = null;
  private generation = 0;
  private readonly onDriverExit = (): void => {
    this.dispose();
  };
  private readonly pending = new Map<string, PendingRequest>();
  private classroomTool:
    ((command: ClassroomToolCommand, context: TeachingContext) => Promise<ClassroomReply>) | null =
    null;
  private classroomContext: TeachingContext | null = null;

  setClassroomToolHandler(
    handler: (command: ClassroomToolCommand, context: TeachingContext) => Promise<ClassroomReply>,
  ): void {
    this.classroomTool = handler;
  }

  constructor(
    private readonly workerEntryPath: string,
    private readonly debugEnabled: boolean,
    private readonly desktopDriver: DesktopDriverPort,
    private readonly hudGroup?: string,
    private readonly receiveProgress?: (progress: AgentProgress) => void,
    private readonly studentInput?: StudentInputPort,
  ) {}

  isRunning(): boolean {
    return this.worker !== null;
  }

  startCompanion(sessionId: string): Promise<AgentResult> {
    return this.startWorker({
      kind: 'follow',
      sessionId,
      debugEnabled: this.debugEnabled,
      ...(this.hudGroup ? { hudGroup: this.hudGroup } : {}),
    });
  }

  start(sessionId: string, gatewayToken: string, gatewayBaseUrl: string): Promise<AgentResult> {
    return this.startWorker({
      kind: 'start',
      sessionId,
      gatewayToken,
      gatewayBaseUrl,
      debugEnabled: this.debugEnabled,
      ...(this.hudGroup ? { hudGroup: this.hudGroup } : {}),
    });
  }

  private async startWorker(
    command:
      | Omit<Extract<AgentWorkerCommand, { kind: 'start' }>, 'desktopDriver'>
      | Omit<Extract<AgentWorkerCommand, { kind: 'follow' }>, 'desktopDriver'>,
  ): Promise<AgentResult> {
    if (this.worker !== null) {
      return { kind: 'failed', message: 'An agent session is already active.' };
    }

    const generation = this.generation;
    let connection: DesktopDriverConnection;
    try {
      connection = await this.desktopDriver.start(this.onDriverExit);
    } catch {
      this.dispose();
      return { kind: 'failed', message: 'Could not start Tro desktop control.' };
    }

    if (generation !== this.generation) {
      return { kind: 'failed', message: 'The agent session ended.' };
    }

    /* Electron main starts this only after app.whenReady(). The agent and Cua
       MCP client run in the utility child, never in renderer or preload. */
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(this.workerEntryPath, [], {
        serviceName: 'Tro computer-use agent',
      });
    } catch {
      this.dispose();
      return { kind: 'failed', message: 'Could not start the local agent worker.' };
    }
    this.worker = child;
    child.on('message', (message: unknown) => {
      if (this.worker !== child) {
        return;
      }
      const classroomRequest = ClassroomToolRequestSchema.safeParse(message);
      if (classroomRequest.success) {
        const input = classroomRequest.data;
        const context = this.classroomContext;
        const handler = this.classroomTool;
        const response =
          context &&
          context.participation.id === input.participationId &&
          this.pending.has(input.taskRequestId) &&
          handler
            ? handler(input.command, context)
            : Promise.resolve<ClassroomReply>({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
        void response
          .catch((): ClassroomReply => ({ kind: 'failed', code: ClassroomFailure.UNAVAILABLE }))
          .then((reply) => {
            if (this.worker === child && this.pending.has(input.taskRequestId)) {
              try {
                child.postMessage(
                  ClassroomToolResponseSchema.parse({
                    kind: 'classroom-tool-result',
                    requestId: input.requestId,
                    reply,
                  }),
                );
              } catch {
                this.dispose();
              }
            }
          });
        return;
      }
      const progress = AgentProgressSchema.safeParse(message);
      if (progress.success) {
        if (this.pending.has(progress.data.requestId)) {
          this.receiveProgress?.(progress.data);
        }
        return;
      }
      const parsed = AgentWorkerResponseSchema.safeParse(message);
      if (!parsed.success) {
        return;
      }

      const pending = this.pending.get(parsed.data.requestId);
      if (pending) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
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
    if (!ready || generation !== this.generation || this.worker !== child) {
      this.dispose();
      return { kind: 'failed', message: 'Could not start the local agent worker.' };
    }

    const result = await this.send({ ...command, desktopDriver: connection });
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
    classroomContext?: TeachingContext,
  ): Promise<AgentResult> {
    this.classroomContext = classroomContext ?? null;
    return this.send({
      kind: 'turn',
      sessionId,
      message,
      locale,
      mode,
      ...(classroomContext ? { classroomContext } : {}),
    });
  }

  answerLesson(
    sessionId: string,
    lessonId: string,
    message: string,
    locale: DesktopLocale,
  ): Promise<AgentResult> {
    return this.send({ kind: 'answer', sessionId, lessonId, message, locale });
  }

  updateTeachingLocale(sessionId: string, locale: DesktopLocale): Promise<AgentResult> {
    return this.send({ kind: 'locale', sessionId, locale });
  }

  refreshCredential(
    sessionId: string,
    gatewayToken: string,
    gatewayBaseUrl: string,
  ): Promise<AgentResult> {
    return this.send({
      kind: 'credential',
      sessionId,
      gatewayToken,
      gatewayBaseUrl,
      debugEnabled: this.debugEnabled,
    });
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
    this.classroomContext = null;
    this.studentInput?.stop();
    this.generation += 1;
    this.failPending('The agent session ended.');
    this.worker?.kill();
    this.worker = null;
    /* Main owns the shared daemon; HUD transport survives task-worker replacement. */
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
      } else if (command.kind === 'turn' && command.mode === AgentTaskMode.TEACH) {
        timeoutMs = 0;
      } else if (command.kind === 'stop') {
        timeoutMs = stopTimeoutMs;
      }
      const timeout =
        timeoutMs === 0
          ? null
          : setTimeout(() => {
              this.pending.delete(requestId);
              resolve({ kind: 'failed', message: 'The agent request timed out.' });
              this.dispose();
            }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (result) => {
          if (command.kind === 'turn' && command.mode === AgentTaskMode.TEACH) {
            this.studentInput?.stop();
          }
          resolve(result);
        },
        timeout,
      });
      if (command.kind === 'turn' && command.mode === AgentTaskMode.TEACH) {
        void this.studentInput
          ?.start((activity) => {
            if (this.worker === child && this.pending.has(requestId)) {
              try {
                child.postMessage({
                  requestId,
                  command: {
                    kind: 'activity',
                    sessionId: command.sessionId,
                    taskRequestId: requestId,
                    activity,
                  },
                });
              } catch {
                this.studentInput?.stop();
              }
            }
          })
          .catch(() => {
            /* Native input counters still drive observation if position tracking is unavailable. */
          });
      }
      try {
        child.postMessage({ requestId, command });
      } catch {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.pending.delete(requestId);
        resolve({ kind: 'failed', message: 'The local agent worker is unavailable.' });
        this.dispose();
      }
    });
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.resolve({ kind: 'failed', message });
    }
    this.pending.clear();
  }
}
