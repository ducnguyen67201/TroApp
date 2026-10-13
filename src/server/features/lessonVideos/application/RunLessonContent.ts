import { LessonVideoFailure, LessonVideoStage } from '#contracts/LessonVideos.js';
import {
  LessonModelAttemptState,
  LessonModelRole,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '#contracts/LessonVisuals.js';
import { LessonVideoError } from '../domain/LessonVideoRules.js';
import { selectLessonVisualBriefs } from '../domain/LessonVisualRules.js';
import {
  LessonModelRequestError,
  type LessonContentProvider,
  type LessonDiagnostics,
  type LessonVideoStore,
  type StoredLesson,
} from './LessonVideoPorts.js';

/** Save complete content once; retries consume the original lesson's durable dispatch ledger. */
export class RunLessonContent {
  constructor(
    private readonly store: LessonVideoStore,
    private readonly provider: LessonContentProvider,
    private readonly newId: () => string,
    private readonly hash: (text: string) => string,
    private readonly report: LessonDiagnostics,
  ) {}

  async execute(initial: StoredLesson, signal: AbortSignal): Promise<StoredLesson> {
    let lesson = initial;
    const attempts = lesson.modelAttempts.filter((item) => item.role === LessonModelRole.CONTENT);
    // Older jobs did not persist SDK dispatches. Their unknown reservation cannot be replayed.
    if (lesson.contentStarted && !attempts.length) {
      throw new LessonVideoError(LessonVideoFailure.CONTENT);
    }
    const interrupted = attempts.find((item) => item.state === LessonModelAttemptState.DISPATCHED);
    if (interrupted) {
      return this.store.saveModelAttemptResult(lesson, interrupted.id, {
        state: LessonModelAttemptState.UNAVAILABLE,
        usage: null,
        usageUncertain: true,
      });
    }
    if (attempts.length >= lesson.settings.content.attempts) {
      throw new LessonVideoError(LessonVideoFailure.CONTENT);
    }
    const counted = await this.provider.count(lesson);
    signal.throwIfAborted();
    if (
      !Number.isInteger(counted) ||
      counted < 1 ||
      counted > lesson.settings.content.inputTokens
    ) {
      throw new LessonVideoError(LessonVideoFailure.CONTENT);
    }
    const id = this.newId();
    lesson = await this.store.beginModelAttempt(
      {
        ...lesson,
        contentStarted: true,
        stage: LessonVideoStage.CONTENT,
      },
      {
        id,
        role: LessonModelRole.CONTENT,
        screenId: null,
        ordinal: attempts.length + 1,
        requestDigest: this.hash(
          JSON.stringify({
            prompt: lesson.prompt,
            sources: lesson.sources,
            locale: lesson.locale,
            settings: lesson.settings.content,
            visual: lesson.settings.visual,
          }),
        ),
        inputTokenLimit: counted,
        outputTokenLimit: lesson.settings.content.outputTokens,
        state: LessonModelAttemptState.DISPATCHED,
        usage: null,
        usageUncertain: true,
      },
    );
    this.report({
      lessonId: lesson.id,
      revision: lesson.revision,
      stage: lesson.stage,
      state: 'started',
      attempt: attempts.length + 1,
    });
    let result: Awaited<ReturnType<LessonContentProvider['generate']>>;
    try {
      result = await this.provider.generate(lesson, signal);
    } catch (error) {
      signal.throwIfAborted();
      return this.store.saveModelAttemptResult(lesson, id, {
        state:
          error instanceof LessonModelRequestError
            ? error.outcome
            : LessonModelAttemptState.UNAVAILABLE,
        usage: error instanceof LessonModelRequestError ? error.usage : null,
        usageUncertain: error instanceof LessonModelRequestError ? error.usageUncertain : true,
      });
    }
    signal.throwIfAborted();
    const selected = selectLessonVisualBriefs(
      result.briefs ?? [],
      result.content.screens.length,
      lesson.settings.visual.enabled ? lesson.settings.visual.maxScenes : 0,
    );
    const screens = result.content.screens.map((screen, position) => ({
      ...screen,
      id: this.newId(),
      audioId: null,
      clipId: null,
      durationSeconds: 0,
      silent: false,
      speechAttempts: 0,
      renderAttempts: 0,
      ...(selected.some((brief) => brief.position === position)
        ? {
            visual: {
              treatment: LessonVisualTreatment.CUSTOM,
              status: LessonVisualStatus.PENDING,
              degradationReason: null,
            },
          }
        : {}),
    }));
    const visuals = selected.flatMap((brief) => {
      const screen = screens[brief.position];
      return screen
        ? [
            {
              screenId: screen.id,
              brief,
              sourceId: null,
              sourceDigest: null,
              inputDigest: null,
              sourceComplete: false,
              diagnostic: null,
            },
          ]
        : [];
    });
    const saved = await this.store.saveModelAttemptResult(
      {
        ...lesson,
        title: result.content.title,
        screens,
        visuals,
        contentUsage: result.usage,
        stage: LessonVideoStage.SPEECH,
      },
      id,
      { state: LessonModelAttemptState.COMPLETED, usage: result.usage, usageUncertain: false },
    );
    this.report({
      lessonId: lesson.id,
      revision: lesson.revision,
      stage: LessonVideoStage.CONTENT,
      state: 'saved',
      requestId: result.usage.requestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    return saved;
  }
}
