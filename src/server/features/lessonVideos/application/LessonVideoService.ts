import { z } from 'zod';
import {
  LessonCommand,
  LessonVideoSchema,
  LessonVideoFailure,
  LessonVideoStatus,
  LessonVideoStage,
  type LessonVideoCommand,
  type LessonVideoReply,
  type LessonVideo,
} from '#contracts/LessonVideos.js';
import { LessonVideoError, isLessonActive, canContinueLesson } from '../domain/LessonVideoRules.js';
import { estimateContentReservation } from './LessonVideoBudget.js';
import type { LessonVideoSettings } from '../../../config/LessonVideoConfig.js';
import type {
  LessonVideoStore,
  LessonSources,
  LessonContentProvider,
  LessonRenderer,
  StoredLesson,
  CreateLessonCommand,
} from './LessonVideoPorts.js';

/** Serialize only public fields. Source snapshots, claims and deployment settings stay on the API. */
export function readLessonView(lesson: StoredLesson): LessonVideo {
  return z
    .object(LessonVideoSchema.shape)
    .parse({ ...lesson, canContinue: canContinueLesson(lesson) });
}

export class LessonVideoService {
  constructor(
    readonly store: LessonVideoStore,
    private readonly sources: LessonSources,
    private readonly content: LessonContentProvider,
    private readonly renderer: LessonRenderer,
    private readonly settings: LessonVideoSettings,
    private readonly newId: () => string,
    private readonly hash: (value: string) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async readOwnedLesson(ownerId: string, id: string): Promise<StoredLesson> {
    const lesson = await this.store.read(id);
    if (!lesson || lesson.ownerId !== ownerId) {
      throw new LessonVideoError(LessonVideoFailure.FORBIDDEN);
    }
    await this.sources.authorize(ownerId, lesson.classId);
    return lesson;
  }
  async execute(ownerId: string, command: LessonVideoCommand): Promise<LessonVideoReply> {
    if (command.kind === LessonCommand.OPTIONS) {
      const classes = await this.sources.list(ownerId);
      const available =
        this.content.available &&
        (await this.renderer.readBuildId().then(
          () => true,
          () => false,
        ));
      return {
        kind: 'options',
        classes,
        available,
        estimatedMicroUsd: Math.ceil(
          6000 * this.settings.budget.inputMicroUsdPerToken +
            2000 * this.settings.budget.outputMicroUsdPerToken,
        ),
        maximumMicroUsd: estimateContentReservation(this.settings),
      };
    }
    if (command.kind === LessonCommand.LIST) {
      const classes = await this.sources.list(ownerId);
      return {
        kind: 'list',
        lessons: (await this.store.list(ownerId))
          .filter((lesson) => classes.some((item) => item.id === lesson.classId))
          .map(readLessonView),
      };
    }
    if (command.kind === LessonCommand.CREATE) {
      return { kind: 'lesson', lesson: readLessonView(await this.create(ownerId, command)) };
    }
    let lesson = await this.readOwnedLesson(ownerId, command.id);
    if (command.kind === LessonCommand.READ) {
      return { kind: 'lesson', lesson: readLessonView(lesson) };
    }
    if (lesson.revision !== command.revision) {
      throw new LessonVideoError(LessonVideoFailure.STALE);
    }
    if (command.kind === LessonCommand.DELETE) {
      await this.store.deleteLesson(lesson);
      return { kind: 'ok' };
    }
    if (command.kind === LessonCommand.CANCEL) {
      lesson = await this.store.saveStageResult({
        ...lesson,
        status: LessonVideoStatus.CANCELLED,
        claimId: null,
      });
      return { kind: 'lesson', lesson: readLessonView(lesson) };
    }
    if (isLessonActive(lesson.status)) {
      throw new LessonVideoError(LessonVideoFailure.STALE);
    }
    if (command.kind === LessonCommand.REGENERATE) {
      // Keep the original lesson/video independently accessible while creating fresh content.
      return { kind: 'lesson', lesson: readLessonView(await this.create(ownerId, command)) };
    }
    const rendererBuild = await this.renderer.readBuildId();
    if (rendererBuild !== lesson.rendererBuild) {
      lesson = {
        ...lesson,
        rendererBuild,
        revision: lesson.revision + 1,
        screens: lesson.screens.map((screen) => ({ ...screen, clipId: null, renderAttempts: 0 })),
        combineAttempts: 0,
      };
    }
    if (command.kind === LessonCommand.EDIT) {
      if (
        command.content.screens.reduce((sum, screen) => sum + screen.narration.length, 0) >
        lesson.settings.speech.characters
      ) {
        throw new LessonVideoError(LessonVideoFailure.INVALID);
      }
      const screens = command.content.screens.map((screen, index) => {
        const previous = lesson.screens[index];
        const sameNarration = previous?.narration === screen.narration;
        const sameVisuals =
          previous?.layout === screen.layout &&
          previous.title === screen.title &&
          JSON.stringify(previous.points) === JSON.stringify(screen.points);
        return {
          ...screen,
          id: previous?.id ?? this.newId(),
          audioId: sameNarration ? previous.audioId : null,
          clipId: sameNarration && sameVisuals ? previous.clipId : null,
          durationSeconds: sameNarration ? previous.durationSeconds : 0,
          silent: !sameNarration || previous.silent,
          speechAttempts: previous?.speechAttempts ?? lesson.settings.speech.attempts,
          renderAttempts: 0,
        };
      });
      lesson = {
        ...lesson,
        title: command.content.title,
        screens,
        revision: lesson.revision + 1,
        combineAttempts: 0,
        error: null,
        status: LessonVideoStatus.QUEUED,
        claimId: null,
        deadline: new Date(this.now().getTime() + lesson.settings.jobs.deadlineMs).toISOString(),
      };
    } else if (command.kind === LessonCommand.CONTINUE) {
      if (!lesson.screens.length) {
        throw new LessonVideoError(LessonVideoFailure.CONTENT);
      }
      lesson = {
        ...lesson,
        status: LessonVideoStatus.QUEUED,
        claimId: null,
        error: null,
        combineAttempts: 0,
        deadline: new Date(this.now().getTime() + lesson.settings.jobs.deadlineMs).toISOString(),
        screens: lesson.screens.map((screen) => ({
          ...screen,
          renderAttempts: screen.clipId ? screen.renderAttempts : 0,
        })),
      };
    } else {
      // No new allowance is silently granted. Edits may use text until a new job is admitted.
      if (
        !lesson.screens.some(
          (screen) => screen.silent && screen.speechAttempts < lesson.settings.speech.attempts,
        )
      ) {
        throw new LessonVideoError(LessonVideoFailure.BUDGET);
      }
      lesson = {
        ...lesson,
        revision: lesson.revision + 1,
        status: LessonVideoStatus.QUEUED,
        claimId: null,
        error: null,
        combineAttempts: 0,
        deadline: new Date(this.now().getTime() + lesson.settings.jobs.deadlineMs).toISOString(),
        screens: lesson.screens.map((screen) =>
          screen.silent && screen.speechAttempts < lesson.settings.speech.attempts
            ? { ...screen, silent: false, clipId: null, renderAttempts: 0 }
            : screen,
        ),
      };
    }
    return { kind: 'lesson', lesson: readLessonView(await this.store.saveStageResult(lesson)) };
  }
  private async create(ownerId: string, command: CreateLessonCommand): Promise<StoredLesson> {
    const requestHash = this.hash(
      JSON.stringify({
        classId: command.classId,
        materialIds: command.materialIds,
        prompt: command.prompt,
        locale: command.locale,
      }),
    );
    const existing = await this.store.findRequest(ownerId, command.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new LessonVideoError(LessonVideoFailure.STALE);
      }
      return this.readOwnedLesson(ownerId, existing.id);
    }
    const sources = await this.sources.read(ownerId, command.classId, command.materialIds);
    const rendererBuild = await this.renderer.readBuildId();
    const counted = await this.content.count({
      prompt: command.prompt,
      sources,
      locale: command.locale,
      settings: this.settings,
    });
    if (counted > this.settings.content.inputTokens) {
      throw new LessonVideoError(LessonVideoFailure.INVALID);
    }
    const timestamp = this.now().toISOString();
    return this.store.createLessonWithReservation({
      id: this.newId(),
      ownerId,
      requestId: command.requestId,
      requestHash,
      recordVersion: 0,
      classId: command.classId,
      title: command.prompt.slice(0, 120),
      prompt: command.prompt,
      locale: command.locale,
      revision: 1,
      status: LessonVideoStatus.QUEUED,
      stage: LessonVideoStage.CONTENT,
      error: null,
      screens: [],
      videoId: null,
      videoRevision: null,
      inputTokens: 0,
      outputTokens: 0,
      reservedMicroUsd: estimateContentReservation(this.settings, counted),
      usageUncertain: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      canContinue: false,
      sources,
      settings: this.settings,
      rendererBuild,
      contentStarted: false,
      contentUsage: null,
      speechCharacters: 0,
      combineAttempts: 0,
      deadline: new Date(this.now().getTime() + this.settings.jobs.deadlineMs).toISOString(),
      claimId: null,
    });
  }
}
