import { AgentWorkerPolicy } from './agent/AgentWorkerPolicy.js';
import {
  ContextWorkerRequestSchema,
  ContextWorkerResponseSchema,
} from '#contracts/DesktopContext.js';
import type { DesktopContextController } from './context/DesktopContextController.js';
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
  context: TaskContextBinding | null;
}

type TaskActivityContext = Pick<
  DesktopContextController,
  'readScope' | 'pause' | 'resume' | 'execute'
>;

interface TaskContextBinding {
  controller: TaskActivityContext;
  sessionId: string;
  generation: number;
}

const turnTimeoutMs = 120_000;
const startTimeoutMs = AgentWorkerPolicy.STARTUP_TIMEOUT_MS;
const stopTimeoutMs = AgentWorkerPolicy.SHUTDOWN_TIMEOUT_MS;

/** Owns the one local computer-use process for the active chat session. */
export class AgentWorkerClient implements AgentChatWorker {
  private activityContext: TaskActivityContext | null = null;
  private contextTurnSequence = 0;

  setContextController(controller: TaskActivityContext): void {
    this.activityContext = controller;
  }

  private worker: UtilityProcess | null = null;
  private generation = 0;
  private preparing: Promise<void> | null = null;
  private connection: DesktopDriverConnection | null = null;
  private ready = false;
  private stopping: Promise<void> = Promise.resolve();
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

  /** A worker turn may use only the context identity admitted with that turn. */
  private hasCurrentTaskContext(binding: TaskContextBinding): boolean {
    if (this.activityContext !== binding.controller) {
      return false;
    }
    const scope = binding.controller.readScope();
    return (
      scope?.enabled === true &&
      scope.sessionId === binding.sessionId &&
      scope.generation === binding.generation
    );
  }

  prepare(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (this.preparing) {
      return this.preparing;
    }
    const generation = this.generation;
    const startedAt = performance.now();
    const attemptId = randomUUID();
    console.info('agent.worker.starting', { attemptId, generation });
    let timer: NodeJS.Timeout | null = null;
    const operation = this.stopping.then(async () => {
      if (generation !== this.generation) {
        throw new Error('Worker preparation canceled.');
      }
      const result = await this.startWorker({
        kind: 'prepare',
        sessionId: attemptId,
        debugEnabled: this.debugEnabled,
        ...(this.hudGroup ? { hudGroup: this.hudGroup } : {}),
      });
      if (
        result.kind !== 'started' ||
        result.sessionId !== attemptId ||
        generation !== this.generation
      ) {
        throw new Error('Worker preparation failed.');
      }
      this.ready = true;
      console.info('agent.worker.ready', {
        attemptId,
        generation,
        pid: this.worker?.pid,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (generation === this.generation) {
          this.dispose();
        }
        reject(new Error('Worker preparation timed out.'));
      }, startTimeoutMs);
    });
    const preparing = Promise.race([operation, deadline])
      .catch(() => {
        if (generation === this.generation) {
          this.dispose();
        }
        console.warn('agent.worker.start.failed', {
          attemptId,
          generation,
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw new Error('Could not prepare the local agent.');
      })
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
        if (this.preparing === preparing) {
          this.preparing = null;
        }
      });
    this.preparing = preparing;
    return preparing;
  }

  async start(
    sessionId: string,
    gatewayToken: string,
    gatewayBaseUrl: string,
  ): Promise<AgentResult> {
    const generation = this.generation;
    try {
      await this.prepare();
      if (!this.connection || generation !== this.generation) {
        return { kind: 'failed', message: 'The agent session ended.' };
      }
      return await this.send({
        kind: 'start',
        sessionId,
        gatewayToken,
        gatewayBaseUrl,
        desktopDriver: this.connection,
        debugEnabled: this.debugEnabled,
        ...(this.hudGroup ? { hudGroup: this.hudGroup } : {}),
      });
    } catch {
      return { kind: 'failed', message: 'Could not prepare the local agent.' };
    }
  }

