import {
  PracticeFailure,
  type PracticeCommand,
  type PracticeReply,
} from '#contracts/PracticeCheck.js';
import { randomUUID } from 'node:crypto';
import {
  ClassroomPhase,
  ClassroomStatus,
  ClassroomFailure,
  ClassroomPacing,
  CriterionEvidenceSource,
  type ClassroomCommand,
  type ClassroomReply,
  type TeachingContext,
  type ClassroomToolCommand,
} from '#contracts/Classroom.js';

export interface ClassroomApi {
  execute(command: ClassroomCommand): Promise<ClassroomReply>;
  watch?(context: TeachingContext, signal: AbortSignal, refresh: () => void): Promise<void>;
}

export interface ClassroomTaskContext {
  readTeachingContext(question?: string): Promise<TeachingContext | null>;
  isContextCurrent(context: TeachingContext): boolean;
}

/** Owns one local participation binding. Backend snapshots remain authoritative. */
export class ClassroomSessionController implements ClassroomTaskContext {
  private readonly deviceId = randomUUID();
  private context: TeachingContext | null = null;
  private binding: { participationId: string; activityId: string } | null = null;
  private generation = 0;
  private restorationAttempted = false;
  private restoring: Promise<ClassroomReply> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<ClassroomReply> | null = null;
  private preparation: Extract<ClassroomReply, { kind: 'prepared' }> | null = null;
  private updates: AbortController | null = null;

  constructor(
    private readonly api: ClassroomApi,
    private readonly invalidateTask: () => void,
    private readonly contextChanged: (context: TeachingContext | null) => void = () => {},
  ) {}

  async execute(command: ClassroomCommand): Promise<ClassroomReply> {
    if (command.kind === 'resume') {
      if (this.binding) {
        return this.refresh();
      }
      if (this.restoring) {
        return this.restoring;
      }
      if (this.restorationAttempted) {
        return { kind: 'ok' };
      }
      const generation = this.generation;
      const pending = this.api
        .execute({ ...command, deviceId: this.deviceId, materialSchemaVersion: 2 })
        .then((reply): ClassroomReply => {
          if (generation !== this.generation) {
            return { kind: 'failed', code: ClassroomFailure.STALE };
          }
          if (reply.kind === 'context' || reply.kind === 'ok') {
            this.restorationAttempted = true;
          }
          if (reply.kind === 'context') {
            this.startParticipation(reply.context);
          }
          return reply;
        })
        .finally(() => {
          if (this.restoring === pending) {
            this.restoring = null;
          }
        });
      this.restoring = pending;
      return pending;
    }
    if (command.kind === 'join') {
      const generation = this.generation + 1;
      await this.leave();
      if (generation !== this.generation) {
        return { kind: 'failed', code: ClassroomFailure.STALE };
      }
      const reply = await this.api.execute({
        ...command,
        deviceId: this.deviceId,
        materialSchemaVersion: 2,
      });
      if (generation !== this.generation) {
        return { kind: 'failed', code: ClassroomFailure.STALE };
      }
      if (reply.kind === 'context') {
        this.startParticipation(reply.context);
      }
      return reply;
    }
    if (command.kind === 'leave') {
      await this.leave();
      return { kind: 'ok' };
    }
    if ('participationId' in command) {
      const binding = this.binding;
      if (!binding || binding.participationId !== command.participationId) {
        return { kind: 'failed', code: ClassroomFailure.FORBIDDEN };
      }
      if (
        command.kind === 'context' &&
        this.context?.meeting.pacing === ClassroomPacing.STUDENT &&
        command.activityId !== binding.activityId
      ) {
        // Fence an in-flight heartbeat for the old activity before selecting a new one.
        this.generation += 1;
        this.refreshing = null;
        this.updates?.abort();
        this.updates = null;
        this.context = null;
        this.contextChanged(null);
        this.preparation = null;
        this.binding = { ...binding, activityId: command.activityId };
        this.invalidateTask();
      }
      const generation = this.generation;
      const reply = await this.api.execute({
        ...command,
        deviceId: this.deviceId,
        ...(command.kind === 'context' ? { materialSchemaVersion: 2 as const } : {}),
      });
      if (generation !== this.generation) {
        return { kind: 'failed', code: ClassroomFailure.STALE };
      }
      if (reply.kind === 'context') {
        this.acceptContext(reply.context);
        this.startUpdates();
      }
      if (reply.kind === 'prepared') {
        this.preparation = reply;
      }
      if (reply.kind === 'submitted') {
        this.preparation = null;
      }
      if (reply.kind === 'failed') {
        await this.refresh();
      }
      return reply;
    }
    const reply = await this.api.execute(command);
    if (
      reply.kind === 'ok' &&
      (command.kind === 'update-session' ||
        command.kind === 'end-session' ||
        command.kind === 'revoke' ||
        command.kind === 'delete-class')
    ) {
      await this.refresh();
    }
    return reply;
  }

