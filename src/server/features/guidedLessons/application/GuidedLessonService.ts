import { createHash, randomUUID } from 'node:crypto';
import {
  LessonStatus,
  LessonPhase,
  ReviewSeverity,
  ReviewVerdict,
  GuidedLessonReplySchema,
  GuidedLessonSummarySchema,
  GuidedLessonDetailSchema,
  HelpResultSchema,
  type GuidedLessonCommand,
  type GuidedLessonReadRequest,
  type GuidedLessonReply,
  type GuidedLessonArtifactRequest,
  type GuidedLessonSummary,
  type LearnerProjection,
} from '#contracts/GuidedLessons.js';
import type { GuidedLessonStore, StoredLessonArtifact } from './GuidedLessonStore.js';
import type { LessonRecord, LessonRelease, LessonProgress } from './LessonState.js';
import { LessonProviderUsageSchema, LessonReservationState } from './LessonState.js';
import {
  LessonModelStage,
  LessonProviderNotDispatchedError,
  type LessonModel,
  type LessonSpeech,
  type LessonRenderer,
  type LessonModelRequest,
} from './LessonPorts.js';
import { LessonGeneration } from './LessonGeneration.js';
import { LessonError, LessonFailure } from './LessonFailure.js';
import { admitLessonRun, createLessonBudget } from './LessonBudget.js';
import {
  buildLessonInput,
  buildPublicationLessonPassages,
  hashLessonValue,
} from './BuildLessonInput.js';
import {
  validateLessonInput,
  validateLessonPlan,
  readCheckpointAnswer,
} from '../domain/ValidateLessonPlan.js';
import { buildLessonProjection } from '../domain/BuildLessonProjection.js';

function summarizeLesson(record: LessonRecord): GuidedLessonSummary {
  return GuidedLessonSummarySchema.parse({
    id: record.id,
    classId: record.classId,
    title: record.title,
    status: record.status,
    version: record.version,
    language: record.language,
    updatedAt: record.updatedAt,
    releaseId: record.releaseId,
    error: record.error,
  });
}

function detailLesson(record: LessonRecord): GuidedLessonReply {
  return {
    kind: 'detail',
    lesson: GuidedLessonDetailSchema.parse({
      ...summarizeLesson(record),
      input: record.input,
      plan: record.plan,
      contentHash: record.contentHash,
      review: record.review,
      visualReview: record.visualReview,
      manifest: record.manifest,
      scriptApproved: record.scriptApproved,
      previewApproved: record.previewApproved,
      usage: {
        inputTokens: record.run?.inputTokens ?? 0,
        outputTokens: record.run?.outputTokens ?? 0,
        totalTokens: (record.run?.inputTokens ?? 0) + (record.run?.outputTokens ?? 0),
        generationAttempts:
          (record.run?.physicalAttempts ?? 0) + (record.run?.graphicsAttempts ?? 0),
        speechCharacters: record.run?.speechCharacters ?? 0,
        speechSeconds: record.speech.reduce((sum, item) => sum + item.durationMs / 1000, 0),
        artifactBytes: record.speech.reduce((sum, item) => sum + item.byteLength, 0),
      },
    }),
  };
}

function createProgress(studentId: string, release: LessonRelease): LessonProgress {
  const firstScene = release.record.plan?.scenes[0];
  if (!firstScene) {
    throw new LessonError(LessonFailure.INVALID);
  }
  return {
    studentId,
    releaseId: release.id,
    version: 0,
    sceneId: firstScene.sceneId,
    revealed: [],
    attempted: [],
    independent: [],
    hinted: [],
    hintIds: [],
    frame: 0,
    reflection: '',
    reflecting: false,
    viewPhase: null,
  };
}

function projectLesson(record: LessonRecord, progress: LessonProgress): LearnerProjection {
  return buildLessonProjection({
    record,
    progress,
    hashValue: hashLessonValue,
    ...(progress.reflecting
      ? { phase: LessonPhase.REFLECT }
      : progress.viewPhase
        ? { phase: progress.viewPhase }
        : {}),
  });
}

function createRun(day: string, stage: LessonRecord['status']): NonNullable<LessonRecord['run']> {
  return {
    id: randomUUID(),
    day,
    stage,
    claimId: null,
    leaseUntil: null,
    dispatched: false,
    contentRepairs: 0,
    visualRepairs: 0,
    physicalAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    speechAttempts: 0,
    speechCharacters: 0,
    renderRetries: 0,
  };
}

function isLearnerCommand(
  command: GuidedLessonCommand,
): command is Extract<GuidedLessonCommand, { expectedProgressVersion: number }> {
  return 'expectedProgressVersion' in command;
}

/** Owns explicit teacher generation, exact release and home study without live-session leases. */
export class GuidedLessonService {
  private readonly generation: LessonGeneration;

  constructor(
    private readonly store: GuidedLessonStore,
    private readonly model: LessonModel,
    speech: LessonSpeech,
    renderer: LessonRenderer,
    private readonly now: () => Date = () => new Date(),
    reportFailure: (event: { lessonId: string; stage: string; code: string }) => void = () => {},
  ) {
    this.generation = new LessonGeneration(store, model, speech, renderer, now, reportFailure);
  }

  prepareNextLesson(): Promise<void> {
    return this.generation.runNext();
  }