  async finish(sessionId: string): Promise<void> {
    this.classroomContext = null;
    const startedAt = performance.now();
    const result = await this.send({ kind: 'finish', sessionId });
    if (result.kind !== 'stopped') {
      this.dispose();
      throw new Error('Agent task cleanup failed.');
    }
    console.info('agent.worker.task.cleaned', {
      sessionId,
      generation: this.generation,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  private async startWorker(
    command: Omit<Extract<AgentWorkerCommand, { kind: 'prepare' }>, 'desktopDriver'>,
  ): Promise<AgentResult> {
    if (this.worker !== null) {
      return { kind: 'failed', message: 'An agent session is already active.' };
    }

    const generation = this.generation;
    let connection: DesktopDriverConnection;
    try {
      connection = await this.desktopDriver.start(this.onDriverExit);
    } catch {
      if (generation === this.generation) {
        this.dispose();
      }
      return { kind: 'failed', message: 'Could not start Tro desktop control.' };
    }

    if (generation !== this.generation) {
      return { kind: 'failed', message: 'The agent session ended.' };
    }

    this.connection = connection;

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
      const contextRequest = ContextWorkerRequestSchema.safeParse(message);
      if (contextRequest.success) {
        const input = contextRequest.data;
        const context = this.pending.get(input.taskRequestId)?.context;
        if (!context || !this.hasCurrentTaskContext(context)) {
          return;
        }
        void context.controller
          .execute(input.command)
          .then((reply) => {
            if (
              this.worker === child &&
              this.pending.get(input.taskRequestId)?.context === context &&
              this.hasCurrentTaskContext(context)
            ) {
              child.postMessage(
                ContextWorkerResponseSchema.parse({
                  kind: 'context-response',
                  requestId: input.requestId,
                  reply,
                }),
              );
            }
          })
          .catch(() => {});
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
        this.generation += 1;
        this.failPending('The local agent worker stopped.');
        this.worker = null;
        this.connection = null;
        this.ready = false;
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
      if (generation === this.generation && this.worker === child) {
        this.dispose();
      }
      return { kind: 'failed', message: 'Could not start the local agent worker.' };
    }

    const result = await this.send({ ...command, desktopDriver: connection });
    if (result.kind !== 'started' && generation === this.generation && this.worker === child) {
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
    const generation = this.generation;
    const contextTurnSequence = ++this.contextTurnSequence;
    const contextController = this.activityContext;
    const admittedScope = contextController?.readScope();
    const sendTurn = (): Promise<AgentResult> => {
      const scope = this.activityContext?.readScope();
      if (
        generation !== this.generation ||
        contextTurnSequence !== this.contextTurnSequence ||
        (admittedScope && contextController !== this.activityContext) ||
        (admittedScope &&
          (scope?.sessionId !== admittedScope.sessionId ||
            scope.generation !== admittedScope.generation))
      ) {
        return Promise.resolve({
          kind: 'failed',
          message: 'The active task or context account changed.',
        });
      }
      return this.send({
        kind: 'turn',
        sessionId,
        message,
        locale,
        mode,
        ...(classroomContext ? { classroomContext } : {}),
        ...(scope ? { activityContext: scope } : {}),
      });
    };
    if (!admittedScope || !contextController) {
      return sendTurn();
    }
    return contextController
      .pause(message)
      .then(sendTurn)
      .finally(() => {
        /* A failed worker may change its generation while the context account
         * stays active. Resume after that worker retires, without delaying the
         * result, and never let an older Ask resume a newer Ask's collector. */
        const retirement = this.stopping;
        void retirement
          .then(() => {
            const scope = this.activityContext?.readScope();
            if (
              contextTurnSequence === this.contextTurnSequence &&
              contextController === this.activityContext &&
              scope?.sessionId === admittedScope.sessionId &&
              scope.generation === admittedScope.generation
            ) {
              return contextController.resume();
            }
            return undefined;
          })
          .catch(() => {
            console.warn('context.collector.failed', { stage: 'resume-after-task' });
          });
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
    const startedAt = performance.now();
    if (this.worker !== null) {
      const result = await this.send({ kind: 'stop', sessionId });
      console.info('agent.worker.stop.cleanup', { sessionId, result: result.kind });
      this.dispose();
    }

    /* Escape closes MCP before cooperative cleanup can finish. A failed cleanup
       reply is recoverable once the old process has actually exited; a kill
       request alone is not confirmation that it can no longer issue commands. */
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.stopping.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    console.info('agent.worker.stop.retired', {
      sessionId,
      exited,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return exited
      ? { kind: 'stopped' }
      : { kind: 'failed', message: 'The local agent is still stopping. Try again.' };
  }

  dispose(): void {
    this.classroomContext = null;
    this.connection = null;
    this.ready = false;
    this.preparing = null;
    this.studentInput?.stop();
    this.generation += 1;
    this.failPending('The agent session ended.');
    const child = this.worker;
    this.worker = null;
    if (child) {
      this.stopping = new Promise<void>((resolve) => {
        child.once('exit', () => {
          console.info('agent.worker.stopped', { generation: this.generation });
          resolve();
        });
      });
      child.kill();
    }
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
      if (command.kind === 'start' || command.kind === 'prepare') {
        timeoutMs = startTimeoutMs;
      } else if (command.kind === 'turn' && command.mode === AgentTaskMode.TEACH) {
        timeoutMs = 0;
      } else if (command.kind === 'stop' || command.kind === 'finish') {
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
        context:
          command.kind === 'turn' && command.activityContext && this.activityContext
            ? {
                controller: this.activityContext,
                sessionId: command.activityContext.sessionId,
                generation: command.activityContext.generation,
              }
            : null,
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
