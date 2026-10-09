import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';
import {
  encodeSourceCursor,
  decodeSourceCursor,
} from '../features/classroom/application/InsightSourceCursor.js';
import { purgeExpiredClassroomSources } from './PurgeExpiredClassroomSources.js';
import {
  DisabledLearningCapture,
  type LearningCapturePolicy,
} from './AppendClassroomLearningEvent.js';
import { ClassroomInsightError } from '../features/classroom/domain/ClassroomInsightError.js';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  CourseContentSchema,
  ClassMeetingSchema,
  ParticipationSchema,
} from '#contracts/Classroom.js';
import { PracticeEvidenceKind, PracticeEvidenceSchema } from '#contracts/PracticeCheck.js';
import {
  ClassroomInsightReplySchema,
  InsightCoverage,
  InsightLimits,
  InsightRecordKind,
  InsightRecordSchema,
  InsightSourcePacketSchema,
  LearningEventSchema,
  type InsightRecord,
  type InsightRecordKind as RecordKind,
  type InsightWindow,
  type ClassroomInsightReply,
  InsightFailure,
} from '#contracts/ClassroomInsights.js';
import type {
  AppendInsightRecord,
  ClassroomInsightStore,
} from '../features/classroom/application/ClassroomInsightStore.js';
import { appendClassroomLearningEvent } from './AppendClassroomLearningEvent.js';