  close(): void {
    this.generation.close();
  }

  async read(userId: string, request: GuidedLessonReadRequest): Promise<GuidedLessonReply> {
    return this.store.runAtomically(async (store) => {
      if (request.action === 'list') {
        const classes = await store.listClasses(userId);
        const selected = request.classId
          ? classes.filter((item) => item.id === request.classId)
          : classes;
        if (request.classId && selected.length === 0) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        const lessons: GuidedLessonSummary[] = [];
        for (const schoolClass of selected) {
          const access = await this.requireAccess(store, userId, schoolClass.id);
          for (const record of await store.listLessons(schoolClass.id)) {
            if (access.isTeacher) {
              lessons.push(summarizeLesson(record));
            } else if (record.releaseId) {
              const release = await store.readRelease(record.releaseId);
              if (release?.available) {
                lessons.push(
                  summarizeLesson({
                    ...release.record,
                    releaseId: release.id,
                    status: LessonStatus.RELEASED,
                  }),
                );
              }
            }
          }
        }
        return { kind: 'list', classes, lessons };
      }
      const access = await this.requireAccess(store, userId, request.classId);
      if (request.action === 'teacherInput') {
        if (!access.isTeacher) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        const publication = await store.readPublication(
          request.classId,
          request.courseRevisionId ?? access.courseRevisionId,
        );
        if (!publication) {
          return { kind: 'teacherInput', classId: request.classId, revisions: [], passages: [] };
        }
        const passages = buildPublicationLessonPassages(publication);
        if (passages.length > 200) {
          throw new LessonError(LessonFailure.BUDGET);
        }
        return {
          kind: 'teacherInput',
          classId: request.classId,
          revisions: [
            {
              id: publication.courseId,
              title: 'Approved course material',
              sections: publication.draft.sections.map((section) => {
                const originals = new Set(
                  passages
                    .filter(
                      (passage) => passage.pageId && section.sourcePageIds.includes(passage.pageId),
                    )
                    .map((passage) => passage.passageId),
                );
                return {
                  id: section.id,
                  title: section.title,
                  passageIds: passages
                    .filter(
                      (passage) =>
                        originals.has(passage.passageId) ||
                        passage.correctsPassageIds.some((id) => originals.has(id)),
                    )
                    .map((passage) => passage.passageId),
                };
              }),
            },
          ],
          passages,
        };
      }
      if (request.action === 'requests') {
        return {
          kind: 'requests',
          requests: await store.listRequests(request.classId, access.isTeacher ? null : userId),
        };
      }
      if (request.action === 'projection' || request.action === 'notes') {
        const release = await this.requireRelease(
          store,
          userId,
          request.classId,
          request.releaseId,
        );
        if (request.action === 'notes') {
          return { kind: 'notes', notes: await store.listNotes(userId, release.id) };
        }
        const progress =
          (await store.readProgress(userId, release.id)) ?? createProgress(userId, release);
        const selectedScene = request.sceneId ?? progress.sceneId;
        this.requireSceneAccess(release.record, progress, selectedScene);
        return this.projectReply(store, userId, release, {
          ...progress,
          sceneId: selectedScene,
          ...(selectedScene !== progress.sceneId ? { viewPhase: null, reflecting: false } : {}),
        });
      }
      const record = await this.requireLesson(
        store,
        userId,
        request.classId,
        request.lessonId,
        true,
      );
      if (request.action === 'preview') {
        const progress = createProgress(userId, {
          id: `preview-${record.revisionId}`,
          lessonId: record.id,
          classId: record.classId,
          available: true,
          releasedAt: this.now().toISOString(),
          record,
        });
        const projection = buildLessonProjection({
          record,
          progress,
          hashValue: hashLessonValue,
          teacherPreview: true,
          ...(request.sceneId ? { sceneId: request.sceneId } : {}),
          ...(request.phase ? { phase: request.phase } : {}),
        });
        return {
          kind: 'projection',
          projection,
          notes: [],
          reflectionPrompt: record.plan?.reflectionPrompt ?? '',
        };
      }
      return request.action === 'status'
        ? { kind: 'status', lesson: summarizeLesson(record) }
        : detailLesson(record);
    });
  }

