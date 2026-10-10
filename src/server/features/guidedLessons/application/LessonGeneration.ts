import { createHash, randomUUID } from 'node:crypto';
import {
  LessonStatus,
  LessonPhase,
  ReviewSeverity,
  ReviewVerdict,
  ReviewCriterion,
  ReviewCheckStatus,
  LessonEvidenceKind,
  AuthorResultSchema,
  RepairResultSchema,
  ReviewResultSchema,
  VisualRepairResultSchema,
  RenderManifestSchema,
  SpeechArtifactSchema,
  type LessonPlan,
  type ReviewResult,
} from '#contracts/GuidedLessons.js';
import type { GuidedLessonStore, StoredLessonArtifact } from './GuidedLessonStore.js';
import type { LessonRecord } from './LessonState.js';
import { LessonProviderUsageSchema, LessonReservationState } from './LessonState.js';
import {
  LessonModelStage,
  LessonProviderNotDispatchedError,
  type LessonModel,
  type LessonSpeech,
  type LessonRenderer,
  type LessonModelRequest,
  type LessonMediaArtifact,
} from './LessonPorts.js';
import { LessonError, LessonFailure } from './LessonFailure.js';
import {
  LessonPolicy,
  StageAllowance,
  reserveLessonAttempt,
  settleLessonAttempt,
} from './LessonBudget.js';
import { hashLessonText, hashLessonValue } from './BuildLessonInput.js';
import { validateLessonPlan } from '../domain/ValidateLessonPlan.js';

const ArtifactRetentionIntervalMs = 60 * 60 * 1000;

const ModelStageSchema = {
  drafting: LessonModelStage.DRAFT,
  reviewingContent: LessonModelStage.REVIEW,
  repairingContent: LessonModelStage.REPAIR,
  recheckingContent: LessonModelStage.REVIEW,
  reviewingVisuals: LessonModelStage.VISUAL_REVIEW,
  repairingVisuals: LessonModelStage.VISUAL_REPAIR,
  recheckingVisuals: LessonModelStage.VISUAL_REVIEW,
} as const;

function isModelStage(stage: string): stage is keyof typeof ModelStageSchema {
  return stage in ModelStageSchema;
}

export function readLessonNarration(plan: LessonPlan) {
  return [
    ...plan.scenes.flatMap((scene) =>
      scene.narration.map((beat) => ({
        ...beat,
        sceneId: scene.sceneId,
        phase:
          scene.kind === 'checkpoint'
            ? (plan.checkpoints.find((checkpoint) => checkpoint.sceneId === scene.sceneId)?.phase ??
              LessonPhase.PREDICT)
            : LessonPhase.WATCH,
      })),
    ),
    ...plan.checkpoints.flatMap((checkpoint) =>
      checkpoint.workedExplanation.map((beat) => ({
        ...beat,
        sceneId: checkpoint.sceneId,
        phase: LessonPhase.WORKED,
      })),
    ),
  ];
}

function hasBlockingReview(review: ReviewResult): boolean {
  return review.issues.some(
    (issue) => issue.severity === ReviewSeverity.BLOCKER || issue.severity === ReviewSeverity.MAJOR,
  );
}

function validateReview(review: ReviewResult, expectedHash: string, visual: boolean): void {
  if (
    review.reviewedHash !== expectedHash ||
    (review.verdict === ReviewVerdict.PASS && hasBlockingReview(review))
  ) {
    throw new LessonError(LessonFailure.INVALID);
  }
  const required = visual
    ? [
        ReviewCriterion.READABILITY,
        ReviewCriterion.HIERARCHY,
        ReviewCriterion.CONTINUITY,
        ReviewCriterion.TIMELINE,
        ReviewCriterion.ASSETS,
        ReviewCriterion.CHECKPOINT,
      ]
    : [
        ReviewCriterion.SOURCE_SUPPORT,
        ReviewCriterion.TRACE_CORRECTNESS,
        ReviewCriterion.CHECKPOINT,
      ];
  if (
    review.verdict === ReviewVerdict.PASS ||
    (visual && review.verdict === ReviewVerdict.NEEDS_HUMAN_REVIEW && !hasBlockingReview(review))
  ) {
    if (
      required.some(
        (criterion) =>
          !review.checks.some(
            (check) => check.criterion === criterion && check.status === ReviewCheckStatus.PASS,
          ),
      )
    ) {
      throw new LessonError(LessonFailure.INVALID);
    }
  }
}

