import { hasClassroomLearningCapture } from '../features/classroom/application/ClassroomInsightPolicy.js';
import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';
import { InsightRecordKind } from '#contracts/ClassroomInsights.js';
import {
  capturePracticeAssessment,
  captureClassroomSubmission,
} from './CaptureClassroomLearning.js';
import {
  DisabledLearningCapture,
  type LearningCapturePolicy,
} from './AppendClassroomLearningEvent.js';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { CourseContentSchema } from '#contracts/Classroom.js';
import {
  PracticeCheckStatus,
  PracticeEvidenceSchema,
  PracticeRecordSchema,
  WorkSubmissionSchema,
  type PracticeRecord,
  type PracticeEvidence,
  type WorkSubmission,
  type PracticeReply,
} from '#contracts/PracticeCheck.js';
import type {
  PracticeAccess,
  PracticeCheckStore,
  StoredPracticeCheck,
} from '../features/classroom/application/PracticeCheckStore.js';
import { hashPracticePayload } from '../features/classroom/application/PracticeEvidence.js';
const checkInclude = {
  results: true,
  snapshot: {
    include: {
      evidence: {
        select: { id: true, kind: true, name: true, byteCount: true, digest: true },
        orderBy: { id: 'asc' as const },
      },
    },
  },
} satisfies Prisma.ClassroomPracticeCheckInclude;
type CheckRow = Prisma.ClassroomPracticeCheckGetPayload<{ include: typeof checkInclude }>;
const accessInclude = {
  participation: {
    include: {
      meeting: {
        include: { schoolClass: { include: { courseRevision: true, enrollments: true } } },
      },
    },
  },
} satisfies Prisma.ClassroomAttemptInclude;
type AccessRow = Prisma.ClassroomAttemptGetPayload<{ include: typeof accessInclude }>;

function readAccessRow(row: AccessRow | null): PracticeAccess | null {
  if (!row) {
    return null;
  }
  const participation = row.participation,
    meeting = participation.meeting,
    schoolClass = meeting.schoolClass;
  const content = CourseContentSchema.parse(schoolClass.courseRevision.content);
  const activity = content.modules
    .flatMap((module) => module.lessons.flatMap((lesson) => lesson.activities))
    .find((item) => item.id === row.activityId);
  if (!activity) {
    return null;
  }
  return {
    studentId: participation.studentId,
    teacherId: schoolClass.teacherId,
    classId: schoolClass.id,
    deleted: schoolClass.deletedAt !== null,
    enrolled: schoolClass.enrollments.some(
      (enrollment) => enrollment.studentId === participation.studentId && enrollment.active,
    ),
    deviceId: participation.deviceId,
    leaseUntil: participation.leaseUntil,
    left: participation.left,
    status: meeting.status,
    phase: meeting.phase,
    pacing: meeting.pacing,
    currentActivityId: meeting.currentActivityId,
    contextVersion: meeting.contextVersion,
    progressVersion: row.progressVersion,
    attemptId: row.id,
    participationId: participation.id,
    courseRevisionId: schoolClass.courseRevisionId,
    activity,
  };
}

function projectCheck(row: CheckRow): StoredPracticeCheck {
  // Build the public shape explicitly; persistence columns and binary content never leak.
  return {
    payloadDigest: row.payloadDigest,
    record: PracticeRecordSchema.parse({
      id: row.id,
      requestId: row.requestId,
      snapshotId: row.snapshotId,
      attemptId: row.attemptId,
      checkpointId: row.checkpointId,
      rubric: row.rubric,
      status: row.status,
      finding: row.finding,
      evaluator: row.evaluator,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      results: row.results.map((result) => ({
        criterionId: result.criterionId,
        finding: result.finding,
        feedback: result.feedback,
        evidenceIds: result.evidenceIds,
      })),
      evidence: row.snapshot.evidence,
    }),
  };
}

function projectSubmission(row: Prisma.ClassroomWorkSubmissionGetPayload<object>): WorkSubmission {
  return WorkSubmissionSchema.parse({
    id: row.id,
    studentId: row.studentId,
    attemptId: row.attemptId,
    checkpointId: row.checkpointId,
    snapshotId: row.snapshotId,
    checkId: row.checkId,
    sequence: row.sequence,
    submittedAt: row.submittedAt.toISOString(),
  });
}