  async execute(userId: string, command: GuidedLessonCommand): Promise<GuidedLessonReply> {
    if (command.action === 'help') {
      return this.answerQuestion(userId, command);
    }
    const reply = await this.store.runAtomically(async (store) => {
      const access = await this.requireAccess(store, userId, command.classId);
      const digest = hashLessonValue(command);
      const receipt = await store.readReceipt(userId, command.commandId);
      if (receipt) {
        if (receipt.digest !== digest) {
          throw new LessonError(LessonFailure.STALE);
        }
        await this.authorizeCommandReceipt(store, userId, command);
        if (isLearnerCommand(command) && receipt.reply.kind === 'projection') {
          const progress = await store.readProgress(userId, command.releaseId);
          if (progress && progress.version !== receipt.reply.projection.progressVersion) {
            const release = await this.requireRelease(
              store,
              userId,
              command.classId,
              command.releaseId,
            );
            return this.projectReply(store, userId, release, progress);
          }
        }
        return receipt.reply;
      }
      let reply: GuidedLessonReply;
      if (command.action === 'request') {
        if (!access.enrolled) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        if (command.releaseId) {
          const release = await this.requireRelease(
            store,
            userId,
            command.classId,
            command.releaseId,
          );
          if (
            command.lessonId !== release.lessonId ||
            (command.sceneId &&
              !release.record.plan?.scenes.some((scene) => scene.sceneId === command.sceneId))
          ) {
            throw new LessonError(LessonFailure.INVALID);
          }
        }
        await store.saveRequest({
          id: randomUUID(),
          classId: command.classId,
          studentId: userId,
          lessonId: command.lessonId,
          releaseId: command.releaseId,
          sceneId: command.sceneId,
          text: command.text,
          status: 'open',
          resolution: null,
          reply: null,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        });
        reply = { kind: 'requests', requests: await store.listRequests(command.classId, userId) };
      } else if (command.action === 'resolveRequest') {
        if (!access.isTeacher) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        const request = (await store.listRequests(command.classId, null)).find(
          (item) => item.id === command.requestId,
        );
        if (!request) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        if (command.lessonId) {
          await this.requireLesson(store, userId, command.classId, command.lessonId, true);
        }
        await store.saveRequest({
          ...request,
          lessonId: command.lessonId,
          status: 'resolved',
          resolution: command.resolution,
          reply: command.text,
          updatedAt: this.now().toISOString(),
        });
        reply = { kind: 'requests', requests: await store.listRequests(command.classId, null) };
      } else if (isLearnerCommand(command)) {
        reply = await this.executeLearnerCommand(store, userId, command);
      } else {
        if (!access.isTeacher) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        if (command.action === 'create') {
          const publication = await store.readPublication(
            command.classId,
            command.courseRevisionId,
          );
          if (!publication) {
            throw new LessonError(LessonFailure.FORBIDDEN);
          }
          const input = buildLessonInput(publication, command);
          if (validateLessonInput(input).length > 0) {
            throw new LessonError(LessonFailure.INVALID);
          }
          const record: LessonRecord = {
            id: randomUUID(),
            classId: command.classId,
            teacherId: userId,
            version: 1,
            revisionId: randomUUID(),
            title: command.objective.slice(0, 120),
            language: command.language,
            status: LessonStatus.NEEDS_TEACHER_INPUT,
            updatedAt: this.now().toISOString(),
            input,
            plan: null,
            contentHash: null,
            review: null,
            visualReview: null,
            manifest: null,
            adjustments: null,
            speech: [],
            scriptApproved: false,
            previewApproved: false,
            scriptApproval: null,
            previewApproval: null,
            releaseId: null,
            error: null,
            run: null,
          };
          await store.saveLesson(record, 0);
          reply = detailLesson(record);
        } else {
          const record = await this.requireLesson(
            store,
            userId,
            command.classId,
            command.lessonId,
            true,
          );
          if (record.version !== command.expectedVersion) {
            throw new LessonError(LessonFailure.STALE);
          }
          let next: LessonRecord = {
            ...record,
            version: record.version + 1,
            updatedAt: this.now().toISOString(),
            error: null,
          };
          if (command.action !== 'cancel' && command.action !== 'withdraw') {
            await this.requireSettledRun(store, record);
          }
          switch (command.action) {
            case 'start':
            case 'retry': {
              if (record.status === LessonStatus.USAGE_UNCERTAIN || record.run?.leaseUntil) {
                throw new LessonError(LessonFailure.UNCERTAIN);
              }
              const previousBudget = record.run
                ? await store.readBudget(`${record.teacherId}:${record.run.day}`)
                : null;
              if (
                previousBudget?.reservations.some(
                  (item) =>
                    item.runId === record.run?.id &&
                    (item.state === LessonReservationState.DISPATCHED ||
                      item.state === LessonReservationState.UNCERTAIN),
                )
              ) {
                throw new LessonError(LessonFailure.UNCERTAIN);
              }
              const day = await admitLessonRun(store, userId, this.now());
              next = {
                ...next,
                status: LessonStatus.ADMITTED,
                run: createRun(
                  day,
                  record.plan ? LessonStatus.REVIEWING_CONTENT : LessonStatus.DRAFTING,
                ),
                review: null,
                visualReview: null,
                scriptApproved: false,
                previewApproved: false,
                scriptApproval: null,
                previewApproval: null,
                speech: [],
                manifest: null,
                adjustments: null,
              };
              break;
            }
            case 'savePlan': {
              if (validateLessonPlan(record.input, command.plan).length > 0) {
                throw new LessonError(LessonFailure.INVALID);
              }
              next = {
                ...next,
                revisionId: randomUUID(),
                title: command.plan.title,
                plan: command.plan,
                contentHash: hashLessonValue({ input: record.input, plan: command.plan }),
                status: LessonStatus.NEEDS_TEACHER_INPUT,
                review: null,
                visualReview: null,
                manifest: null,
                adjustments: null,
                speech: [],
                scriptApproved: false,
                previewApproved: false,
                scriptApproval: null,
                previewApproval: null,
                run: null,
              };
              await store.saveRevision(next);
              break;
            }
            case 'approveScript': {
              if (
                record.status !== LessonStatus.AWAITING_SCRIPT_APPROVAL ||
                !record.plan ||
                command.contentHash !== record.contentHash ||
                record.review?.verdict !== ReviewVerdict.PASS ||
                record.plan.scenes.some(
                  (scene) => !command.acknowledgedSceneIds.includes(scene.sceneId),
                )
              ) {
                throw new LessonError(LessonFailure.INVALID);
              }
              next = {
                ...next,
                scriptApproved: true,
                scriptApproval: {
                  commandId: command.commandId,
                  contentHash: command.contentHash,
                  at: this.now().toISOString(),
                },
              };
              break;
            }
            case 'render': {
              if (
                ![
                  LessonStatus.AWAITING_SCRIPT_APPROVAL,
                  LessonStatus.FAILED,
                  LessonStatus.BUDGET_BLOCKED,
                ].some((status) => status === record.status) ||
                !record.scriptApproved ||
                record.scriptApproval?.contentHash !== record.contentHash ||
                !record.plan ||
                !record.run
              ) {
                throw new LessonError(LessonFailure.INVALID);
              }
              let run = record.run;
              if (run.day !== this.now().toISOString().slice(0, 10)) {
                const day = await admitLessonRun(store, userId, this.now());
                run = { ...run, day };
              }
              next = {
                ...next,
                status: LessonStatus.SYNTHESIZING,
                run: { ...run, leaseUntil: null, claimId: null, dispatched: false },
              };
              break;
            }
            case 'approvePreview': {
              if (
                record.status !== LessonStatus.PREVIEW_READY ||
                !record.manifest ||
                command.renderManifestHash !== hashLessonValue(record.manifest) ||
                record.manifest.evidence.some(
                  (evidence) => !command.acknowledgedEvidenceIds.includes(evidence.evidenceId),
                ) ||
                record.visualReview?.issues.some(
                  (issue) =>
                    issue.severity === ReviewSeverity.BLOCKER ||
                    issue.severity === ReviewSeverity.MAJOR,
                )
              ) {
                throw new LessonError(LessonFailure.INVALID);
              }
              next = {
                ...next,
                previewApproved: true,
                previewApproval: {
                  commandId: command.commandId,
                  manifestHash: command.renderManifestHash,
                  evidenceIds: command.acknowledgedEvidenceIds,
                  at: this.now().toISOString(),
                },
              };
              break;
            }
            case 'release': {
              if (
                record.status !== LessonStatus.PREVIEW_READY ||
                !record.scriptApproved ||
                !record.previewApproved ||
                !record.plan ||
                !record.manifest ||
                command.contentHash !== record.contentHash ||
                command.renderManifestHash !== hashLessonValue(record.manifest) ||
                record.previewApproval?.manifestHash !== command.renderManifestHash ||
                record.scriptApproval?.contentHash !== command.contentHash
              ) {
                throw new LessonError(LessonFailure.INVALID);
              }
              const publication = await store.readPublication(
                record.classId,
                record.input.courseRevisionId,
              );
              if (!publication) {
                throw new LessonError(LessonFailure.FORBIDDEN);
              }
              const releaseId = randomUUID();
              // Earlier releases remain available so private note anchors reopen their exact revision.
              next = {
                ...next,
                releaseId,
                status: LessonStatus.RELEASED,
                run: record.run
                  ? { ...record.run, claimId: null, leaseUntil: null, dispatched: false }
                  : null,
              };
              await store.saveRelease({
                id: releaseId,
                lessonId: record.id,
                classId: record.classId,
                available: true,
                releasedAt: this.now().toISOString(),
                record: next,
              });
              break;
            }
            case 'withdraw': {
              const release = record.releaseId ? await store.readRelease(record.releaseId) : null;
              if (!release) {
                throw new LessonError(LessonFailure.INVALID);
              }
              await store.withdrawLessonReleases(record.id);
              next = { ...next, releaseId: null, status: LessonStatus.PREVIEW_READY };
              break;
            }
            case 'cancel': {
              next = {
                ...next,
                status: LessonStatus.CANCELLED,
                run: record.run ? { ...record.run, claimId: null, leaseUntil: null } : null,
              };
              break;
            }
          }
          await store.saveLesson(next, record.version);
          reply = detailLesson(next);
        }
      }
      const validated = GuidedLessonReplySchema.parse(reply);
      await store.saveReceipt(userId, command.classId, command.commandId, {
        digest,
        reply: validated,
      });
      return validated;
    });
    if (command.action === 'cancel') {
      const cancelled = await this.store.runAtomically((store) =>
        store.readLesson(command.lessonId),
      );
      if (
        cancelled?.status === LessonStatus.CANCELLED &&
        cancelled.version === command.expectedVersion + 1 &&
        cancelled.run
      ) {
        this.generation.cancel(command.lessonId, cancelled.run.id);
      }
    }
    return reply;
  }