class PrismaClassroomInsightStore implements ClassroomInsightStore {
  constructor(
    private readonly client: Prisma.TransactionClient,
    private readonly transact?: <T>(
      work: (store: ClassroomInsightStore) => Promise<T>,
    ) => Promise<T>,
  ) {}
  runAtomically<T>(work: (store: ClassroomInsightStore) => Promise<T>): Promise<T> {
    return this.transact ? this.transact(work) : work(this);
  }
  async readAccess(userId: string, classId: string) {
    const row = await this.client.classroomGroup.findUnique({
      where: { id: classId },
      include: { courseRevision: true, enrollments: true },
    });
    if (!row) {
      return null;
    }
    return {
      classId,
      teacherId: row.teacherId,
      deleted: row.deletedAt !== null,
      isTeacher: row.teacherId === userId,
      courseRevisionId: row.courseRevisionId,
      historicalStudentIds: row.enrollments.map((item) => item.studentId),
      studentIds: row.enrollments.filter((item) => item.active).map((item) => item.studentId),
      activities: CourseContentSchema.parse(row.courseRevision.content).modules.flatMap((module) =>
        module.lessons.flatMap((lesson) => lesson.activities),
      ),
    };
  }
  async readClassSession(classId: string, classSessionId: string) {
    const row = await this.client.classroomMeeting.findFirst({
      where: { id: classSessionId, classId },
    });
    return row
      ? ClassMeetingSchema.parse({
          id: row.id,
          classId: row.classId,
          status: row.status,
          phase: row.phase,
          pacing: row.pacing,
          currentActivityId: row.currentActivityId,
          contextVersion: row.contextVersion,
        })
      : null;
  }
  async readStudentAuthority(userId: string, participationId: string, activityId: string) {
    const row = await this.client.classroomParticipation.findUnique({
      where: { id: participationId },
      include: {
        meeting: {
          include: { schoolClass: { include: { courseRevision: true, enrollments: true } } },
        },
      },
    });
    if (
      !row ||
      row.studentId !== userId ||
      row.meeting.schoolClass.deletedAt ||
      !row.meeting.schoolClass.enrollments.some((item) => item.active && item.studentId === userId)
    ) {
      return null;
    }
    const activity = CourseContentSchema.parse(row.meeting.schoolClass.courseRevision.content)
      .modules.flatMap((module) => module.lessons.flatMap((lesson) => lesson.activities))
      .find((item) => item.id === activityId);
    if (!activity) {
      return null;
    }
    return {
      studentId: userId,
      activity,
      participation: ParticipationSchema.parse({
        id: row.id,
        classSessionId: row.classSessionId,
        studentId: row.studentId,
        deviceId: row.deviceId,
        leaseUntil: row.leaseUntil.toISOString(),
        left: row.left,
      }),
      meeting: ClassMeetingSchema.parse({
        id: row.meeting.id,
        classId: row.meeting.classId,
        status: row.meeting.status,
        phase: row.meeting.phase,
        pacing: row.meeting.pacing,
        currentActivityId: row.meeting.currentActivityId,
        contextVersion: row.meeting.contextVersion,
      }),
    };
  }
  async readRecord(classId: string, kind: RecordKind, id: string) {
    const row = await this.client.classroomInsightRecord.findFirst({
      where: { classId, kind, logicalId: id },
      orderBy: { version: 'desc' },
    });
    if (
      !row ||
      row.removedAt ||
      (await this.client.classroomExpiredSource.findUnique({
        where: { classId_sourceId: { classId, sourceId: row.logicalId } },
      }))
    ) {
      return null;
    }
    const record = InsightRecordSchema.parse(row.record);
    if (
      'sourceIds' in record.value &&
      (await this.client.classroomExpiredSource.findFirst({
        where: { classId, sourceId: { in: record.value.sourceIds } },
      }))
    ) {
      return null;
    }
    return record;
  }
  async appendRecord(input: AppendInsightRecord) {
    if (this.transact) {
      return this.runAtomically((store) => store.appendRecord(input));
    }
    return appendClassroomLearningEvent(this.client, input);
  }
  async findReceipt(userId: string, requestId: string) {
    const row = await this.client.classroomInsightReceipt.findUnique({
      where: { userId_requestId: { userId, requestId } },
    });
    return row ? { digest: row.digest, reply: ClassroomInsightReplySchema.parse(row.reply) } : null;
  }
  async saveReceipt(
    userId: string,
    classId: string,
    requestId: string,
    digest: string,
    reply: ClassroomInsightReply,
  ) {
    // Serialize approval/export receipts with all source revisions, corrections and removal.
    await this.client.classroomInsightState.upsert({
      where: { classId },
      create: { classId },
      update: { revision: { increment: 0 } },
    });
    await this.client.classroomInsightReceipt.create({
      data: { userId, requestId, classId, digest, reply },
    });
  }
  async readPacket(classId: string, window: InsightWindow, cutoff?: string) {
    if (this.transact) {
      return this.runAtomically((store) => store.readPacket(classId, window, cutoff));
    }
    const group = await this.client.classroomGroup.findUniqueOrThrow({
      where: { id: classId },
      include: {
        courseRevision: true,
        enrollments: { include: { student: { select: { name: true } } } },
      },
    });
    const state = await this.client.classroomInsightState.findUnique({ where: { classId } });
    const revision = cutoff === undefined ? (state?.revision ?? 0n) : BigInt(cutoff);
    if (revision > (state?.revision ?? 0n)) {
      throw new ClassroomInsightError(InsightFailure.STALE);
    }
    const rows = await this.client.classroomInsightRecord.findMany({
      where: { classId, revision: { lte: revision } },
      orderBy: { revision: 'desc' },
      take: InsightLimits.SOURCE_RECORDS + 1,
    });
    if (
      rows.length > InsightLimits.SOURCE_RECORDS ||
      group.enrollments.length > InsightLimits.STUDENTS
    ) {
      throw new ClassroomInsightError(InsightFailure.LIMIT);
    }
    const seen = new Set<string>(),
      latest: InsightRecord[] = [];
    for (const row of rows) {
      const key = `${row.kind}:${row.logicalId}`;
      if (
        seen.has(key) &&
        row.kind !== InsightRecordKind.MAPPING &&
        row.kind !== InsightRecordKind.PLAN
      ) {
        continue;
      }
      seen.add(key);
      if (!row.removedAt) {
        latest.push(InsightRecordSchema.parse(row.record));
      }
    }
    const expiredRows = await this.client.classroomExpiredSource.findMany({
      where: { classId },
      select: { sourceId: true },
    });
    const expiredIds = new Set(expiredRows.map((row) => row.sourceId));
    const removedRows = await this.client.classroomInsightRecord.findMany({
      where: { classId, kind: InsightRecordKind.REMOVAL },
    });
    const removedStudentIds = [
      ...new Set(removedRows.flatMap((row) => (row.studentId ? [row.studentId] : []))),
    ];
    const inWindow = (value: {
      observedAt?: string;
      submittedAt?: string;
      requestedAt?: string;
    }) => {
      const at = value.observedAt ?? value.submittedAt ?? value.requestedAt;
      return at === undefined || (at >= window.from && at <= window.to);
    };
    const permitted = latest.filter(
      (record) =>
        !expiredIds.has(record.value.id) &&
        (!('sourceIds' in record.value) ||
          !record.value.sourceIds.some((id) => expiredIds.has(id))) &&
        (!('studentId' in record.value) || !removedStudentIds.includes(record.value.studentId)),
    );
    const coverage = latest.find((record) => record.kind === InsightRecordKind.COVERAGE);
    return InsightSourcePacketSchema.parse({
      classId,
      className: group.name,
      teacherId: group.teacherId,
      sourceRevision: revision.toString(),
      privacyRevision: (state?.invalidationRevision ?? 0n).toString(),
      window,
      coverage: coverage?.value ?? {
        id: classId,
        version: 1,
        sourceRevision: '0',
        status: InsightCoverage.PARTIAL,
        captureStartedAt: null,
        importedThrough: null,
        reason: 'Historical assignment and support coverage is unknown.',
      },
      students: group.enrollments.map((row) => ({
        id: row.studentId,
        name: row.student.name,
        enrolled: row.active,
      })),
      activities: CourseContentSchema.parse(group.courseRevision.content).modules.flatMap(
        (module) =>
          module.lessons.flatMap((lesson) =>
            lesson.activities.map((activity) => ({
              id: activity.id,
              title: activity.title,
              courseRevisionId: group.courseRevisionId,
              criteria:
                activity.practiceCheckpoints
                  ?.filter((checkpoint) => checkpoint.approved)
                  .flatMap((checkpoint) =>
                    checkpoint.criteria.map(({ id, description, required }) => ({
                      id,
                      description,
                      required,
                    })),
                  ) ?? [],
            })),
          ),
      ),
      plans: permitted
        .filter((record) => record.kind === InsightRecordKind.PLAN)
        .map((record) => record.value),
      mappings: permitted
        .filter((record) => record.kind === InsightRecordKind.MAPPING)
        .map((record) => record.value),
      assessments: permitted
        .filter((record) => record.kind === InsightRecordKind.ASSESSMENT)
        .map((record) => record.value),
      submissions: permitted
        .filter((record) => record.kind === InsightRecordKind.SUBMISSION && inWindow(record.value))
        .map((record) => record.value),
      support: permitted
        .filter((record) => record.kind === InsightRecordKind.SUPPORT && inWindow(record.value))
        .map((record) => record.value),
      nextTasks: permitted
        .filter((record) => record.kind === InsightRecordKind.NEXT_TASK)
        .map((record) => record.value),
      removedStudentIds,
    });
  }
  async readSourcePage(
    classId: string,
    window: InsightWindow,
    cutoff: string,
    cursor: string | undefined,
    limit: number,
    studentId?: string,
  ) {
    const state = await this.client.classroomInsightState.findUnique({ where: { classId } });
    const scope = {
      classId,
      studentId: studentId ?? null,
      window,
      cutoff,
      privacyRevision: (state?.invalidationRevision ?? 0n).toString(),
    };
    const position = cursor ? decodeSourceCursor(cursor, scope) : '0';
    if (
      BigInt(cutoff) > (state?.revision ?? 0n) ||
      BigInt(position) > BigInt(cutoff) ||
      limit < 1 ||
      limit > InsightLimits.PAGE_SIZE
    ) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
    const expired = await this.client.classroomExpiredSource.findMany({
      where: { classId },
      select: { sourceId: true },
    });
    const expiredIds = new Set(expired.map((row) => row.sourceId));
    const removed = await this.client.classroomInsightRecord.findMany({
      where: { classId, kind: InsightRecordKind.REMOVAL },
      select: { studentId: true },
    });
    const rows = await this.client.classroomLearningEvent.findMany({
      where: {
        classId,
        revision: { gt: BigInt(position), lte: BigInt(cutoff) },
        AND: [
          {
            OR: [
              { observedAt: null },
              { observedAt: { gte: new Date(window.from), lte: new Date(window.to) } },
            ],
          },
          {
            OR: [
              { studentId: null },
              {
                studentId: {
                  notIn: removed.flatMap((row) => (row.studentId ? [row.studentId] : [])),
                },
              },
            ],
          },
          ...(studentId ? [{ OR: [{ studentId }, { studentId: null }] }] : []),
        ],
      },
      orderBy: { revision: 'asc' },
      take: limit + 1,
    });
    const events = rows
      .slice(0, limit)
      .map((row) => {
        const event = LearningEventSchema.parse(row.record);
        return studentId && event.record.kind === InsightRecordKind.PLAN
          ? {
              ...event,
              record: {
                ...event.record,
                value: {
                  ...event.record.value,
                  studentIds: event.record.value.studentIds.filter((id) => id === studentId),
                },
              },
            }
          : event;
      })
      .filter(
        (event) =>
          !expiredIds.has(event.record.value.id) &&
          (!('sourceIds' in event.record.value) ||
            !event.record.value.sourceIds.some((id) => expiredIds.has(id))) &&
          (!studentId ||
            event.record.kind !== InsightRecordKind.PLAN ||
            event.record.value.studentIds.includes(studentId)),
      );
    return {
      events,
      nextCursor:
        rows.length > limit && rows[limit - 1]
          ? encodeSourceCursor(rows[limit - 1]?.revision.toString() ?? '0', scope)
          : null,
    };
  }
  async readEvidence(classId: string, assessmentId: string) {
    const record = await this.readRecord(classId, InsightRecordKind.ASSESSMENT, assessmentId);
    if (
      !record ||
      record.kind !== InsightRecordKind.ASSESSMENT ||
      !record.value.snapshotId ||
      (await this.client.classroomInsightRecord.findFirst({
        where: { classId, kind: InsightRecordKind.REMOVAL, studentId: record.value.studentId },
      }))
    ) {
      return null;
    }
    if (
      await this.client.classroomExpiredSource.findUnique({
        where: { classId_sourceId: { classId, sourceId: record.value.snapshotId } },
      })
    ) {
      return null;
    }
    const rows = await this.client.classroomPracticeEvidence.findMany({
      where: { snapshotId: record.value.snapshotId },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) =>
      PracticeEvidenceSchema.parse(
        row.kind === PracticeEvidenceKind.TEXT
          ? {
              id: row.id,
              kind: PracticeEvidenceKind.TEXT,
              name: row.name,
              text: Buffer.from(row.content).toString('utf8'),
            }
          : {
              id: row.id,
              kind: row.kind,
              name: row.name,
              ...(row.capture ? { capture: row.capture } : {}),
              mediaType: row.mediaType,
              base64: Buffer.from(row.content).toString('base64'),
            },
      ),
    );
  }
  async removeStudentSources(classId: string, studentId: string, actorId: string, now: string) {
    if (this.transact) {
      return this.runAtomically((store) =>
        store.removeStudentSources(classId, studentId, actorId, now),
      );
    }
    const prior = await this.client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.REMOVAL, studentId },
    });
    if (!prior) {
      await appendClassroomLearningEvent(this.client, {
        classId,
        actorId,
        sourceId: `remove:${studentId}`,
        imported: false,
        recordedAt: now,
        expectedVersion: 0,
        record: {
          kind: InsightRecordKind.REMOVAL,
          value: {
            id: randomUUID(),
            version: 1,
            sourceRevision: '0',
            studentId,
            removedAt: now,
            reason: 'Teacher requested removal.',
          },
        },
      });
    }
    await this.client.classroomLearningEvent.deleteMany({
      where: {
        classId,
        OR: [
          { studentId, kind: { not: InsightRecordKind.REMOVAL } },
          { kind: InsightRecordKind.REPORT },
        ],
      },
    });
    await this.client.classroomInsightRecord.deleteMany({
      where: {
        classId,
        OR: [
          { studentId, kind: { not: InsightRecordKind.REMOVAL } },
          { kind: InsightRecordKind.REPORT },
        ],
      },
    });
    // Minimal assignment membership survives to preserve historical eligibility denominators.
    // Student work, assessment feedback, support and cached report content are erased above.
    await this.client.classroomInsightReceipt.deleteMany({ where: { classId } });
    const attempts = await this.client.classroomAttempt.findMany({
      where: { participation: { studentId, meeting: { classId } } },
      select: { id: true },
    });
    const ids = attempts.map((row) => row.id);
    await this.client.classroomPracticeEvidence.deleteMany({
      where: { snapshot: { attemptId: { in: ids } } },
    });
    await this.client.classroomPracticeResult.deleteMany({
      where: { check: { attemptId: { in: ids } } },
    });
    await this.client.classroomPracticeCheck.updateMany({
      where: { attemptId: { in: ids } },
      data: { assessment: Prisma.DbNull },
    });
    await this.client.classroomAttempt.updateMany({
      where: { id: { in: ids } },
      data: { workspaceUrl: null, evidence: [], helpSummary: '', declaredComplete: false },
    });
    await this.client.classroomSubmission.deleteMany({ where: { attemptId: { in: ids } } });
    await this.client.classroomSubmissionPreparation.deleteMany({
      where: { attemptId: { in: ids } },
    });
    const state = await this.client.classroomInsightState.update({
      where: { classId },
      data: { invalidationRevision: { increment: 1 } },
    });
    return state.invalidationRevision.toString();
  }
}