/** One durable stage per wake; no paid request is replayed because a worker lease expires. */
export class LessonGeneration {
  private nextArtifactRetentionAtMs = 0;
  private readonly controllers = new Map<
    string,
    { controller: AbortController; runId: string | null }
  >();
  constructor(
    private readonly store: GuidedLessonStore,
    private readonly model: LessonModel,
    private readonly speech: LessonSpeech,
    private readonly renderer: LessonRenderer,
    private readonly now: () => Date,
    private readonly reportFailure: (event: {
      lessonId: string;
      stage: string;
      code: string;
    }) => void,
  ) {}

  async runNext(): Promise<void> {
    await this.deleteExpiredArtifactsIfDue();
    for (const record of await this.store.listPendingLessons(this.now())) {
      if (record.run?.leaseUntil && new Date(record.run.leaseUntil) > this.now()) {
        continue;
      }
      if (record.run?.dispatched || record.run?.claimId) {
        await this.stopExpiredDispatch(record);
        return;
      }
      await this.runStage(record);
      return;
    }
  }

  cancel(lessonId: string, runId: string): void {
    const active = this.controllers.get(lessonId);
    if (active?.runId === runId) {
      active.controller.abort();
    }
  }

  close(): void {
    for (const active of this.controllers.values()) {
      active.controller.abort();
    }
  }

  private async deleteExpiredArtifactsIfDue(): Promise<void> {
    const now = this.now();
    if (now.getTime() < this.nextArtifactRetentionAtMs) {
      return;
    }
    /* Failed cleanup must also wait before retrying so idle job polls cannot hammer storage. */
    this.nextArtifactRetentionAtMs = now.getTime() + ArtifactRetentionIntervalMs;
    await this.store.deleteExpiredArtifacts(now);
  }

  private async stopExpiredDispatch(record: LessonRecord): Promise<void> {
    await this.store.runAtomically(async (store) => {
      const current = await store.readLesson(record.id);
      if (
        !current?.run ||
        current.run.id !== record.run?.id ||
        (!current.run.dispatched && !current.run.claimId) ||
        (current.run.leaseUntil && new Date(current.run.leaseUntil) > this.now())
      ) {
        return;
      }
      const budget = await store.readBudget(`${current.teacherId}:${current.run.day}`);
      const uncertain =
        current.run.dispatched &&
        (budget?.reservations.some(
          (item) =>
            item.runId === current.run?.id &&
            (item.state === LessonReservationState.DISPATCHED ||
              item.state === LessonReservationState.UNCERTAIN),
        ) ??
          true);
      await store.saveLesson(
        {
          ...current,
          version: current.version + 1,
          status: uncertain ? LessonStatus.USAGE_UNCERTAIN : LessonStatus.FAILED,
          error: uncertain
            ? 'A dispatched provider request lost its worker. Usage must be reconciled before a new request.'
            : 'The worker stopped after usage was recorded. Start a new review run to continue.',
          updatedAt: this.now().toISOString(),
          run: { ...current.run, leaseUntil: null, claimId: null, dispatched: uncertain },
        },
        current.version,
      );
      if (budget) {
        await store.saveBudget(
          {
            ...budget,
            version: budget.version + 1,
            reservations: budget.reservations.map((item) =>
              item.runId === current.run?.id && item.state === LessonReservationState.DISPATCHED
                ? { ...item, state: LessonReservationState.UNCERTAIN }
                : item,
            ),
          },
          budget.version,
        );
      }
    });
  }

