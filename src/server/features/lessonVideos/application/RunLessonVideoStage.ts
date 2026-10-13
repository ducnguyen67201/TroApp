import {
  LessonVideoFailure,
  LessonVideoStage,
  LessonVideoStatus,
  LessonArtifactKind,
} from '#contracts/LessonVideos.js';
import {
  lessonRenderVersion,
  lessonVisualRuntimeVersion,
} from '#contracts/LessonRenderProtocol.js';
import {
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '#contracts/LessonVisuals.js';
import { LessonVideoError } from '../domain/LessonVideoRules.js';
import { readLessonRenderAttemptLimit } from '../domain/LessonRenderRecovery.js';
import { RunLessonContent } from './RunLessonContent.js';
import type { RunLessonVisual } from './RunLessonVisual.js';
import { LessonRenderCodeError } from './LessonVideoPorts.js';
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
  private readonly contentStage: RunLessonContent;

  constructor(
    private readonly store: LessonVideoStore,
    content: LessonContentProvider,
    private readonly speech: LessonSpeechProvider,
    private readonly renderer: LessonRenderer,
    private readonly newId: () => string,
    private readonly report: LessonDiagnostics,
    private readonly hash: (text: string) => string,
    private readonly visuals?: RunLessonVisual,
  ) {
    this.contentStage = new RunLessonContent(store, content, newId, hash, report);
  }
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
        return await this.contentStage.execute(lesson, signal);
      }
      if ((await this.renderer.readBuildId()) !== lesson.rendererBuild) {
        throw new LessonVideoError(LessonVideoFailure.RENDER);
      }
      const renderAttemptLimit = readLessonRenderAttemptLimit(lesson);
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
        if (screen.visual?.status === LessonVisualStatus.PENDING) {
          if (this.visuals) {
            return await this.visuals.execute(lesson, screen.id, durationSeconds, signal);
          }
          return await save({
            ...lesson,
            screens: lesson.screens.map((item) =>
              item.id === screen.id
                ? {
                    ...item,
                    visual: {
                      treatment: LessonVisualTreatment.BASELINE,
                      status: LessonVisualStatus.DEGRADED,
                      degradationReason: LessonVisualDegradation.DISABLED,
                    },
                  }
                : item,
            ),
          });
        }
        const visual = lesson.visuals.find((item) => item.screenId === screen.id);
        const custom =
          screen.visual?.treatment === LessonVisualTreatment.CUSTOM &&
          screen.visual.status === LessonVisualStatus.SOURCE_SAVED;
        if (custom && renderAttemptLimit - screen.renderAttempts <= 1 && this.visuals) {
          // A crash may have consumed executions without a receipt. Keep the final slot for baseline.
          return await this.visuals.degrade(lesson, screen.id, LessonVisualDegradation.ATTEMPTS);
        }
        const sourceArtifact =
          custom && visual?.sourceId
            ? await this.store.readArtifact(lesson.id, visual.sourceId)
            : null;
        const source = sourceArtifact ? new TextDecoder().decode(sourceArtifact.bytes) : null;
        if (
          custom &&
          (!source ||
            !visual?.sourceComplete ||
            sourceArtifact?.kind !== LessonArtifactKind.SOURCE ||
            this.hash(source) !== visual.sourceDigest)
        ) {
          if (this.visuals) {
            return await this.visuals.degrade(
              lesson,
              screen.id,
              LessonVisualDegradation.INVALID_SOURCE,
            );
          }
          throw new LessonVideoError(LessonVideoFailure.RENDER);
        }
        if (screen.renderAttempts >= renderAttemptLimit) {
          throw new LessonVideoError(LessonVideoFailure.RENDER);
        }
        // Custom source gets one execution attempt, leaving room for a focused repair and baseline.
        const attempts = custom
          ? 1
          : Math.min(lesson.settings.render.attempts, renderAttemptLimit - screen.renderAttempts);
        await save({
          ...lesson,
          stage: LessonVideoStage.CLIP,
          screens: lesson.screens.map((item) =>
            item.id === screen.id
              ? {
                  ...item,
                  renderAttempts: item.renderAttempts + attempts,
                }
              : item,
          ),
        });
        let bytes: Uint8Array;
        try {
          bytes = await this.renderer.render(
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
              ...(custom && source
                ? { visual: { source, runtimeVersion: lessonVisualRuntimeVersion } }
                : {}),
            },
            lesson.settings.render.timeoutMs,
            signal,
            attempts,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (custom && error instanceof LessonRenderCodeError && this.visuals) {
            // Source remains saved. The next visual step may spend only its remaining slot.
            return await save({
              ...lesson,
              visuals: lesson.visuals.map((item) =>
                item.screenId === screen.id
                  ? {
                      ...item,
                      diagnostic: error.diagnostic.slice(
                        0,
                        lesson.settings.visual.maxDiagnosticCharacters,
                      ),
                    }
                  : item,
              ),
              screens: lesson.screens.map((item) =>
                item.id === screen.id && item.visual
                  ? {
                      ...item,
                      visual: { ...item.visual, status: LessonVisualStatus.PENDING },
                    }
                  : item,
              ),
            });
          }
          throw error;
        }
        const id = this.newId();
        return await this.store.saveStageResult(
          {
            ...lesson,
            screens: lesson.screens.map((item) =>
              item.id === screen.id
                ? {
                    ...item,
                    durationSeconds,
                    clipId: id,
                    ...(custom && item.visual
                      ? { visual: { ...item.visual, status: LessonVisualStatus.READY } }
                      : {}),
                  }
                : item,
            ),
          },
          { id, lessonId: lesson.id, kind: LessonArtifactKind.CLIP, bytes },
        );
      }
      if (lesson.combineAttempts >= renderAttemptLimit) {
        throw new LessonVideoError(LessonVideoFailure.RENDER);
      }
      const attempts = Math.min(
        lesson.settings.render.attempts,
        renderAttemptLimit - lesson.combineAttempts,
      );
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