  async readArtifact(
    userId: string,
    request: GuidedLessonArtifactRequest,
  ): Promise<StoredLessonArtifact> {
    return this.store.runAtomically(async (store) => {
      const access = await this.requireAccess(store, userId, request.classId);
      let record: LessonRecord;
      if (request.releaseId) {
        const release = await this.requireRelease(
          store,
          userId,
          request.classId,
          request.releaseId,
        );
        if (release.lessonId !== request.lessonId) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        record = release.record;
      } else {
        if (!access.isTeacher) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        record = await this.requireLesson(store, userId, request.classId, request.lessonId, true);
      }
      const artifact = await store.readArtifact(request.artifactId);
      if (
        !artifact ||
        artifact.classId !== request.classId ||
        artifact.lessonId !== request.lessonId ||
        artifact.revisionId !== record.revisionId ||
        artifact.bytes.byteLength > 16777216 ||
        createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.digest
      ) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      if (!access.isTeacher) {
        if (!request.releaseId) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        const release = await this.requireRelease(
          store,
          userId,
          request.classId,
          request.releaseId,
        );
        const progress =
          (await store.readProgress(userId, release.id)) ?? createProgress(userId, release);
        this.requireSceneAccess(record, progress, artifact.sceneId ?? progress.sceneId);
        const projection = projectLesson(record, {
          ...progress,
          sceneId: artifact.sceneId ?? progress.sceneId,
          viewPhase:
            artifact.sceneId && artifact.sceneId !== progress.sceneId ? null : progress.viewPhase,
        });
        if (!projection.allowedArtifactIds.includes(artifact.artifactId)) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
      }
      return artifact;
    });
  }

