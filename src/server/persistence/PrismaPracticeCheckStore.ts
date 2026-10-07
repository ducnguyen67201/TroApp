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
  ) {}
  runAtomically<T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T> {
    return this.transact(work);
  }
  async readAccess(participationId: string, activityId: string): Promise<PracticeAccess | null> {
    return readAccessRow(
      await this.client.classroomAttempt.findUnique({
        where: { participationId_activityId: { participationId, activityId } },
        include: accessInclude,
      }),
    );
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
      enrolled: schoolClass.enrollments.some(
        (enrollment) => enrollment.studentId === row.participation.studentId && enrollment.active,
      ),
    };
  }
  async readCheck(id: string): Promise<StoredPracticeCheck | null> {
    const row = await this.client.classroomPracticeCheck.findUnique({
      where: { id },
      include: checkInclude,
    });
    return row ? projectCheck(row) : null;
  }
  async findCheck(studentId: string, requestId: string): Promise<StoredPracticeCheck | null> {
    const row = await this.client.classroomPracticeCheck.findUnique({
      where: { studentId_requestId: { studentId, requestId } },
      include: checkInclude,
    });
    return row ? projectCheck(row) : null;
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
  }
  async finishCheck(record: PracticeRecord): Promise<boolean> {
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
    return true;
  }
  async readEvidence(snapshotId: string): Promise<PracticeEvidence[]> {
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
      checks: checks.map((row) => projectCheck(row).record),
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
        checks: checks.map((row) => projectCheck(row).record),
        submissions: submissions.map(projectSubmission),
      });
    }
    return { kind: 'teacher-history', students };
  }
}
/** Private bounded evidence stays in PostgreSQL in this pilot; no public URL or filesystem capability. */
export function createPrismaPracticeCheckStore(databaseUrl: string): {
  store: PracticeCheckStore;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const transact = async <T>(work: (store: PracticeCheckStore) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.$transaction(
          async (transaction) => {
            const nested: PracticeCheckStore = new PrismaPracticeCheckStore(
              transaction,
              <Result>(
                operation: (store: PracticeCheckStore) => Promise<Result>,
              ): Promise<Result> => operation(nested),
            );
            return work(nested);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code) ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw new Error('Transaction retries exhausted.');
  };
  return {
    store: new PrismaPracticeCheckStore(client, transact),
    close: () => client.$disconnect(),
  };
}
