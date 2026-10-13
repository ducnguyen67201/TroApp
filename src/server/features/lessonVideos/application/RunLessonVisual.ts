import {
  LessonArtifactKind,
  LessonVideoStage,
  type LessonScreen,
} from '#contracts/LessonVideos.js';
import {
  LessonModelAttemptState,
  LessonModelRole,
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '#contracts/LessonVisuals.js';
import {
  lessonVisualRuntimeVersion,
  LessonVisualRenderLimits,
} from '#contracts/LessonRenderProtocol.js';
import { canReuseLessonVisual } from '../domain/LessonVisualRules.js';
import {
  LessonVisualResultKind,
  LessonModelRequestError,
  type LessonDiagnostics,
  type LessonRenderer,
  type LessonVideoStore,
  type LessonVisualProvider,
  type LessonVisualRequest,
  type LessonVisualResult,
  type StoredLesson,
} from './LessonVideoPorts.js';

/** One optional model dispatch per execution. Saved attempts also cover transport failures and repair. */
export class RunLessonVisual {
  constructor(
    private readonly store: LessonVideoStore,
    private readonly provider: LessonVisualProvider,
    private readonly renderer: LessonRenderer,
    private readonly newId: () => string,
    private readonly hash: (text: string) => string,
    private readonly report: LessonDiagnostics,
    private readonly now: () => number = Date.now,
  ) {}

  async degrade(
    lesson: StoredLesson,
    screenId: string,
    reason: LessonVisualDegradation,
  ): Promise<StoredLesson> {
    const saved = await this.store.saveStageResult({
      ...lesson,
      screens: lesson.screens.map((screen) =>
        screen.id === screenId
          ? {
              ...screen,
              visual: {
                treatment: LessonVisualTreatment.BASELINE,
                status: LessonVisualStatus.DEGRADED,
                degradationReason: reason,
              },
            }
          : screen,
      ),
    });
    this.report({
      lessonId: lesson.id,
      revision: lesson.revision,
      stage: LessonVideoStage.VISUAL,
      state: 'degraded',
      screenId,
      reason,
    });
    return saved;
  }

  async execute(
    initial: StoredLesson,
    screenId: string,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<StoredLesson> {
    let lesson = initial;
    signal.throwIfAborted();
    const visual = lesson.visuals.find((item) => item.screenId === screenId);
    const screen = lesson.screens.find((item) => item.id === screenId);
    if (!visual || !screen || screen.visual?.status === LessonVisualStatus.DEGRADED) {
      return lesson;
    }
    const policy = lesson.settings.visual;
    if (!policy.enabled) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.DISABLED);
    }
    if (durationSeconds > LessonVisualRenderLimits.DURATION_SECONDS) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.UNSUPPORTED);
    }
    if (Date.parse(lesson.deadline) - this.now() < policy.timeoutMs + policy.minimumRemainingMs) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.DEADLINE);
    }
    let runtime: string | null;
    try {
      runtime = (await this.renderer.readVisualRuntime?.()) ?? null;
    } catch {
      signal.throwIfAborted();
      return this.degrade(lesson, screenId, LessonVisualDegradation.UNAVAILABLE);
    }
    if (runtime !== lessonVisualRuntimeVersion) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.UNSUPPORTED);
    }
    const inputDigest = this.hash(
      JSON.stringify({
        screen: readVisualContent(screen),
        brief: visual.brief,
        durationSeconds,
        locale: lesson.locale,
        rendererBuild: lesson.rendererBuild,
        runtime,
        model: policy.model,
      }),
    );
    if (canReuseLessonVisual(visual, inputDigest)) {
      return lesson;
    }
    const attempts = lesson.modelAttempts.filter(
      (item) => item.role === LessonModelRole.VISUAL && item.screenId === screenId,
    );
    const interrupted = attempts.find((item) => item.state === LessonModelAttemptState.DISPATCHED);
    if (interrupted) {
      // The provider may have billed it. Consume this saved slot without replaying it.
      return this.store.saveModelAttemptResult(lesson, interrupted.id, {
        state: LessonModelAttemptState.UNAVAILABLE,
        usage: null,
        usageUncertain: true,
      });
    }
    if (attempts.length >= policy.attempts) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.ATTEMPTS);
    }
    const source = visual.sourceId
      ? await this.store.readArtifact(lesson.id, visual.sourceId)
      : null;
    const savedSource = source ? new TextDecoder().decode(source.bytes) : null;
    if (
      visual.sourceId &&
      (!savedSource ||
        source?.kind !== LessonArtifactKind.SOURCE ||
        savedSource.length > policy.maxSourceCharacters ||
        this.hash(savedSource) !== visual.sourceDigest)
    ) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.INVALID_SOURCE);
    }
    const request: LessonVisualRequest = {
      screen: readVisualContent(screen),
      brief: visual.brief,
      durationSeconds,
      locale: lesson.locale,
      settings: lesson.settings,
      ...(savedSource
        ? {
            source: savedSource,
            diagnostic:
              visual.diagnostic ?? 'Complete the saved animation using the fixed scene API.',
          }
        : {}),
    };
    let inputTokens: number;
    try {
      inputTokens = await this.provider.countRequest(request);
    } catch {
      signal.throwIfAborted();
      return this.degrade(lesson, screenId, LessonVisualDegradation.UNAVAILABLE);
    }
    signal.throwIfAborted();
    if (inputTokens > policy.inputTokens || inputTokens < 1 || !Number.isInteger(inputTokens)) {
      return this.degrade(lesson, screenId, LessonVisualDegradation.INPUT_LIMIT);
    }
    const id = this.newId();
    lesson = await this.store.beginModelAttempt(
      { ...lesson, stage: LessonVideoStage.VISUAL },
      {
        id,
        role: LessonModelRole.VISUAL,
        screenId,
        ordinal: attempts.length + 1,
        requestDigest: this.hash(JSON.stringify(request)),
        inputTokenLimit: inputTokens,
        outputTokenLimit: policy.outputTokens,
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
      screenId,
      attempt: attempts.length + 1,
    });
    let result: LessonVisualResult;
    try {
      result = await this.provider.generateVisual(request, signal);
    } catch (error) {
      signal.throwIfAborted();
      lesson = await this.store.saveModelAttemptResult(lesson, id, {
        state:
          error instanceof LessonModelRequestError
            ? error.outcome
            : LessonModelAttemptState.UNAVAILABLE,
        usage: error instanceof LessonModelRequestError ? error.usage : null,
        usageUncertain: error instanceof LessonModelRequestError ? error.usageUncertain : true,
      });
      return lesson;
    }
    signal.throwIfAborted();
    const generated =
      result.kind === LessonVisualResultKind.UNAVAILABLE ? undefined : result.source;
    const complete =
      result.kind === LessonVisualResultKind.SOURCE &&
      generated !== undefined &&
      generated.length > 0 &&
      generated.length <= policy.maxSourceCharacters;
    const generatedSource = generated?.slice(0, policy.maxSourceCharacters);
    const sourceId = generatedSource ? this.newId() : null;
    lesson = await this.store.saveModelAttemptResult(
      {
        ...lesson,
        visuals: lesson.visuals.map((item) =>
          item.screenId === screenId
            ? {
                ...item,
                sourceId: sourceId ?? item.sourceId,
                sourceDigest: generatedSource ? this.hash(generatedSource) : item.sourceDigest,
                inputDigest,
                sourceComplete: complete,
                diagnostic: complete
                  ? null
                  : 'The response did not contain a complete animation. Finish the saved source.',
              }
            : item,
        ),
        screens: lesson.screens.map((item) =>
          item.id === screenId
            ? {
                ...item,
                visual: {
                  treatment: LessonVisualTreatment.CUSTOM,
                  status: complete ? LessonVisualStatus.SOURCE_SAVED : LessonVisualStatus.PENDING,
                  degradationReason: null,
                },
              }
            : item,
        ),
      },
      id,
      {
        state: complete
          ? LessonModelAttemptState.COMPLETED
          : result.kind === LessonVisualResultKind.UNAVAILABLE
            ? LessonModelAttemptState.UNAVAILABLE
            : LessonModelAttemptState.INCOMPLETE,
        usage: result.usage,
        usageUncertain: result.usage === null,
      },
      sourceId && generatedSource
        ? {
            id: sourceId,
            lessonId: lesson.id,
            kind: LessonArtifactKind.SOURCE,
            bytes: new TextEncoder().encode(generatedSource),
          }
        : undefined,
    );
    this.report({
      lessonId: lesson.id,
      revision: lesson.revision,
      stage: lesson.stage,
      state: complete ? 'source-saved' : 'incomplete',
      screenId,
      attempt: attempts.length + 1,
      ...(result.usage
        ? {
            requestId: result.usage.requestId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          }
        : {}),
    });
    return lesson;
  }
}

function readVisualContent(screen: LessonScreen): LessonScreen {
  return {
    layout: screen.layout,
    title: screen.title,
    points: screen.points,
    narration: screen.narration,
  };
}
