import {
  LessonVideoFailure,
  LessonVideoStage,
  LessonVideoStatus,
  LessonArtifactKind,
} from '#contracts/LessonVideos.js';
import { lessonRenderVersion } from '#contracts/LessonRenderProtocol.js';
import { LessonVideoError } from '../domain/LessonVideoRules.js';
import type {
  LessonVideoStore,
  LessonContentProvider,
  LessonSpeechProvider,
  LessonRenderer,
  StoredLesson,
  LessonDiagnostics,
} from './LessonVideoPorts.js';

/** A stage saves its attempt before I/O, then atomically saves the artifact and its reference. */
export class RunLessonVideoStage {
  constructor(
    private readonly store: LessonVideoStore,
    private readonly content: LessonContentProvider,
    private readonly speech: LessonSpeechProvider,
    private readonly renderer: LessonRenderer,
    private readonly newId: () => string,
    private readonly report: LessonDiagnostics,
  ) {}
  async execute(initial: StoredLesson, signal: AbortSignal): Promise<StoredLesson> {
    let lesson = initial;
    const startedAt = Date.now();
    const save = async (next: StoredLesson): Promise<StoredLesson> => {
      lesson = await this.store.saveStageResult(next);
      return lesson;
    };
    try {
      signal.throwIfAborted();
      if (Date.parse(lesson.deadline) <= Date.now()) {
        throw new LessonVideoError(LessonVideoFailure.DEADLINE);
      }
      if (!lesson.screens.length) {
        // A crash cannot reveal how many SDK attempts were billed: never replay this reservation.
        if (lesson.contentStarted) {
          throw new LessonVideoError(LessonVideoFailure.CONTENT);
        }
        await save({
          ...lesson,
          stage: LessonVideoStage.CONTENT,
          contentStarted: true,
          usageUncertain: true,
        });
        this.report({
          lessonId: lesson.id,
          revision: lesson.revision,
          stage: lesson.stage,
          state: 'started',
        });
        const result = await this.content.generate(lesson, signal);
        const screens = result.content.screens.map((screen) => ({
          ...screen,
          id: this.newId(),
          audioId: null,
          clipId: null,
          durationSeconds: 0,
          silent: false,
          speechAttempts: 0,
          renderAttempts: 0,
        }));
        await save({
          ...lesson,
          title: result.content.title,
          screens,
          contentUsage: result.usage,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          usageUncertain: lesson.settings.content.attempts > 1,
          stage: LessonVideoStage.SPEECH,
        });
        this.report({
          lessonId: lesson.id,
          revision: lesson.revision,
          stage: LessonVideoStage.CONTENT,
          state: 'saved',
          requestId: result.usage.requestId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
        return lesson;
      }
      if ((await this.renderer.readBuildId()) !== lesson.rendererBuild) {
        throw new LessonVideoError(LessonVideoFailure.RENDER);
      }
      const screen = lesson.screens.find((item) => !item.clipId);
      if (screen) {
        if (!screen.audioId && !screen.silent) {
          if (
            screen.speechAttempts >= lesson.settings.speech.attempts ||
            lesson.speechCharacters + screen.narration.length >
              lesson.settings.speech.characters * lesson.settings.speech.attempts
          ) {
            return await save({
              ...lesson,
              screens: lesson.screens.map((item) =>
                item.id === screen.id ? { ...item, silent: true } : item,
              ),
            });
          }
          await save({
            ...lesson,
            stage: LessonVideoStage.SPEECH,
            speechCharacters: lesson.speechCharacters + screen.narration.length,
            screens: lesson.screens.map((item) =>
              item.id === screen.id ? { ...item, speechAttempts: item.speechAttempts + 1 } : item,
            ),
          });
          const audio = await this.speech
            .synthesize(screen.narration, lesson.settings, signal)
            .catch(() => null);
          signal.throwIfAborted();
          if (!audio) {
            this.report({
              lessonId: lesson.id,
              revision: lesson.revision,
              stage: lesson.stage,
              state: 'speech-unavailable',
            });
            // Speech failure can degrade to text; a database failure must stop at its checkpoint.
            return await save({
              ...lesson,
              screens: lesson.screens.map((item) =>
                item.id === screen.id ? { ...item, silent: true } : item,
              ),
            });
          }
          const artifactId = this.newId();
          return await this.store.saveStageResult(
            {
              ...lesson,
              screens: lesson.screens.map((item) =>
                item.id === screen.id
                  ? { ...item, audioId: artifactId, durationSeconds: audio.durationSeconds + 0.5 }
                  : item,
              ),
            },
            {
              id: artifactId,
              lessonId: lesson.id,
              kind: LessonArtifactKind.AUDIO,
              bytes: audio.bytes,
            },
          );
        }
        if (screen.renderAttempts >= lesson.settings.render.attempts) {
          throw new LessonVideoError(LessonVideoFailure.RENDER);
        }
        const attempts = lesson.settings.render.attempts - screen.renderAttempts;
        await save({
          ...lesson,
          stage: LessonVideoStage.CLIP,
          screens: lesson.screens.map((item) =>
            item.id === screen.id
              ? { ...item, renderAttempts: item.renderAttempts + attempts }
              : item,
          ),
        });
        const audio = screen.audioId
          ? await this.store.readArtifact(lesson.id, screen.audioId)
          : null;
        if (screen.audioId && !audio) {
          throw new LessonVideoError(LessonVideoFailure.RENDER);
        }
        const durationSeconds = audio
          ? screen.durationSeconds
          : Math.max(
              lesson.settings.presentation.minimumSeconds,
              Math.ceil(screen.narration.length / lesson.settings.presentation.charactersPerSecond),
            );
        const bytes = await this.renderer.render(
          {
            kind: 'clip',
            version: lessonRenderVersion,
            screen: {
              layout: screen.layout,
              title: screen.title,
              points: screen.points,
              narration: screen.narration,
            },
            durationSeconds,
            audio: audio ? Buffer.from(audio.bytes).toString('base64') : null,
          },
          lesson.settings.render.timeoutMs,
          signal,
          attempts,
        );
        const id = this.newId();
        return await this.store.saveStageResult(
          {
            ...lesson,
            screens: lesson.screens.map((item) =>
              item.id === screen.id ? { ...item, durationSeconds, clipId: id } : item,
            ),
          },
          { id, lessonId: lesson.id, kind: LessonArtifactKind.CLIP, bytes },
        );
      }
      if (lesson.combineAttempts >= lesson.settings.render.attempts) {
        throw new LessonVideoError(LessonVideoFailure.RENDER);
      }
      const attempts = lesson.settings.render.attempts - lesson.combineAttempts;
      await save({
        ...lesson,
        stage: LessonVideoStage.COMBINE,
        combineAttempts: lesson.combineAttempts + attempts,
      });
      const clips: string[] = [];
      for (const item of lesson.screens) {
        const artifact = item.clipId ? await this.store.readArtifact(lesson.id, item.clipId) : null;
        if (!artifact) {
          throw new LessonVideoError(LessonVideoFailure.RENDER);
        }
        clips.push(Buffer.from(artifact.bytes).toString('base64'));
      }
      const bytes = await this.renderer.render(
        { kind: 'combine', version: lessonRenderVersion, clips },
        lesson.settings.render.timeoutMs,
        signal,
        attempts,
      );
      const id = this.newId();
      return await this.store.saveStageResult(
        {
          ...lesson,
          videoId: id,
          videoRevision: lesson.revision,
          status: LessonVideoStatus.READY,
          error: null,
          claimId: null,
        },
        { id, lessonId: lesson.id, kind: LessonArtifactKind.VIDEO, bytes },
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof LessonVideoError && error.code === LessonVideoFailure.STALE) {
        throw error;
      }
      const code =
        error instanceof LessonVideoError
          ? error.code
          : lesson.stage === LessonVideoStage.CONTENT
            ? LessonVideoFailure.CONTENT
            : LessonVideoFailure.RENDER;
      this.report({
        lessonId: lesson.id,
        revision: lesson.revision,
        stage: lesson.stage,
        state: code,
        elapsedMs: Date.now() - startedAt,
      });
      return await save({
        ...lesson,
        status: LessonVideoStatus.STOPPED,
        error: code,
        claimId: null,
      });
    }
  }
}