class PrismaPracticeCheckStore implements PracticeCheckStore {
  constructor(
    private readonly client: Prisma.TransactionClient,
    private readonly transact: <T>(work: (store: PracticeCheckStore) => Promise<T>) => Promise<T>,
    private readonly capturePolicy: LearningCapturePolicy = DisabledLearningCapture,
    private readonly inTransaction = false,
  ) {}
  runAtomically<T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T> {
    return this.transact(work);
  }
  async readAccess(participationId: string, activityId: string): Promise<PracticeAccess | null> {
    const row = await this.client.classroomAttempt.findUnique({
      where: { participationId_activityId: { participationId, activityId } },
      include: accessInclude,
    });
    const access = readAccessRow(row);
    return access && row && (await this.hasRemovedSources(row.id))
      ? { ...access, enrolled: false }
      : access;
  }
  /** Historical evidence authorization depends on class membership, not today's course content. */
  async readEvidenceAccess(
    attemptId: string,
  ): Promise<Pick<PracticeAccess, 'studentId' | 'teacherId' | 'deleted' | 'enrolled'> | null> {
    const row = await this.client.classroomAttempt.findUnique({
      where: { id: attemptId },
      select: {
        participation: {
          select: {
            studentId: true,
            meeting: {
              select: {
                schoolClass: {
                  select: {
                    teacherId: true,
                    deletedAt: true,
                    enrollments: { select: { studentId: true, active: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row) {
      return null;
    }
    const schoolClass = row.participation.meeting.schoolClass;
    return {
      studentId: row.participation.studentId,
      teacherId: schoolClass.teacherId,
      deleted: schoolClass.deletedAt !== null,
      enrolled:
        !(await this.hasRemovedSources(attemptId)) &&
        schoolClass.enrollments.some(
          (enrollment) => enrollment.studentId === row.participation.studentId && enrollment.active,
        ),
    };
  }
  private async hasRemovedSources(attemptId: string) {
    const attempt = await this.client.classroomAttempt.findUnique({
      where: { id: attemptId },
      include: { participation: { include: { meeting: true } } },
    });
    return Boolean(
      attempt &&
      (await this.client.classroomInsightRecord.findFirst({
        where: {
          classId: attempt.participation.meeting.classId,
          kind: InsightRecordKind.REMOVAL,
          studentId: attempt.participation.studentId,
        },
      })),
    );
  }
  private async hasExpiredSnapshot(snapshotId: string) {
    const row = await this.client.classroomWorkSnapshot.findUnique({
      where: { id: snapshotId },
      include: { attempt: { include: { participation: { include: { meeting: true } } } } },
    });
    return Boolean(
      row &&
      (row.expiredAt ||
        (await this.client.classroomExpiredSource.findUnique({
          where: {
            classId_sourceId: {
              classId: row.attempt.participation.meeting.classId,
              sourceId: snapshotId,
            },
          },
        }))),
    );
  }
  private async projectVisibleChecks(rows: CheckRow[]) {
    const checks: PracticeRecord[] = [];
    for (const row of rows) {
      if (!(await this.hasExpiredSnapshot(row.snapshotId))) {
        checks.push(projectCheck(row).record);
      }
    }
    return checks;
  }
  async readCheck(id: string): Promise<StoredPracticeCheck | null> {
    const row = await this.client.classroomPracticeCheck.findUnique({
      where: { id },
      include: checkInclude,
    });
    return row &&
      !(await this.hasRemovedSources(row.attemptId)) &&
      !(await this.hasExpiredSnapshot(row.snapshotId))
      ? projectCheck(row)
      : null;
  }
  async findCheck(studentId: string, requestId: string): Promise<StoredPracticeCheck | null> {
    const row = await this.client.classroomPracticeCheck.findUnique({
      where: { studentId_requestId: { studentId, requestId } },
      include: checkInclude,
    });
    return row &&
      !(await this.hasRemovedSources(row.attemptId)) &&
      !(await this.hasExpiredSnapshot(row.snapshotId))
      ? projectCheck(row)
      : null;
  }
  countChecks(studentId: string, since: Date): Promise<number> {
    return this.client.classroomPracticeCheck.count({
      where: { studentId, createdAt: { gte: since } },
    });
  }
  async readStoredEvidenceBytes(studentId: string): Promise<number> {
    const result = await this.client.classroomPracticeEvidence.aggregate({
      where: { snapshot: { studentId } },
      _sum: { byteCount: true },
    });
    return result._sum.byteCount ?? 0;
  }
  async createCheck(
    studentId: string,
    courseRevisionId: string,
    payloadDigest: string,
    record: PracticeRecord,
    evidence: PracticeEvidence[],
  ): Promise<void> {
    if (!this.inTransaction && hasClassroomLearningCapture(this.capturePolicy)) {
      return this.runAtomically((store) =>
        store.createCheck(studentId, courseRevisionId, payloadDigest, record, evidence),
      );
    }
    await this.client.classroomWorkSnapshot.create({
      data: {
        id: record.snapshotId,
        studentId,
        courseRevisionId,
        attemptId: record.attemptId,
        checkpointId: record.checkpointId,
        rubricRevisionId: record.rubric.rubricRevisionId,
        manifestDigest: hashPracticePayload(record.evidence),
        createdAt: new Date(record.createdAt),
        evidence: {
          create: evidence.map((item) => {
            const metadata = record.evidence.find((entry) => entry.id === item.id);
            if (!metadata) {
              throw new Error('Missing evidence metadata.');
            }
            return {
              id: item.id,
              kind: item.kind,
              name: item.name,
              mediaType: item.kind === 'text' ? 'text/plain' : item.mediaType,
              byteCount: metadata.byteCount,
              digest: metadata.digest,
              content:
                item.kind === 'text'
                  ? Buffer.from(item.text, 'utf8')
                  : Buffer.from(item.base64, 'base64'),
            };
          }),
        },
      },
    });
    await this.client.classroomPracticeCheck.create({
      data: {
        id: record.id,
        studentId,
        attemptId: record.attemptId,
        checkpointId: record.checkpointId,
        snapshotId: record.snapshotId,
        requestId: record.requestId,
        payloadDigest,
        rubric: record.rubric,
        status: record.status,
        finding: null,
        evaluator: record.evaluator,
        createdAt: new Date(record.createdAt),
      },
    });
    await capturePracticeAssessment(this.client, this.capturePolicy, record);
  }
  async finishCheck(record: PracticeRecord): Promise<boolean> {
    if (
      (await this.hasRemovedSources(record.attemptId)) ||
      (await this.hasExpiredSnapshot(record.snapshotId))
    ) {
      return false;
    }
    if (!this.inTransaction && hasClassroomLearningCapture(this.capturePolicy)) {
      return this.runAtomically((store) => store.finishCheck(record));
    }
    const changed = await this.client.classroomPracticeCheck.updateMany({
      where: { id: record.id, status: PracticeCheckStatus.RUNNING },
      data: {
        status: record.status,
        finding: record.finding,
        completedAt: record.completedAt ? new Date(record.completedAt) : null,
      },
    });
    if (changed.count !== 1) {
      return false;
    }
    if (record.results.length) {
      await this.client.classroomPracticeResult.createMany({
        data: record.results.map((result) => ({ ...result, checkId: record.id })),
      });
    }
    await capturePracticeAssessment(this.client, this.capturePolicy, record);
    return true;
  }
  async readEvidence(snapshotId: string): Promise<PracticeEvidence[]> {
    const snapshot = await this.client.classroomWorkSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (
      !snapshot ||
      (await this.hasRemovedSources(snapshot.attemptId)) ||
      (await this.hasExpiredSnapshot(snapshotId))
    ) {
      return [];
    }
    const rows = await this.client.classroomPracticeEvidence.findMany({
      where: { snapshotId },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) =>
      PracticeEvidenceSchema.parse(
        row.kind === 'text'
          ? {
              id: row.id,
              kind: 'text',
              name: row.name,
              text: Buffer.from(row.content).toString('utf8'),
            }
          : {
              id: row.id,
              kind: 'image',
              name: row.name,
              mediaType: row.mediaType,
              base64: Buffer.from(row.content).toString('base64'),
            },
      ),
    );
  }
  async readHistory(attemptId: string): Promise<Extract<PracticeReply, { kind: 'history' }>> {
    if (await this.hasRemovedSources(attemptId)) {
      return { kind: 'history', checks: [], submissions: [] };
    }
    const checks = await this.client.classroomPracticeCheck.findMany({
      where: { attemptId },
      include: checkInclude,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const submissions = await this.client.classroomWorkSubmission.findMany({
      where: { attemptId },
      orderBy: { submittedAt: 'desc' },
      take: 20,
    });
    return {
      kind: 'history',
      checks: await this.projectVisibleChecks(checks),
      submissions: submissions.map(projectSubmission),
    };
  }
  async findSubmission(
    studentId: string,
    requestId: string,
  ): Promise<{ submission: WorkSubmission; payloadDigest: string } | null> {
    const row = await this.client.classroomWorkSubmission.findUnique({
      where: { studentId_requestId: { studentId, requestId } },
    });
    return row ? { submission: projectSubmission(row), payloadDigest: row.payloadDigest } : null;
  }
  async createSubmission(
    studentId: string,
    requestId: string,
    payloadDigest: string,
    check: PracticeRecord,
    now: Date,
  ): Promise<WorkSubmission> {
    if (!this.inTransaction && hasClassroomLearningCapture(this.capturePolicy)) {
      return this.runAtomically((store) =>
        store.createSubmission(studentId, requestId, payloadDigest, check, now),
      );
    }
    const previous = await this.client.classroomWorkSubmission.aggregate({
      where: { attemptId: check.attemptId, checkpointId: check.checkpointId },
      _max: { sequence: true },
    });
    const row = await this.client.classroomWorkSubmission.create({
      data: {
        id: randomUUID(),
        studentId,
        requestId,
        payloadDigest,
        attemptId: check.attemptId,
        checkpointId: check.checkpointId,
        snapshotId: check.snapshotId,
        checkId: check.id,
        sequence: (previous._max.sequence ?? 0) + 1,
        submittedAt: now,
      },
    });
    const snapshot = await this.client.classroomWorkSnapshot.findUniqueOrThrow({
      where: { id: check.snapshotId },
    });
    await captureClassroomSubmission(
      this.client,
      this.capturePolicy,
      row.id,
      row.attemptId,
      row.submittedAt,
      row.snapshotId,
      row.checkId,
      snapshot.courseRevisionId,
    );
    return projectSubmission(row);
  }
  async readTeacherHistory(
    userId: string,
    sessionId: string,
  ): Promise<Extract<PracticeReply, { kind: 'teacher-history' }> | null> {
    const meeting = await this.client.classroomMeeting.findFirst({
      where: { id: sessionId, schoolClass: { teacherId: userId, deletedAt: null } },
      include: {
        participations: {
          where: {
            student: {
              classEnrollments: {
                some: { active: true, schoolClass: { meetings: { some: { id: sessionId } } } },
              },
            },
          },
          include: { student: { select: { name: true } }, attempts: { select: { id: true } } },
          take: 100,
        },
      },
    });
    if (!meeting) {
      return null;
    }
    const students = [];
    for (const participation of meeting.participations) {
      if (
        await this.client.classroomInsightRecord.findFirst({
          where: {
            classId: meeting.classId,
            kind: InsightRecordKind.REMOVAL,
            studentId: participation.studentId,
          },
        })
      ) {
        continue;
      }
      const checks = await this.client.classroomPracticeCheck.findMany({
        where: {
          studentId: participation.studentId,
          attempt: { participationId: participation.id },
        },
        include: checkInclude,
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const submissions = await this.client.classroomWorkSubmission.findMany({
        where: {
          studentId: participation.studentId,
          attempt: { participationId: participation.id },
        },
        orderBy: { submittedAt: 'desc' },
        take: 20,
      });
      students.push({
        studentId: participation.studentId,
        name: participation.student.name,
        checks: await this.projectVisibleChecks(checks),
        submissions: submissions.map(projectSubmission),
      });
    }
    return { kind: 'teacher-history', students };
  }
}
/** Private bounded evidence stays in PostgreSQL in this pilot; no public URL or filesystem capability. */
export function createPrismaPracticeCheckStore(
  databaseUrl: string,
  capturePolicy: LearningCapturePolicy = DisabledLearningCapture,
): {
  store: PracticeCheckStore;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const transact = <T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T> =>
    runClassroomTransactionWithRetries(
      () =>
        client.$transaction(
          async (transaction) => {
            const nested: PracticeCheckStore = new PrismaPracticeCheckStore(
              transaction,
              <Result>(
                operation: (store: PracticeCheckStore) => Promise<Result>,
              ): Promise<Result> => operation(nested),
              capturePolicy,
              true,
            );
            return work(nested);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      { operation: 'practice-check-write' },
    );
  return {
    store: new PrismaPracticeCheckStore(client, transact, capturePolicy),
    close: () => client.$disconnect(),
  };
}