  /** Renderer requests are fenced to main's current device and participation. */
  async executePractice(
    command: PracticeCommand,
    send: (command: PracticeCommand) => Promise<PracticeReply>,
  ): Promise<PracticeReply> {
    const generation = this.generation;
    if ('participationId' in command) {
      if (
        !this.binding ||
        this.binding.participationId !== command.participationId ||
        this.binding.activityId !== command.activityId
      ) {
        return { kind: 'failed', code: PracticeFailure.FORBIDDEN };
      }
      command = { ...command, deviceId: this.deviceId };
    }
    const result = await send(command);
    return generation === this.generation
      ? result
      : { kind: 'failed', code: PracticeFailure.STALE };
  }

  /** Cached eligibility is checked again at keypress; the backend still authorizes mutations. */
  readPracticeContext(): TeachingContext | null {
    const context = this.context;
    return context &&
      this.isContextCurrent(context) &&
      context.meeting.status === ClassroomStatus.LIVE &&
      context.meeting.phase === ClassroomPhase.PRACTICE &&
      context.activity.practiceCheckpoints?.some((checkpoint) => checkpoint.approved)
      ? context
      : null;
  }

  async readTeachingContext(question?: string): Promise<TeachingContext | null> {
    if (!this.binding) {
      return null;
    }
    const reply = question
      ? await this.execute({
          kind: 'context',
          materialSchemaVersion: 2,
          question: question.slice(0, 1000),
          participationId: this.binding.participationId,
          activityId: this.binding.activityId,
          deviceId: this.deviceId,
        })
      : await this.refresh();
    if (reply.kind !== 'context') {
      throw new Error('Classroom context is unavailable. Rejoin the class before continuing.');
    }
    return reply.context;
  }

  isContextCurrent(context: TeachingContext): boolean {
    return (
      this.context !== null &&
      this.context.participation.id === context.participation.id &&
      this.context.attempt.id === context.attempt.id &&
      this.context.meeting.contextVersion === context.meeting.contextVersion &&
      Date.parse(this.context.participation.leaseUntil) > Date.now()
    );
  }

  readPreparedSubmission(): Extract<ClassroomReply, { kind: 'prepared' }> | null {
    return this.preparation;
  }

  /** Restricted worker operations are bound by main, never by model-supplied IDs. */
  async executeTool(
    command: ClassroomToolCommand,
    taskContext: TeachingContext,
  ): Promise<ClassroomReply> {
    if (!this.isContextCurrent(taskContext)) {
      return { kind: 'failed', code: ClassroomFailure.STALE };
    }
    const reply = await this.refresh();
    if (reply.kind !== 'context' || !this.isContextCurrent(taskContext)) {
      return { kind: 'failed', code: ClassroomFailure.STALE };
    }
    const context = reply.context;
    if (command.kind === 'resume-workspace') {
      return reply;
    }
    const mutation = {
      participationId: context.participation.id,
      deviceId: this.deviceId,
      activityId: context.activity.id,
      contextVersion: context.meeting.contextVersion,
      progressVersion: context.attempt.progressVersion,
    };
    if (command.kind === 'read-material-notes') {
      return this.execute({
        ...command,
        participationId: context.participation.id,
        deviceId: this.deviceId,
        activityId: context.activity.id,
      });
    }
    if (command.kind === 'search-material' || command.kind === 'read-material-source') {
      return this.execute({
        ...command,
        participationId: context.participation.id,
        deviceId: this.deviceId,
        activityId: context.activity.id,
        contextVersion: context.meeting.contextVersion,
      });
    }
    if (command.kind === 'report-progress') {
      return this.execute({
        ...mutation,
        ...command,
        eventId: randomUUID(),
        declaredComplete: context.attempt.declaredComplete,
        evidence: command.evidence.map((item) => ({
          ...item,
          source: CriterionEvidenceSource.MODEL,
        })),
      });
    }
    return this.execute({ ...mutation, ...command });
  }