  private async runStage(record: LessonRecord): Promise<void> {
    const stage =
      record.status === LessonStatus.ADMITTED
        ? record.plan
          ? LessonStatus.REVIEWING_CONTENT
          : LessonStatus.DRAFTING
        : record.status;
    const signalController = new AbortController();
    this.controllers.set(record.id, {
      controller: signalController,
      runId: record.run?.id ?? null,
    });
    const deadline = setTimeout(
      () => {
        signalController.abort();
      },
      stage === LessonStatus.RENDERING
        ? LessonPolicy.GRAPHICS_DEADLINE_MS
        : LessonPolicy.DEADLINE_MS,
    );
    deadline.unref();
    let claimed: LessonRecord | null = null;
    let attemptId: string | null = null;
    let paid = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      if (
        record.status === LessonStatus.ADMITTED ||
        record.status === LessonStatus.SYNTHESIZING ||
        record.status === LessonStatus.RENDERING
      ) {
        await this.renderer.checkReady?.(signalController.signal);
      }
      const request = isModelStage(stage) ? await this.buildModelRequest(record, stage) : null;
      const inputTokens = request
        ? await this.model.countInput(request, signalController.signal)
        : 0;
      const nextBeat =
        stage === LessonStatus.SYNTHESIZING && record.plan
          ? readLessonNarration(record.plan).find(
              (beat) => !record.speech.some((item) => item.beatId === beat.beatId),
            )
          : undefined;
      const speechCharacters = nextBeat ? Array.from(nextBeat.text).length : 0;
      attemptId = request || nextBeat ? randomUUID() : null;
      paid = attemptId !== null;
      claimed = await this.claimStage(record, stage, attemptId, inputTokens, speechCharacters);
      if (!claimed) {
        return;
      }
      const claimId = claimed.run?.claimId;
      heartbeat = setInterval(() => {
        void this.renewLease(claimed?.id ?? record.id, claimId ?? '').catch(() => {
          signalController.abort();
        });
      }, LessonPolicy.HEARTBEAT_MS);
      heartbeat.unref();
      if (request && attemptId) {
        const generated = await this.model.generate(request, signalController.signal);
        await this.store.runAtomically((store) =>
          settleLessonAttempt(
            store,
            record.teacherId,
            claimed?.run?.day ?? '',
            attemptId ?? '',
            generated.usage,
          ),
        );
        paid = false;
        const usage = LessonProviderUsageSchema.safeParse(generated.usage);
        if (!usage.success) {
          throw new LessonError(LessonFailure.UNCERTAIN);
        }
        await this.recordUsage(claimed, usage.data);
        await this.completeModelStage(claimed, stage, generated.result);
      } else if (stage === LessonStatus.SYNTHESIZING) {
        if (!nextBeat || !attemptId) {
          await this.completeStage(claimed, (current) => ({
            ...current,
            status: LessonStatus.RENDERING,
          }));
          return;
        }
        if (!claimed.contentHash) {
          throw new LessonError(LessonFailure.INVALID);
        }
        const generated = await this.speech.synthesize(
          {
            beatId: nextBeat.beatId,
            text: nextBeat.text,
            language: claimed.language,
            contentHash: claimed.contentHash,
          },
          signalController.signal,
        );
        await this.store.runAtomically((store) =>
          settleLessonAttempt(store, record.teacherId, claimed?.run?.day ?? '', attemptId ?? '', {
            inputTokens: 0,
            outputTokens: 0,
          }),
        );
        paid = false;
        const artifactId = randomUUID();
        const audioDigest = createHash('sha256').update(generated.bytes).digest('hex');
        const descriptor = SpeechArtifactSchema.parse({
          artifactId,
          beatId: nextBeat.beatId,
          contentHash: claimed.contentHash,
          textHash: hashLessonText(nextBeat.text),
          audioDigest,
          durationMs: generated.durationMs,
          byteLength: generated.bytes.byteLength,
          mimeType: generated.mimeType,
          sampleRateHz: generated.sampleRate,
          voiceConfigHash: generated.voiceConfigHash,
        });
        await this.completeStage(
          claimed,
          (current) => {
            if (
              current.speech.reduce(
                (total, item) => total + item.durationMs,
                descriptor.durationMs,
              ) > 300000
            ) {
              throw new LessonError(LessonFailure.INVALID);
            }
            return {
              ...current,
              speech: [...current.speech, descriptor],
              status: LessonStatus.SYNTHESIZING,
            };
          },
          [
            {
              artifactId,
              classId: claimed.classId,
              lessonId: claimed.id,
              revisionId: claimed.revisionId,
              kind: 'audio',
              mimeType: generated.mimeType,
              bytes: generated.bytes,
              digest: audioDigest,
              sceneId: nextBeat.sceneId,
              phase: nextBeat.phase,
            },
          ],
        );
      } else if (stage === LessonStatus.RENDERING) {
        if (!claimed.plan || !claimed.contentHash) {
          throw new LessonError(LessonFailure.INVALID);
        }
        const speechArtifacts = [];
        for (const descriptor of claimed.speech) {
          const artifact = await this.store.readArtifact(descriptor.artifactId);
          if (!artifact || artifact.digest !== descriptor.audioDigest) {
            throw new LessonError(LessonFailure.INVALID);
          }
          speechArtifacts.push({ descriptor, bytes: artifact.bytes });
        }
        const rendered = await this.renderer.render(
          {
            revisionId: claimed.revisionId,
            input: claimed.input,
            plan: claimed.plan,
            contentHash: claimed.contentHash,
            speechArtifacts,
            adjustments: claimed.adjustments,
          },
          signalController.signal,
          {
            beforeModelCall: async (codingAttemptId) => {
              await this.store.runAtomically(async (store) => {
                const current = await store.readLesson(record.id);
                if (
                  !current?.run ||
                  current.run.claimId !== claimed?.run?.claimId ||
                  !current.run.leaseUntil ||
                  new Date(current.run.leaseUntil) <= this.now() ||
                  current.status !== LessonStatus.RENDERING ||
                  signalController.signal.aborted
                ) {
                  throw new LessonError(LessonFailure.STALE);
                }
                const access = await store.readAccess(current.teacherId, current.classId);
                if (!access?.isTeacher) {
                  throw new LessonError(LessonFailure.FORBIDDEN);
                }
                if ((current.run.graphicsAttempts ?? 0) >= 256) {
                  throw new LessonError(LessonFailure.BUDGET);
                }
                await reserveLessonAttempt(store, current, {
                  id: codingAttemptId,
                  runId: current.run.id,
                  lessonId: current.id,
                  stage: 'codingVisuals',
                  input: 0,
                  output: 0,
                  speechCharacters: 0,
                  state: LessonReservationState.DISPATCHED,
                  actualInput: null,
                  actualOutput: null,
                });
                await store.saveLesson(
                  {
                    ...current,
                    version: current.version + 1,
                    run: {
                      ...current.run,
                      dispatched: true,
                      graphicsAttempts: (current.run.graphicsAttempts ?? 0) + 1,
                    },
                  },
                  current.version,
                );
              });
              attemptId = codingAttemptId;
              paid = true;
            },
            afterModelCall: async (codingAttemptId, reportedUsage) => {
              const usage = LessonProviderUsageSchema.safeParse(reportedUsage);
              await this.store.runAtomically((store) =>
                settleLessonAttempt(
                  store,
                  record.teacherId,
                  claimed?.run?.day ?? '',
                  codingAttemptId,
                  usage.success ? usage.data : null,
                ),
              );
              paid = false;
              if (!usage.success) {
                throw new LessonError(LessonFailure.UNCERTAIN);
              }
              await this.recordUsage(claimed ?? record, usage.data);
              await this.store.runAtomically(async (store) => {
                const current = await store.readLesson(record.id);
                if (!current?.run || current.run.claimId !== claimed?.run?.claimId) {
                  return;
                }
                await store.saveLesson(
                  {
                    ...current,
                    version: current.version + 1,
                    run: { ...current.run, dispatched: false },
                  },
                  current.version,
                );
              });
            },
          },
        );
        const manifest = RenderManifestSchema.parse(rendered.manifest);
        if (
          manifest.revisionId !== claimed.revisionId ||
          manifest.contentHash !== claimed.contentHash ||
          manifest.inputPacketHash !== claimed.input.sourcePacketHash ||
          manifest.cues.some(
            (cue) =>
              cue.endFrame <= cue.startFrame ||
              !claimed?.speech.some((audio) => audio.artifactId === cue.audioArtifactId),
          )
        ) {
          throw new LessonError(LessonFailure.INVALID);
        }
        await this.completeStage(
          claimed,
          (current) => ({
            ...current,
            manifest,
            status: current.run?.visualRepairs
              ? LessonStatus.RECHECKING_VISUALS
              : LessonStatus.REVIEWING_VISUALS,
          }),
          rendered.artifacts.map((artifact) => ({
            ...artifact,
            classId: claimed?.classId ?? record.classId,
            lessonId: record.id,
            revisionId: claimed?.revisionId ?? record.revisionId,
          })),
        );
      } else {
        throw new LessonError(LessonFailure.INVALID);
      }
    } catch (error: unknown) {
      const knownNotDispatched = error instanceof LessonProviderNotDispatchedError;
      if (attemptId && claimed && knownNotDispatched) {
        await this.store.runAtomically((store) =>
          settleLessonAttempt(
            store,
            claimed?.teacherId ?? '',
            claimed?.run?.day ?? '',
            attemptId ?? '',
            { inputTokens: 0, outputTokens: 0 },
          ),
        );
      }
      if (attemptId && claimed && paid && !knownNotDispatched) {
        await this.store.runAtomically((store) =>
          settleLessonAttempt(
            store,
            claimed?.teacherId ?? '',
            claimed?.run?.day ?? '',
            attemptId ?? '',
            null,
          ),
        );
      }
      const code =
        error instanceof LessonError
          ? error.code
          : paid && !knownNotDispatched
            ? LessonFailure.UNCERTAIN
            : LessonFailure.FAILED;
      this.reportFailure({ lessonId: record.id, stage, code });
      if (claimed) {
        await this.completeStage(claimed, (current) => ({
          ...current,
          status:
            code === LessonFailure.UNCERTAIN
              ? LessonStatus.USAGE_UNCERTAIN
              : code === LessonFailure.BUDGET
                ? LessonStatus.BUDGET_BLOCKED
                : LessonStatus.FAILED,
          error: knownNotDispatched
            ? 'The configured lesson provider is unavailable.'
            : code === LessonFailure.UNCERTAIN
              ? 'Provider usage is uncertain. This request will not be replayed automatically.'
              : 'The lesson stage failed its validated contract. Review the draft and explicitly start another run.',
        })).catch(() => {});
      } else {
        await this.store.runAtomically(async (store) => {
          const current = await store.readLesson(record.id);
          if (current && current.version === record.version) {
            await store.saveLesson(
              {
                ...current,
                version: current.version + 1,
                status:
                  code === LessonFailure.BUDGET ? LessonStatus.BUDGET_BLOCKED : LessonStatus.FAILED,
                error: code,
                updatedAt: this.now().toISOString(),
              },
              current.version,
            );
          }
        });
      }
    } finally {
      clearTimeout(deadline);
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      signalController.abort();
      this.controllers.delete(record.id);
    }
  }

  private async buildModelRequest(
    record: LessonRecord,
    stage: keyof typeof ModelStageSchema,
  ): Promise<LessonModelRequest> {
    const evidence: LessonMediaArtifact[] = [];
    if (
      stage === LessonStatus.REVIEWING_VISUALS ||
      stage === LessonStatus.REPAIRING_VISUALS ||
      stage === LessonStatus.RECHECKING_VISUALS
    ) {
      for (const item of record.manifest?.evidence.filter(
        (item) =>
          item.kind === LessonEvidenceKind.FRAME || item.kind === LessonEvidenceKind.GEOMETRY,
      ) ?? []) {
        const artifact = await this.store.readArtifact(item.artifactId);
        if (!artifact || artifact.digest !== item.digest) {
          throw new LessonError(LessonFailure.INVALID);
        }
        evidence.push(artifact);
      }
    }
    return {
      stage: ModelStageSchema[stage],
      input: record.input,
      plan: record.plan,
      review:
        stage === LessonStatus.REPAIRING_VISUALS || stage === LessonStatus.RECHECKING_VISUALS
          ? record.visualReview
          : record.review,
      manifest: record.manifest,
      evidence,
      contentHash: record.contentHash ?? record.input.sourcePacketHash,
      maxOutputTokens: StageAllowance[stage].output,
    };
  }

  private async claimStage(
    record: LessonRecord,
    stage: LessonStatus,
    attemptId: string | null,
    inputTokens: number,
    speechCharacters: number,
  ): Promise<LessonRecord | null> {
    return this.store.runAtomically(async (store) => {
      const current = await store.readLesson(record.id);
      if (!current?.run || current.version !== record.version) {
        return null;
      }
      const access = await store.readAccess(current.teacherId, current.classId);
      if (
        !access?.isTeacher ||
        (await store.listLessons(current.classId)).some(
          (item) =>
            item.id !== current.id &&
            item.run?.leaseUntil &&
            new Date(item.run.leaseUntil) > this.now(),
        )
      ) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      if (current.run.day !== this.now().toISOString().slice(0, 10)) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      if (
        isModelStage(stage) &&
        (!Number.isSafeInteger(inputTokens) ||
          inputTokens < 0 ||
          inputTokens > StageAllowance[stage].input ||
          current.run.physicalAttempts >= 7)
      ) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      if (
        speechCharacters &&
        (current.run.speechAttempts >= 24 || current.run.speechCharacters + speechCharacters > 6000)
      ) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      if (attemptId) {
        await reserveLessonAttempt(store, current, {
          id: attemptId,
          runId: current.run.id,
          lessonId: current.id,
          stage,
          input: inputTokens,
          output: isModelStage(stage) ? StageAllowance[stage].output : 0,
          speechCharacters,
          state: LessonReservationState.DISPATCHED,
          actualInput: null,
          actualOutput: null,
        });
      }
      const claimed: LessonRecord = {
        ...current,
        version: current.version + 1,
        status: stage,
        updatedAt: this.now().toISOString(),
        run: {
          ...current.run,
          stage,
          claimId: randomUUID(),
          leaseUntil: new Date(this.now().getTime() + LessonPolicy.LEASE_MS).toISOString(),
          dispatched: attemptId !== null,
          physicalAttempts: current.run.physicalAttempts + (isModelStage(stage) ? 1 : 0),
          speechAttempts: current.run.speechAttempts + (speechCharacters ? 1 : 0),
          speechCharacters: current.run.speechCharacters + speechCharacters,
        },
      };
      await store.saveLesson(claimed, current.version);
      return claimed;
    });
  }

  private async renewLease(lessonId: string, claimId: string): Promise<void> {
    await this.store.runAtomically(async (store) => {
      const current = await store.readLesson(lessonId);
      if (
        !current?.run ||
        current.run.claimId !== claimId ||
        !current.run.leaseUntil ||
        new Date(current.run.leaseUntil) <= this.now()
      ) {
        throw new LessonError(LessonFailure.STALE);
      }
      await store.saveLesson(
        {
          ...current,
          version: current.version + 1,
          run: {
            ...current.run,
            leaseUntil: new Date(this.now().getTime() + LessonPolicy.LEASE_MS).toISOString(),
          },
        },
        current.version,
      );
    });
  }

  private async recordUsage(
    record: LessonRecord,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.store.runAtomically(async (store) => {
      const current = await store.readLesson(record.id);
      if (!current?.run || current.run.id !== record.run?.id) {
        return;
      }
      await store.saveLesson(
        {
          ...current,
          version: current.version + 1,
          run: {
            ...current.run,
            inputTokens: current.run.inputTokens + usage.inputTokens,
            outputTokens: current.run.outputTokens + usage.outputTokens,
          },
        },
        current.version,
      );
    });
  }

  private async completeStage(
    record: LessonRecord,
    change: (current: LessonRecord) => LessonRecord,
    artifacts: StoredLessonArtifact[] = [],
  ): Promise<void> {
    await this.store.runAtomically(async (store) => {
      const current = await store.readLesson(record.id);
      if (
        !current?.run ||
        current.run.claimId !== record.run?.claimId ||
        !current.run.leaseUntil ||
        new Date(current.run.leaseUntil) <= this.now()
      ) {
        return;
      }
      const access = await store.readAccess(current.teacherId, current.classId);
      if (!access?.isTeacher) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      if (
        artifacts.reduce(
          (total, item) => total + item.bytes.byteLength,
          current.speech.reduce((total, item) => total + item.byteLength, 0),
        ) > LessonPolicy.RUN_ARTIFACT_BYTES
      ) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      for (const artifact of artifacts) {
        if (createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.digest) {
          throw new LessonError(LessonFailure.INVALID);
        }
        await store.saveArtifact(artifact);
      }
      const changed = change(current);
      const next = {
        ...changed,
        version: current.version + 1,
        updatedAt: this.now().toISOString(),
        run: changed.run
          ? { ...changed.run, claimId: null, leaseUntil: null, dispatched: false }
          : null,
      };
      await store.saveLesson(next, current.version);
      if (next.revisionId !== current.revisionId || (!current.plan && next.plan)) {
        await store.saveRevision(next);
      }
    });
  }

  private async completeModelStage(
    record: LessonRecord,
    stage: string,
    result: unknown,
  ): Promise<void> {
    await this.completeStage(record, (current) => {
      const base = current;
      if (stage === LessonStatus.DRAFTING || stage === LessonStatus.REPAIRING_CONTENT) {
        const output =
          stage === LessonStatus.DRAFTING
            ? AuthorResultSchema.parse(result)
            : RepairResultSchema.parse(result);
        if (output.status === LessonStatus.NEEDS_TEACHER_INPUT) {
          return {
            ...base,
            status: LessonStatus.NEEDS_TEACHER_INPUT,
            error: output.questions.join(' ').slice(0, 1000),
          };
        }
        const issues = validateLessonPlan(current.input, output.plan);
        if (
          'addressedIssueIds' in output &&
          output.addressedIssueIds.some(
            (id) => !current.review?.issues.some((issue) => issue.issueId === id),
          )
        ) {
          throw new LessonError(LessonFailure.INVALID);
        }
        if (issues.length > 0) {
          throw new LessonError(LessonFailure.INVALID);
        }
        return {
          ...base,
          revisionId: current.plan ? randomUUID() : current.revisionId,
          plan: output.plan,
          title: output.plan.title,
          contentHash: hashLessonValue({ input: current.input, plan: output.plan }),
          status:
            stage === LessonStatus.DRAFTING
              ? LessonStatus.REVIEWING_CONTENT
              : LessonStatus.RECHECKING_CONTENT,
          scriptApproved: false,
          previewApproved: false,
          scriptApproval: null,
          previewApproval: null,
          speech: [],
          manifest: null,
        };
      }
      if (stage === LessonStatus.REPAIRING_VISUALS) {
        const output = VisualRepairResultSchema.parse(result);
        if (output.status === LessonStatus.NEEDS_TEACHER_INPUT) {
          return {
            ...base,
            status: LessonStatus.NEEDS_TEACHER_INPUT,
            error: output.questions.join(' ').slice(0, 1000),
          };
        }
        const plan = current.plan;
        if (
          !plan ||
          !current.manifest ||
          output.adjustments.contentHash !== current.contentHash ||
          output.adjustments.baseRenderManifestHash !== hashLessonValue(current.manifest) ||
          output.adjustments.addressedIssueIds.some(
            (id) => !current.visualReview?.issues.some((issue) => issue.issueId === id),
          ) ||
          new Set(output.adjustments.scenes.map((scene) => scene.sceneId)).size !==
            output.adjustments.scenes.length ||
          output.adjustments.scenes.some(
            (scene) =>
              !plan.scenes.some(
                (item) =>
                  item.sceneId === scene.sceneId &&
                  current.input.templates.some(
                    (template) =>
                      template.templateId === item.kind &&
                      template.supportedLayoutVariants.includes(scene.layoutVariant),
                  ) &&
                  scene.beatAdjustments.every((hold) =>
                    readLessonNarration(plan).some(
                      (beat) => beat.sceneId === scene.sceneId && beat.beatId === hold.beatId,
                    ),
                  ),
              ),
          )
        ) {
          throw new LessonError(LessonFailure.INVALID);
        }
        return {
          ...base,
          adjustments: output.adjustments,
          status: LessonStatus.RENDERING,
          previewApproved: false,
          previewApproval: null,
        };
      }
      const review = ReviewResultSchema.parse(result);
      const visual =
        stage === LessonStatus.REVIEWING_VISUALS || stage === LessonStatus.RECHECKING_VISUALS;
      validateReview(
        review,
        visual ? hashLessonValue(current.manifest) : (current.contentHash ?? ''),
        visual,
      );
      if (visual) {
        if (
          review.verdict === ReviewVerdict.PASS ||
          (review.verdict === ReviewVerdict.NEEDS_HUMAN_REVIEW && !hasBlockingReview(review))
        ) {
          return { ...base, visualReview: review, status: LessonStatus.PREVIEW_READY };
        }
        if (review.verdict === ReviewVerdict.FIX && base.run && base.run.visualRepairs === 0) {
          return {
            ...base,
            visualReview: review,
            status: LessonStatus.REPAIRING_VISUALS,
            run: { ...base.run, visualRepairs: 1 },
          };
        }
        return {
          ...base,
          visualReview: review,
          status:
            review.verdict === ReviewVerdict.NEEDS_TEACHER_INPUT
              ? LessonStatus.NEEDS_TEACHER_INPUT
              : LessonStatus.FAILED,
          error: 'The rendered preview needs correction before release.',
        };
      }
      if (review.verdict === ReviewVerdict.PASS) {
        return { ...base, review, status: LessonStatus.AWAITING_SCRIPT_APPROVAL };
      }
      if (review.verdict === ReviewVerdict.FIX && base.run && base.run.contentRepairs === 0) {
        return {
          ...base,
          review,
          status: LessonStatus.REPAIRING_CONTENT,
          run: { ...base.run, contentRepairs: 1 },
        };
      }
      return {
        ...base,
        review,
        status:
          review.verdict === ReviewVerdict.NEEDS_TEACHER_INPUT ||
          review.verdict === ReviewVerdict.NEEDS_HUMAN_REVIEW
            ? LessonStatus.NEEDS_TEACHER_INPUT
            : LessonStatus.FAILED,
        error: 'Content review needs a teacher correction.',
      };
    });
  }
}