  private async requireAccess(store: GuidedLessonStore, userId: string, classId: string) {
    const access = await store.readAccess(userId, classId);
    if (!access || (!access.isTeacher && !access.enrolled)) {
      throw new LessonError(LessonFailure.FORBIDDEN);
    }
    return access;
  }

  private async authorizeCommandReceipt(
    store: GuidedLessonStore,
    userId: string,
    command: GuidedLessonCommand,
  ): Promise<void> {
    const access = await this.requireAccess(store, userId, command.classId);
    if (isLearnerCommand(command)) {
      const release = await this.requireRelease(store, userId, command.classId, command.releaseId);
      if (release.lessonId !== command.lessonId) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
    } else if (command.action === 'request') {
      if (!access.enrolled) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      if (command.releaseId) {
        await this.requireRelease(store, userId, command.classId, command.releaseId);
      }
    } else {
      if (!access.isTeacher) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      if ('lessonId' in command && command.lessonId) {
        await this.requireLesson(store, userId, command.classId, command.lessonId, true);
      }
    }
  }

  private async requireSettledRun(store: GuidedLessonStore, record: LessonRecord): Promise<void> {
    if (!record.run) {
      return;
    }
    const budget = await store.readBudget(`${record.teacherId}:${record.run.day}`);
    if (
      record.run.claimId ||
      record.run.leaseUntil ||
      budget?.reservations.some(
        (item) =>
          item.runId === record.run?.id &&
          (item.state === LessonReservationState.DISPATCHED ||
            item.state === LessonReservationState.UNCERTAIN),
      )
    ) {
      throw new LessonError(LessonFailure.UNCERTAIN);
    }
  }

  private async requireLesson(
    store: GuidedLessonStore,
    userId: string,
    classId: string,
    lessonId: string,
    teacher: boolean,
  ): Promise<LessonRecord> {
    const access = await this.requireAccess(store, userId, classId);
    const record = await store.readLesson(lessonId);
    if (
      !record ||
      record.classId !== classId ||
      (teacher && (!access.isTeacher || record.teacherId !== userId))
    ) {
      throw new LessonError(LessonFailure.FORBIDDEN);
    }
    return record;
  }

  private async requireRelease(
    store: GuidedLessonStore,
    userId: string,
    classId: string,
    releaseId: string,
  ): Promise<LessonRelease> {
    await this.requireAccess(store, userId, classId);
    const release = await store.readRelease(releaseId);
    if (
      !release ||
      !release.available ||
      release.classId !== classId ||
      !(await store.readPublication(classId, release.record.input.courseRevisionId))
    ) {
      throw new LessonError(LessonFailure.FORBIDDEN);
    }
    return release;
  }

  private requireSceneAccess(
    record: LessonRecord,
    progress: LessonProgress,
    sceneId: string,
  ): void {
    const index = record.plan?.scenes.findIndex((scene) => scene.sceneId === sceneId) ?? -1;
    if (
      index < 0 ||
      record.plan?.checkpoints.some((checkpoint) => {
        const checkpointIndex =
          record.plan?.scenes.findIndex((scene) => scene.sceneId === checkpoint.sceneId) ?? -1;
        return checkpointIndex < index && !progress.revealed.includes(checkpoint.checkpointId);
      })
    ) {
      throw new LessonError(LessonFailure.FORBIDDEN);
    }
  }

  private async projectReply(
    store: GuidedLessonStore,
    userId: string,
    release: LessonRelease,
    progress: LessonProgress,
  ): Promise<GuidedLessonReply> {
    return {
      kind: 'projection',
      projection: projectLesson({ ...release.record, releaseId: release.id }, progress),
      notes: await store.listNotes(userId, release.id),
      reflectionPrompt: release.record.plan?.reflectionPrompt ?? '',
    };
  }