  async leave(): Promise<void> {
    const binding = this.binding;
    this.dispose();
    this.restorationAttempted = true;
    if (binding) {
      await this.api.execute({
        kind: 'leave',
        participationId: binding.participationId,
        deviceId: this.deviceId,
      });
    }
  }

  dispose(resetRestoration = true): void {
    if (resetRestoration) {
      this.restorationAttempted = false;
    }
    this.restoring = null;
    this.generation += 1;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    this.updates?.abort();
    this.updates = null;
    this.context = null;
    this.contextChanged(null);
    this.binding = null;
    this.preparation = null;
    this.refreshing = null;
    this.invalidateTask();
  }

  private startParticipation(context: TeachingContext): void {
    this.restorationAttempted = true;
    this.acceptContext(context);
    this.timer = setInterval(() => {
      void this.refresh();
    }, 20_000);
    this.timer.unref();
    this.startUpdates();
  }

  private refresh(): Promise<ClassroomReply> {
    if (this.refreshing) {
      return this.refreshing;
    }
    const binding = this.binding;
    if (!binding) {
      return Promise.resolve({ kind: 'failed', code: ClassroomFailure.NOT_FOUND });
    }
    const generation = this.generation;
    const pending = this.api
      .execute({
        kind: 'context',
        materialSchemaVersion: 2,
        participationId: binding.participationId,
        activityId: binding.activityId,
        deviceId: this.deviceId,
      })
      .then((reply): ClassroomReply => {
        if (generation !== this.generation) {
          return { kind: 'failed', code: ClassroomFailure.STALE };
        }
        if (reply.kind === 'context') {
          this.acceptContext(reply.context);
          this.startUpdates();
        } else {
          this.context = null;
          this.contextChanged(null);
          this.invalidateTask();
          if (
            reply.kind === 'failed' &&
            (reply.code === ClassroomFailure.FORBIDDEN ||
              reply.code === ClassroomFailure.STALE ||
              reply.code === ClassroomFailure.NOT_FOUND)
          ) {
            this.dispose(false);
          }
        }
        return reply;
      })
      .finally(() => {
        if (this.refreshing === pending) {
          this.refreshing = null;
        }
      });
    this.refreshing = pending;
    return pending;
  }

  private startUpdates(): void {
    const context = this.context;
    if (!context || this.updates || !this.api.watch) {
      return;
    }
    const updates = new AbortController();
    this.updates = updates;
    void this.api
      .watch(context, updates.signal, () => {
        this.context = null;
        this.contextChanged(null);
        this.preparation = null;
        this.invalidateTask();
        void this.refresh();
      })
      .catch(() => {
        if (!updates.signal.aborted) {
          this.context = null;
          this.contextChanged(null);
          this.invalidateTask();
        }
      })
      .finally(() => {
        if (this.updates === updates) {
          this.updates = null;
        }
        if (!updates.signal.aborted) {
          this.context = null;
          this.contextChanged(null);
          this.invalidateTask();
        }
      });
  }

  private acceptContext(context: TeachingContext): void {
    const previous = this.context;
    if (
      this.preparation &&
      this.preparation.preparation.progressVersion !== context.attempt.progressVersion
    ) {
      this.preparation = null;
    }
    if (
      previous &&
      (previous.meeting.contextVersion !== context.meeting.contextVersion ||
        previous.attempt.id !== context.attempt.id)
    ) {
      this.invalidateTask();
      this.preparation = null;
    }
    this.context = context;
    this.contextChanged(this.readPracticeContext());
    this.binding = { participationId: context.participation.id, activityId: context.activity.id };
  }
}