export function createPrismaClassroomInsightStore(
  databaseUrl: string,
  capturePolicy: LearningCapturePolicy = DisabledLearningCapture,
  lifecycle: { resumeStoredRetentionPolicies?: boolean } = {},
): {
  store: ClassroomInsightStore;
  close: () => Promise<void>;
  purgeExpiredSources: (
    now: Date,
    retentionDays?: number,
  ) => Promise<{ expired: number; more: boolean }>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const transact = <T>(work: (store: ClassroomInsightStore) => Promise<T>): Promise<T> =>
    runClassroomTransactionWithRetries(
      () =>
        client.$transaction((transaction) => work(new PrismaClassroomInsightStore(transaction)), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      { operation: 'classroom-insight-transaction' },
    );
  let retentionClassIndex = 0;
  let storedPolicyCursor: string | undefined;
  let cycleHasMore = false;
  let policiesRegistered = false;
  const registerConfiguredPolicies = async (explicitDays: number | undefined) => {
    if (policiesRegistered) {
      return;
    }
    const days = capturePolicy.retentionDays ?? explicitDays;
    const collectionPolicy = capturePolicy.collectionPolicy;
    if (collectionPolicy && days !== undefined) {
      if (!Number.isInteger(days) || days < 1) {
        throw new Error('An approved retention duration is required.');
      }
      // Each registration is bounded and durable before the API begins collection.
      for (const classId of capturePolicy.captureClassIds) {
        await runClassroomTransactionWithRetries(
          () =>
            client.$transaction(
              (transaction) =>
                transaction.classroomInsightState.upsert({
                  where: { classId },
                  create: {
                    classId,
                    collectionPolicy,
                    retentionDays: days,
                  },
                  update: { collectionPolicy, retentionDays: days },
                }),
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            ),
          { operation: 'classroom-retention-policy-registration', classId },
        );
      }
    }
    policiesRegistered = true;
  };
  const purgeExpiredSources = async (now: Date, retentionDays?: number) => {
    await registerConfiguredPolicies(retentionDays);
    const configuredClassId = capturePolicy.captureAllClasses
      ? undefined
      : capturePolicy.captureClassIds[retentionClassIndex];
    let classId = configuredClassId;
    let days = retentionDays ?? capturePolicy.retentionDays;
    let hasAnotherStoredClass = false;
    if (capturePolicy.captureAllClasses) {
      const classes = await client.classroomGroup.findMany({
        where: storedPolicyCursor ? { id: { gt: storedPolicyCursor } } : {},
        orderBy: { id: 'asc' },
        take: 2,
        select: { id: true },
      });
      classId = classes[0]?.id;
      hasAnotherStoredClass = classes.length > 1;
      if (classId && capturePolicy.collectionPolicy && days !== undefined) {
        await client.classroomInsightState.upsert({
          where: { classId },
          create: {
            classId,
            collectionPolicy: capturePolicy.collectionPolicy,
            retentionDays: days,
          },
          update: { collectionPolicy: capturePolicy.collectionPolicy, retentionDays: days },
        });
      }
    }
    if (!capturePolicy.captureAllClasses && !classId && lifecycle.resumeStoredRetentionPolicies) {
      const policies = await client.classroomInsightState.findMany({
        where: {
          retentionDays: { not: null },
          collectionPolicy: { not: null },
          classId: {
            notIn: [...capturePolicy.captureClassIds],
            ...(storedPolicyCursor ? { gt: storedPolicyCursor } : {}),
          },
        },
        orderBy: { classId: 'asc' },
        take: 2,
      });
      const policy = policies[0];
      if (policy) {
        classId = policy.classId;
        days = policy.retentionDays ?? undefined;
        hasAnotherStoredClass = policies.length > 1;
      }
    }
    if (!classId) {
      const more = cycleHasMore;
      retentionClassIndex = 0;
      storedPolicyCursor = undefined;
      cycleHasMore = false;
      return { expired: 0, more };
    }
    if (days === undefined) {
      throw new Error('An explicit or previously approved retention duration is required.');
    }
    const selectedClassId = classId,
      selectedDays = days;
    const result = await runClassroomTransactionWithRetries(
      () =>
        client.$transaction(
          (transaction) =>
            purgeExpiredClassroomSources(transaction, [selectedClassId], now, selectedDays),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
        ),
      { operation: 'classroom-retention', classId: selectedClassId },
    );
    cycleHasMore ||= result.more;
    if (configuredClassId) {
      retentionClassIndex += 1;
      if (
        retentionClassIndex < capturePolicy.captureClassIds.length ||
        lifecycle.resumeStoredRetentionPolicies
      ) {
        return { expired: result.expired, more: true };
      }
    } else {
      storedPolicyCursor = classId;
      if (hasAnotherStoredClass) {
        return { expired: result.expired, more: true };
      }
    }
    retentionClassIndex = 0;
    storedPolicyCursor = undefined;
    const more = cycleHasMore;
    cycleHasMore = false;
    return { expired: result.expired, more };
  };
  return {
    store: new PrismaClassroomInsightStore(client, transact),
    purgeExpiredSources,
    close: () => client.$disconnect(),
  };
}