  private async executeLearnerCommand(
    store: GuidedLessonStore,
    userId: string,
    command: Extract<GuidedLessonCommand, { expectedProgressVersion: number }>,
  ): Promise<GuidedLessonReply> {
    const release = await this.requireRelease(store, userId, command.classId, command.releaseId);
    if (release.lessonId !== command.lessonId || !release.record.plan) {
      throw new LessonError(LessonFailure.FORBIDDEN);
    }
    const progress =
      (await store.readProgress(userId, release.id)) ?? createProgress(userId, release);
    if (progress.version !== command.expectedProgressVersion) {
      throw new LessonError(LessonFailure.STALE);
    }
    const plan = release.record.plan;
    const currentCheckpoint = plan.checkpoints.find(
      (checkpoint) => checkpoint.sceneId === progress.sceneId,
    );
    let next: LessonProgress = { ...progress, version: progress.version + 1 };
    let help: GuidedLessonReply | null = null;
    if (command.action === 'progress') {
      if (command.noteId && command.intent !== 'revisit') {
        throw new LessonError(LessonFailure.INVALID);
      }
      this.requireSceneAccess(release.record, progress, command.sceneId);
      if (command.intent === 'workedAnswer') {
        const checkpoint = plan.checkpoints.find((item) => item.sceneId === command.sceneId);
        if (!checkpoint) {
          throw new LessonError(LessonFailure.INVALID);
        }
        next = {
          ...next,
          sceneId: command.sceneId,
          revealed: [...new Set([...next.revealed, checkpoint.checkpointId])],
          hinted: [...new Set([...next.hinted, checkpoint.checkpointId])],
          frame: 0,
          reflecting: false,
          viewPhase: null,
        };
      } else if (command.intent === 'retry') {
        const index = plan.scenes.findIndex((scene) => scene.sceneId === command.sceneId);
        const resetIds = new Set(
          plan.checkpoints
            .filter(
              (checkpoint) =>
                plan.scenes.findIndex((scene) => scene.sceneId === checkpoint.sceneId) >= index,
            )
            .map((checkpoint) => checkpoint.checkpointId),
        );
        const keepHints = new Set(
          plan.checkpoints
            .filter((checkpoint) => !resetIds.has(checkpoint.checkpointId))
            .flatMap((checkpoint) => checkpoint.hints.map((hint) => hint.hintId)),
        );
        next = {
          ...next,
          sceneId: command.sceneId,
          frame: 0,
          reflecting: false,
          viewPhase: null,
          revealed: next.revealed.filter((id) => !resetIds.has(id)),
          attempted: next.attempted.filter((id) => !resetIds.has(id)),
          independent: next.independent.filter((id) => !resetIds.has(id)),
          hinted: next.hinted.filter((id) => !resetIds.has(id)),
          hintIds: next.hintIds.filter((id) => keepHints.has(id)),
        };
      } else if (command.intent === 'watchComplete' || command.intent === 'next') {
        if (
          command.sceneId !== progress.sceneId ||
          (currentCheckpoint && !progress.revealed.includes(currentCheckpoint.checkpointId))
        ) {
          throw new LessonError(LessonFailure.INVALID);
        }
        const projection = projectLesson({ ...release.record, releaseId: release.id }, progress);
        const endFrame = Math.max(
          1,
          ...projection.narrationCues.map((cue) => cue.endFrame),
          ...projection.visualCues.map((cue) => cue.endFrame),
        );
        if (command.frame < endFrame - 1) {
          throw new LessonError(LessonFailure.INVALID);
        }
        const index = plan.scenes.findIndex((scene) => scene.sceneId === progress.sceneId);
        const following = plan.scenes[index + 1];
        next = {
          ...next,
          sceneId: following?.sceneId ?? progress.sceneId,
          frame: 0,
          reflecting: !following,
          viewPhase: null,
        };
      } else if (command.intent === 'reflect') {
        if (!progress.reflecting || command.sceneId !== progress.sceneId) {
          throw new LessonError(LessonFailure.INVALID);
        }
        next = { ...next, reflection: command.reflection };
      } else {
        const note = command.noteId
          ? (await store.listNotes(userId, release.id)).find(
              (item) => item.noteId === command.noteId,
            )
          : null;
        if (command.noteId && (!note || note.anchor.sceneId !== command.sceneId)) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        next = {
          ...next,
          sceneId: note?.anchor.sceneId ?? command.sceneId,
          frame: note?.anchor.frame ?? command.frame,
          reflecting: note?.anchor.phase === LessonPhase.REFLECT,
          viewPhase: note?.anchor.phase ?? null,
        };
        // Projection enforces held-state gates even for an earlier saved worked note after Retry.
        projectLesson({ ...release.record, releaseId: release.id }, next);
      }
    } else if (
      command.action === 'attempt' ||
      command.action === 'hint' ||
      command.action === 'help'
    ) {
      const checkpoint =
        command.action === 'help'
          ? currentCheckpoint
          : plan.checkpoints.find((item) => item.checkpointId === command.checkpointId);
      if (!checkpoint || checkpoint.sceneId !== progress.sceneId) {
        throw new LessonError(LessonFailure.INVALID);
      }
      if (command.action === 'attempt') {
        if (progress.revealed.includes(checkpoint.checkpointId)) {
          throw new LessonError(LessonFailure.INVALID);
        }
        const answer = readCheckpointAnswer(release.record.input, checkpoint);
        const correct =
          command.answer.kind === 'number'
            ? answer === command.answer.value
            : answer === command.answer.optionId;
        next = { ...next, attempted: [...new Set([...next.attempted, checkpoint.checkpointId])] };
        if (correct) {
          next = {
            ...next,
            revealed: [...new Set([...next.revealed, checkpoint.checkpointId])],
            independent: next.hinted.includes(checkpoint.checkpointId)
              ? next.independent
              : [...new Set([...next.independent, checkpoint.checkpointId])],
            frame: 0,
            viewPhase: null,
          };
        }
      } else {
        const hint = checkpoint.hints.find((item) => !next.hintIds.includes(item.hintId));
        if (hint) {
          next = {
            ...next,
            hinted: [...new Set([...next.hinted, checkpoint.checkpointId])],
            hintIds: [...next.hintIds, hint.hintId],
          };
          help = {
            kind: 'hint',
            hintId: hint.hintId,
            text: hint.text,
            sourceRefs: hint.sourceRefs,
          };
        } else {
          help = {
            kind: 'help',
            result: {
              kind: 'insufficientContext',
              text: 'All approved hints have been shown. Choose Show worked answer to see the explanation.',
            },
          };
        }
      }
    } else if (command.action === 'saveNote') {
      const projection = projectLesson({ ...release.record, releaseId: release.id }, progress);
      this.validateNoteAnchor(command.note.anchor, projection, release.record);
      await store.saveNote(userId, command.classId, command.note);
    } else {
      const note = (await store.listNotes(userId, release.id)).find(
        (item) => item.noteId === command.noteId,
      );
      if (!note || note.expectedVersion !== command.expectedNoteVersion) {
        throw new LessonError(LessonFailure.STALE);
      }
      await store.deleteNote(userId, release.id, command.noteId);
    }
    await store.saveProgress(next, progress.version);
    return help ?? this.projectReply(store, userId, release, next);
  }

