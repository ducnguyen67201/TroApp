import type { PracticeGrounding } from '#contracts/PracticeAssessment.js';
import { randomUUID } from 'node:crypto';
import {
  PracticeCheckStatus,
  type PracticeCheckpoint,
  type PracticeEvidence,
  type PracticeRecord,
  type PracticeReply,
  type WorkSubmission,
} from '#contracts/PracticeCheck.js';
import type {
  PracticeAccess,
  PracticeCheckStore,
  StoredPracticeCheck,
} from '../../../../src/server/features/classroom/application/PracticeCheckStore.js';
import { createTeachingContext } from './ClassroomFixtures.js';
export function createPracticeCheckpoint(): PracticeCheckpoint {
  return {
    id: randomUUID(),
    rubricRevisionId: randomUUID(),
    title: 'Print a greeting',
    task: 'Print Hello',
    approved: true,
    origin: 'suggestion',
    criteria: [
      {
        id: randomUUID(),
        description: 'A greeting is present',
        required: true,
        evidenceNeeded: 'Visible greeting text',
        sourceIds: [],
      },
      {
        id: randomUUID(),
        description: 'Optional color',
        required: false,
        evidenceNeeded: 'Rendered color',
        sourceIds: [],
      },
    ],
  };
}

export function createPracticeAccess(): PracticeAccess {
  const context = createTeachingContext();
  return {
    studentId: 'student',
    teacherId: 'teacher',
    classId: context.meeting.classId,
    deleted: false,
    enrolled: true,
    deviceId: context.participation.deviceId,
    leaseUntil: new Date('2030-01-01'),
    left: false,
    status: 'live',
    phase: 'practice',
    pacing: 'teacher',
    currentActivityId: context.activity.id,
    contextVersion: 1,
    progressVersion: 0,
    attemptId: context.attempt.id,
    participationId: context.participation.id,
    courseRevisionId: context.courseRevisionId,
    activity: { ...context.activity, practiceCheckpoints: [createPracticeCheckpoint()] },
  };
}

/** Typed test port; PostgreSQL tests verify the actual transaction/isolation behavior. */
export class MemoryPracticeStore implements PracticeCheckStore {
  access = createPracticeAccess();
  checks = new Map<string, StoredPracticeCheck>();
  evidence = new Map<string, PracticeEvidence[]>();
  submissions = new Map<string, { submission: WorkSubmission; payloadDigest: string }>();
  readGrounding(access: PracticeAccess, rubric: PracticeCheckpoint): Promise<PracticeGrounding> {
    return Promise.resolve({
      courseRevisionId: access.courseRevisionId,
      teacherInstructions: '',
      sources: [],
      missingSourceIds: rubric.criteria.flatMap((item) => item.sourceIds),
    });
  }
  private queue: Promise<unknown> = Promise.resolve();
  runAtomically<T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => work(this));
    this.queue = result.catch(() => {});
    return result;
  }
  readAccess(participationId: string, activityId: string): Promise<PracticeAccess | null> {
    return Promise.resolve(
      participationId === this.access.participationId && activityId === this.access.activity.id
        ? structuredClone(this.access)
        : null,
    );
  }
  readEvidenceAccess(attemptId: string): Promise<PracticeAccess | null> {
    return Promise.resolve(
      attemptId === this.access.attemptId ? structuredClone(this.access) : null,
    );
  }
  readCheck(id: string): Promise<StoredPracticeCheck | null> {
    return Promise.resolve(structuredClone(this.checks.get(id) ?? null));
  }
  findCheck(studentId: string, requestId: string): Promise<StoredPracticeCheck | null> {
    return Promise.resolve(
      studentId === this.access.studentId
        ? structuredClone(
            [...this.checks.values()].find((item) => item.record.requestId === requestId) ?? null,
          )
        : null,
    );
  }
  countChecks(studentId: string, since: Date): Promise<number> {
    return Promise.resolve(
      studentId === this.access.studentId
        ? [...this.checks.values()].filter((item) => new Date(item.record.createdAt) >= since)
            .length
        : 0,
    );
  }
  readStoredEvidenceBytes(studentId: string): Promise<number> {
    return Promise.resolve(
      (studentId === this.access.studentId ? [...this.checks.values()] : [])
        .flatMap((item) => item.record.evidence)
        .reduce((sum, item) => sum + item.byteCount, 0),
    );
  }
  createCheck(
    _studentId: string,
    _courseRevisionId: string,
    payloadDigest: string,
    record: PracticeRecord,
    evidence: PracticeEvidence[],
  ): Promise<void> {
    this.checks.set(record.id, structuredClone({ record, payloadDigest }));
    this.evidence.set(record.snapshotId, structuredClone(evidence));
    return Promise.resolve();
  }
  finishCheck(record: PracticeRecord): Promise<boolean> {
    const stored = this.checks.get(record.id);
    if (!stored || stored.record.status !== PracticeCheckStatus.RUNNING) {
      return Promise.resolve(false);
    }
    this.checks.set(record.id, structuredClone({ ...stored, record }));
    return Promise.resolve(true);
  }
  readEvidence(snapshotId: string): Promise<PracticeEvidence[]> {
    return Promise.resolve(structuredClone(this.evidence.get(snapshotId) ?? []));
  }
  readHistory(attemptId: string): Promise<Extract<PracticeReply, { kind: 'history' }>> {
    return Promise.resolve({
      kind: 'history',
      checks: structuredClone(
        [...this.checks.values()]
          .map((item) => item.record)
          .filter((item) => item.attemptId === attemptId),
      ),
      submissions: structuredClone(
        [...this.submissions.values()]
          .map((item) => item.submission)
          .filter((item) => item.attemptId === attemptId),
      ),
    });
  }
  findSubmission(
    studentId: string,
    requestId: string,
  ): Promise<{ submission: WorkSubmission; payloadDigest: string } | null> {
    return Promise.resolve(
      structuredClone(this.submissions.get(`${studentId}:${requestId}`) ?? null),
    );
  }
  createSubmission(
    studentId: string,
    requestId: string,
    payloadDigest: string,
    check: PracticeRecord,
    now: Date,
  ): Promise<WorkSubmission> {
    const submission: WorkSubmission = {
      id: randomUUID(),
      studentId,
      attemptId: check.attemptId,
      checkpointId: check.checkpointId,
      snapshotId: check.snapshotId,
      checkId: check.id,
      sequence:
        [...this.submissions.values()].filter(
          (item) => item.submission.checkpointId === check.checkpointId,
        ).length + 1,
      submittedAt: now.toISOString(),
    };
    this.submissions.set(`${studentId}:${requestId}`, { submission, payloadDigest });
    return Promise.resolve(submission);
  }
  async readTeacherHistory(
    userId: string,
    sessionId: string,
  ): Promise<Extract<PracticeReply, { kind: 'teacher-history' }> | null> {
    if (!sessionId || userId !== this.access.teacherId) {
      return null;
    }
    const history = await this.readHistory(this.access.attemptId);
    return {
      kind: 'teacher-history',
      students: [
        {
          studentId: this.access.studentId,
          name: 'Student',
          checks: history.checks,
          submissions: history.submissions,
        },
      ],
    };
  }
}
