import { randomUUID } from 'node:crypto';
import { ClassroomPacing, ClassroomPhase, ClassroomStatus } from '#contracts/Classroom.js';
import {
  PracticeCheckStatus,
  PracticeFailure,
  PracticeLimits,
  PracticeEvaluationSchema,
  type PracticeCommand,
  type PracticeReply,
  type PracticeRecord,
} from '#contracts/PracticeCheck.js';
import { PracticeError, validatePracticeFindings } from '../domain/PracticeFindings.js';
import {
  describePracticeEvidence,
  hashPracticePayload,
  countPracticeInput,
} from './PracticeEvidence.js';
import type { PracticeAccess, PracticeCheckStore } from './PracticeCheckStore.js';
import type { PracticeCheckEvaluator } from './PracticeCheckEvaluator.js';
export interface PracticePolicy {
  dailyChecks: number;
  minuteChecks: number;
}

/** Reserves inference once, snapshots work, and fences late output against classroom changes. */
export class PracticeCheckService {
  constructor(
    private readonly store: PracticeCheckStore,
    private readonly evaluator: PracticeCheckEvaluator,
    private readonly policy: PracticePolicy,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (event: {
      checkId: string;
      stage: string;
      code?: string;
    }) => void = () => {},
  ) {}
  async execute(userId: string, command: PracticeCommand): Promise<PracticeReply> {
    if (command.kind === 'teacher-history') {
      const history = await this.store.readTeacherHistory(userId, command.classSessionId);
      if (!history) {
        throw new PracticeError(PracticeFailure.FORBIDDEN);
      }
      return history;
    }
    if (command.kind === 'read-evidence') {
      const stored = await this.store.readCheck(command.checkId);
      const access = stored ? await this.store.readEvidenceAccess(stored.record.attemptId) : null;
      if (
        !stored ||
        !access ||
        access.deleted ||
        (userId !== access.teacherId && (userId !== access.studentId || !access.enrolled))
      ) {
        throw new PracticeError(PracticeFailure.FORBIDDEN);
      }
      return {
        kind: 'evidence',
        evidence: await this.store.readEvidence(stored.record.snapshotId),
      };
    }
    if (command.kind === 'help') {
      const access = await this.store.readAccess(command.participationId, command.activityId);
      requireStudentAccess(access, userId);
      const stored = await this.store.readCheck(command.checkId);
      const check = stored?.record;
      const criterion = check?.rubric.criteria.find((item) => item.id === command.criterionId);
      const result = check?.results.find((item) => item.criterionId === command.criterionId);
      if (
        !check ||
        !criterion ||
        !result ||
        check.status !== PracticeCheckStatus.COMPLETED ||
        check.attemptId !== access.attemptId ||
        access.deviceId !== command.deviceId ||
        access.left ||
        access.leaseUntil <= this.now() ||
        access.status !== ClassroomStatus.LIVE ||
        access.phase !== ClassroomPhase.PRACTICE ||
        (access.pacing === ClassroomPacing.TEACHER &&
          access.currentActivityId !== command.activityId) ||
        !access.activity.practiceCheckpoints?.some(
          (item) =>
            item.id === check.checkpointId &&
            item.rubricRevisionId === check.rubric.rubricRevisionId &&
            item.approved,
        )
      ) {
        throw new PracticeError(PracticeFailure.STALE);
      }
      return {
        kind: 'help',
        message:
          command.locale === 'vi'
            ? `Giúp tôi tự cải thiện bài thực hành này. Hãy quan sát bài hiện tại trước khi hướng dẫn; đây là phản hồi cho một phiên bản cũ, không phải bằng chứng về bài hiện tại. Nhiệm vụ: ${check.rubric.task}\nTiêu chí đã duyệt: ${criterion.description}\nBằng chứng cần: ${criterion.evidenceNeeded}\nPhản hồi kiểm tra: ${result.feedback}\nChỉ gợi ý cho phần này; tôi sẽ tự thực hiện và kiểm tra lại. Không thay đổi tiêu chí, kết quả hay nộp bài.`
            : `Help me improve this practice work myself. Observe my current work before guiding me; this feedback describes an earlier snapshot, not current evidence. Task: ${check.rubric.task}\nApproved criterion: ${criterion.description}\nEvidence needed: ${criterion.evidenceNeeded}\nCheck feedback: ${result.feedback}\nGive a hint for this gap; I will perform the actions and check again. Do not change the rubric, result or submit work.`,
      };
    }
    if (command.kind === 'history') {
      const access = await this.store.readAccess(command.participationId, command.activityId);
      requireStudentAccess(access, userId);
      const history = await this.store.readHistory(access.attemptId);
      for (const check of history.checks) {
        if (
          check.status === PracticeCheckStatus.RUNNING &&
          Date.parse(check.createdAt) + PracticeLimits.LEASE_MS < this.now().getTime()
        ) {
          check.status = PracticeCheckStatus.FAILED;
          check.completedAt = this.now().toISOString();
          await this.store.runAtomically((store) => store.finishCheck(check));
        }
      }
      return history;
    }
    if (command.kind === 'submit-snapshot') {
      return this.store.runAtomically(async (store) => {
        const access = await store.readAccess(command.participationId, command.activityId);
        requireStudentAccess(access, userId);
        const digest = hashPracticePayload({
          checkId: command.checkId,
          participationId: command.participationId,
          activityId: command.activityId,
        });
        const existing = await store.findSubmission(userId, command.requestId);
        if (existing) {
          if (
            existing.payloadDigest !== digest ||
            existing.submission.attemptId !== access.attemptId
          ) {
            throw new PracticeError(PracticeFailure.STALE);
          }
          return { kind: 'submitted', submission: existing.submission };
        }
        requireCurrentPractice(access, command, this.now());
        const check = await store.readCheck(command.checkId);
        if (
          !check ||
          check.record.attemptId !== access.attemptId ||
          check.record.status !== PracticeCheckStatus.COMPLETED ||
          !access.activity.practiceCheckpoints?.some(
            (item) =>
              item.id === check.record.checkpointId &&
              item.approved &&
              item.rubricRevisionId === check.record.rubric.rubricRevisionId,
          )
        ) {
          throw new PracticeError(PracticeFailure.FORBIDDEN);
        }
        return {
          kind: 'submitted',
          submission: await store.createSubmission(
            userId,
            command.requestId,
            digest,
            check.record,
            this.now(),
          ),
        };
      });
    }
    const metadata = describePracticeEvidence(command.evidence);
    const digest = hashPracticePayload({
      participationId: command.participationId,
      activityId: command.activityId,
      checkpointId: command.checkpointId,
      locale: command.locale,
      evidence: metadata,
    });
    const admitted = await this.store.runAtomically(async (store) => {
      const access = await store.readAccess(command.participationId, command.activityId);
      requireStudentAccess(access, userId);
      const existing = await store.findCheck(userId, command.requestId);
      if (existing) {
        if (existing.payloadDigest !== digest || existing.record.attemptId !== access.attemptId) {
          throw new PracticeError(PracticeFailure.STALE);
        }
        return { record: existing.record, created: false };
      }
      requireCurrentPractice(access, command, this.now());
      const rubric = access.activity.practiceCheckpoints?.find(
        (item) => item.id === command.checkpointId && item.approved,
      );
      if (!rubric) {
        throw new PracticeError(PracticeFailure.FORBIDDEN);
      }
      if (countPracticeInput(rubric, command.evidence) > PracticeLimits.INPUT_TOKENS) {
        throw new PracticeError(PracticeFailure.INVALID);
      }
      if (!this.evaluator.available) {
        throw new PracticeError(PracticeFailure.UNAVAILABLE);
      }
      if (
        (await store.readStoredEvidenceBytes(userId)) +
          metadata.reduce((sum, item) => sum + item.byteCount, 0) >
        PracticeLimits.PRIVATE_BYTES
      ) {
        throw new PracticeError(PracticeFailure.LIMIT);
      }
      const now = this.now();
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      if (
        (await store.countChecks(userId, day)) >= this.policy.dailyChecks ||
        (await store.countChecks(userId, new Date(now.getTime() - 60000))) >=
          this.policy.minuteChecks
      ) {
        throw new PracticeError(PracticeFailure.LIMIT);
      }
      const record: PracticeRecord = {
        id: randomUUID(),
        requestId: command.requestId,
        snapshotId: randomUUID(),
        attemptId: access.attemptId,
        checkpointId: rubric.id,
        rubric,
        status: PracticeCheckStatus.RUNNING,
        finding: null,
        results: [],
        evaluator: this.evaluator.version,
        createdAt: now.toISOString(),
        completedAt: null,
        evidence: metadata,
      };
      await store.createCheck(userId, access.courseRevisionId, digest, record, command.evidence);
      return { record, created: true };
    });
    if (!admitted.created) {
      return { kind: 'check', check: admitted.record };
    }
    const record = admitted.record;
    this.log({ checkId: record.id, stage: 'admitted' });
    try {
      const signal = AbortSignal.timeout(60000);
      const access = await this.store.readAccess(command.participationId, command.activityId);
      requireStudentAccess(access, userId);
      requireCurrentPractice(access, command, this.now());
      const grounding = await this.store.readGrounding(access, record.rubric);
      if (
        countPracticeInput({ rubric: record.rubric, grounding }, command.evidence) >
        PracticeLimits.INPUT_TOKENS
      ) {
        throw new PracticeError(PracticeFailure.LIMIT);
      }
      const evaluation = PracticeEvaluationSchema.parse(
        await this.evaluator.evaluate(record.rubric, command.evidence, command.locale, signal, {
          grounding,
          units: [],
        }),
      );
      signal.throwIfAborted();
      const finding = validatePracticeFindings(
        record.rubric,
        evaluation,
        metadata.map((item) => item.id),
      );
      await this.store.runAtomically(async (store) => {
        const access = await store.readAccess(command.participationId, command.activityId);
        requireStudentAccess(access, userId);
        requireCurrentPractice(access, command, this.now());
        if (this.now().getTime() > Date.parse(record.createdAt) + PracticeLimits.LEASE_MS) {
          throw new PracticeError(PracticeFailure.STALE);
        }
        record.status = PracticeCheckStatus.COMPLETED;
        record.finding = finding;
        record.results = evaluation.results;
        if (evaluation.assessment) {
          record.assessment = evaluation.assessment;
        }
        record.completedAt = this.now().toISOString();
        if (!(await store.finishCheck(record))) {
          throw new PracticeError(PracticeFailure.STALE);
        }
      });
      this.log({ checkId: record.id, stage: 'completed' });
    } catch (error: unknown) {
      record.status = PracticeCheckStatus.FAILED;
      record.finding = null;
      record.results = [];
      record.completedAt = this.now().toISOString();
      await this.store.runAtomically((store) => store.finishCheck(record));
      this.log({
        checkId: record.id,
        stage: 'failed',
        code: error instanceof PracticeError ? error.code : PracticeFailure.UNAVAILABLE,
      });
    }
    const saved = await this.store.readCheck(record.id);
    return { kind: 'check', check: saved?.record ?? record };
  }
}

function requireStudentAccess(
  access: PracticeAccess | null,
  userId: string,
): asserts access is PracticeAccess {
  if (!access || access.studentId !== userId || !access.enrolled || access.deleted) {
    throw new PracticeError(PracticeFailure.FORBIDDEN);
  }
}

function requireCurrentPractice(
  access: PracticeAccess,
  command: Extract<PracticeCommand, { kind: 'check' | 'submit-snapshot' }>,
  now: Date,
): void {
  if (
    access.left ||
    access.deviceId !== command.deviceId ||
    access.leaseUntil <= now ||
    access.status !== ClassroomStatus.LIVE ||
    access.phase !== ClassroomPhase.PRACTICE ||
    access.contextVersion !== command.contextVersion ||
    access.progressVersion !== command.progressVersion ||
    (access.pacing === ClassroomPacing.TEACHER && access.currentActivityId !== command.activityId)
  ) {
    throw new PracticeError(PracticeFailure.STALE);
  }
}