  private validateNoteAnchor(
    anchor: Extract<GuidedLessonCommand, { action: 'saveNote' }>['note']['anchor'],
    projection: LearnerProjection,
    record: LessonRecord,
  ): void {
    const endFrame = Math.max(
      1,
      ...projection.narrationCues.map((cue) => cue.endFrame),
      ...projection.visualCues.map((cue) => cue.endFrame),
    );
    if (
      anchor.releaseId !== projection.releaseId ||
      anchor.sceneId !== projection.sceneId ||
      anchor.phase !== projection.phase ||
      anchor.frame > endFrame ||
      (anchor.traceEventId &&
        !projection.visibleTraceStates.some((state) => state.eventId === anchor.traceEventId)) ||
      (anchor.sourceRef &&
        !record.input.passages.some(
          (passage) =>
            passage.passageId === anchor.sourceRef?.passageId &&
            anchor.sourceRef.startOffset >= 0 &&
            anchor.sourceRef.endOffset > anchor.sourceRef.startOffset &&
            anchor.sourceRef.endOffset <= passage.text.length,
        ))
    ) {
      throw new LessonError(LessonFailure.INVALID);
    }
  }

  private async answerQuestion(
    userId: string,
    command: Extract<GuidedLessonCommand, { action: 'help' }>,
  ): Promise<GuidedLessonReply> {
    const prepared = await this.store.runAtomically(async (store) => {
      await this.requireAccess(store, userId, command.classId);
      const receipt = await store.readReceipt(userId, command.commandId);
      if (receipt) {
        if (receipt.digest !== hashLessonValue(command)) {
          throw new LessonError(LessonFailure.STALE);
        }
        const release = await this.requireRelease(
          store,
          userId,
          command.classId,
          command.releaseId,
        );
        if (release.lessonId !== command.lessonId) {
          throw new LessonError(LessonFailure.FORBIDDEN);
        }
        const progress =
          (await store.readProgress(userId, release.id)) ?? createProgress(userId, release);
        const projection = projectLesson({ ...release.record, releaseId: release.id }, progress);
        const pending =
          projection.phase === LessonPhase.PREDICT || projection.phase === LessonPhase.TRY;
        const reply = pending
          ? await this.projectReply(store, userId, release, progress)
          : receipt.reply;
        return { reply, request: null, progress: null, budgetId: '' };
      }
      const release = await this.requireRelease(store, userId, command.classId, command.releaseId);
      if (release.lessonId !== command.lessonId) {
        throw new LessonError(LessonFailure.FORBIDDEN);
      }
      const progress =
        (await store.readProgress(userId, release.id)) ?? createProgress(userId, release);
      if (
        progress.version !== command.expectedProgressVersion ||
        progress.sceneId !== command.sceneId
      ) {
        throw new LessonError(LessonFailure.STALE);
      }
      const projection = projectLesson({ ...release.record, releaseId: release.id }, progress);
      const pending =
        projection.phase === LessonPhase.PREDICT || projection.phase === LessonPhase.TRY;
      if (pending) {
        const reply = await this.executeLearnerCommand(store, userId, command);
        await store.saveReceipt(userId, command.classId, command.commandId, {
          digest: hashLessonValue(command),
          reply,
        });
        return { reply, request: null, progress: null, budgetId: '' };
      }
      const budgetId = `help:${userId}:${this.now().toISOString().slice(0, 10)}`;
      const budget = (await store.readBudget(budgetId)) ?? createLessonBudget(budgetId);
      if (
        budget.helpRequests >= 30 ||
        budget.helpTimes.filter((time) => time > this.now().getTime() - 60000).length >= 3 ||
        budget.reservations.some((item) => item.id === command.commandId)
      ) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      const visibleIds = new Set(
        release.record.plan?.scenes
          .find((scene) => scene.sceneId === progress.sceneId)
          ?.sourceRefs.map((ref) => ref.passageId),
      );
      const sourcePassages = release.record.input.passages.filter((passage) =>
        visibleIds.has(passage.passageId),
      );
      const request: LessonModelRequest = {
        stage: LessonModelStage.HELP,
        input: release.record.input,
        plan: null,
        review: null,
        manifest: null,
        evidence: [],
        contentHash: release.record.contentHash ?? '',
        maxOutputTokens: 1200,
        helpContext: {
          question: command.message,
          visibleProjection: projection,
          sourcePassages,
          history: command.history ?? [],
        },
      };
      await store.saveBudget(
        {
          ...budget,
          version: budget.version + 1,
          helpRequests: budget.helpRequests + 1,
          helpTimes: [...budget.helpTimes, this.now().getTime()],
          reservations: [
            ...budget.reservations,
            {
              id: command.commandId,
              runId: command.commandId,
              lessonId: release.lessonId,
              stage: 'help',
              input: 6000,
              output: 1200,
              speechCharacters: 0,
              state: LessonReservationState.RESERVED,
              actualInput: null,
              actualOutput: null,
            },
          ],
        },
        budget.version,
      );
      return { reply: null, request, progress, budgetId };
    });
    if (prepared.reply) {
      return prepared.reply;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, 60000);
    deadline.unref();
    let usage: { inputTokens: number; outputTokens: number } | null = {
      inputTokens: 0,
      outputTokens: 0,
    };
    let generated: GuidedLessonReply = {
      kind: 'help',
      result: {
        kind: 'insufficientContext',
        text: 'The lesson helper is unavailable. Your playback and notes are preserved.',
      },
    };
    try {
      const inputTokens = await this.model.countInput(prepared.request, controller.signal);
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > 6000) {
        throw new LessonError(LessonFailure.BUDGET);
      }
      await this.store.runAtomically(async (store) => {
        await this.requireRelease(store, userId, command.classId, command.releaseId);
        const currentProgress = await store.readProgress(userId, command.releaseId);
        if ((currentProgress?.version ?? 0) !== prepared.progress.version) {
          throw new LessonError(LessonFailure.STALE);
        }
        const budget = await store.readBudget(prepared.budgetId);
        if (!budget) {
          throw new LessonError(LessonFailure.STALE);
        }
        await store.saveBudget(
          {
            ...budget,
            version: budget.version + 1,
            reservations: budget.reservations.map((item) =>
              item.id === command.commandId
                ? { ...item, input: inputTokens, state: LessonReservationState.DISPATCHED }
                : item,
            ),
          },
          budget.version,
        );
      });
      usage = null;
      const response = await this.model.generate(prepared.request, controller.signal);
      const validatedUsage = LessonProviderUsageSchema.safeParse(response.usage);
      usage = validatedUsage.success ? validatedUsage.data : null;
      const result = HelpResultSchema.parse(response.result);
      if (
        result.kind === 'answer' &&
        result.sourceRefs.some(
          (ref) =>
            !prepared.request.helpContext?.sourcePassages.some(
              (passage) =>
                passage.passageId === ref.passageId &&
                ref.startOffset >= 0 &&
                ref.endOffset > ref.startOffset &&
                ref.endOffset <= passage.text.length,
            ),
        )
      ) {
        throw new LessonError(LessonFailure.INVALID);
      }
      generated = result.kind === 'hintSelection' ? generated : { kind: 'help', result };
    } catch (error: unknown) {
      if (error instanceof LessonProviderNotDispatchedError) {
        usage = { inputTokens: 0, outputTokens: 0 };
      }
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
    // Account for a completed physical request even if access is revoked while it runs.
    await this.store.runAtomically(async (store) => {
      const budget = await store.readBudget(prepared.budgetId);
      if (budget) {
        await store.saveBudget(
          {
            ...budget,
            version: budget.version + 1,
            reservations: budget.reservations.map((item) =>
              item.id === command.commandId
                ? {
                    ...item,
                    state: usage
                      ? LessonReservationState.SETTLED
                      : LessonReservationState.UNCERTAIN,
                    actualInput: usage?.inputTokens ?? null,
                    actualOutput: usage?.outputTokens ?? null,
                  }
                : item,
            ),
          },
          budget.version,
        );
      }
    });
    return this.store.runAtomically(async (store) => {
      await this.requireRelease(store, userId, command.classId, command.releaseId);
      const currentProgress = await store.readProgress(userId, command.releaseId);
      const currentVersion = currentProgress?.version ?? 0;
      const reply: GuidedLessonReply =
        currentVersion === prepared.progress.version
          ? generated
          : {
              kind: 'help',
              result: {
                kind: 'insufficientContext',
                text: 'Your lesson position changed. Ask again at the current step.',
              },
            };
      await store.saveReceipt(userId, command.classId, command.commandId, {
        digest: hashLessonValue(command),
        reply,
      });
      return reply;
    });
  }
}
