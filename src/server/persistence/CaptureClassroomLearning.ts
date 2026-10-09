import { StudentAttemptSchema } from '#contracts/Classroom.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  AssistanceContext,
  AssessmentMethod,
  AssessmentPurpose,
  InsightRecordKind,
  InsightRecordSchema,
  InsightCoverage,
} from '#contracts/ClassroomInsights.js';
import type { PracticeRecord } from '#contracts/PracticeCheck.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  appendClassroomLearningEvent,
  type LearningCapturePolicy,
} from './AppendClassroomLearningEvent.js';

async function recordCaptureCoverage(
  client: Prisma.TransactionClient,
  classId: string,
  policy: LearningCapturePolicy,
) {
  if (
    await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.COVERAGE },
    })
  ) {
    return;
  }
  const group = await client.classroomGroup.findUniqueOrThrow({ where: { id: classId } });
  const now = new Date().toISOString();
  await appendClassroomLearningEvent(client, {
    classId,
    actorId: group.teacherId,
    sourceId: `capture:${createHash('sha256')
      .update(policy.collectionPolicy ?? 'explicit-class-allowlist')
      .digest('hex')}`,
    imported: false,
    recordedAt: now,
    expectedVersion: 0,
    record: {
      kind: InsightRecordKind.COVERAGE,
      value: {
        id: randomUUID(),
        version: 1,
        sourceRevision: '0',
        status: InsightCoverage.PARTIAL,
        captureStartedAt: now,
        importedThrough: null,
        reason: `Capture enabled under policy ${policy.collectionPolicy ?? 'explicit class allowlist'}; retention ${String(policy.retentionDays ?? 'unspecified')} days. Historical assignments and support coverage remain unknown.`,
      },
    },
  });
}

/** Capture is allowlisted, never inferred from browser activity or heartbeat timing. */
export async function capturePracticeAssessment(
  client: Prisma.TransactionClient,
  policy: LearningCapturePolicy,
  record: PracticeRecord,
  imported = false,
) {
  const snapshot = await client.classroomWorkSnapshot.findUniqueOrThrow({
    where: { id: record.snapshotId },
    include: { attempt: { include: { participation: { include: { meeting: true } } } } },
  });
  const participation = snapshot.attempt.participation;
  const classId = participation.meeting.classId;
  if (
    !policy.captureClassIds.includes(classId) ||
    snapshot.expiredAt ||
    (await client.classroomExpiredSource.findFirst({
      where: { classId, sourceId: { in: [record.id, snapshot.id] } },
    }))
  ) {
    return;
  }
  if (
    await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.REMOVAL, studentId: snapshot.studentId },
    })
  ) {
    return;
  }
  if (!imported) {
    await recordCaptureCoverage(client, classId, policy);
  }
  const sourceId = `check:${record.id}:${record.status}`;
  if (
    await client.classroomLearningEvent.findUnique({
      where: { classId_identity: { classId, identity: sourceId } },
    })
  ) {
    return;
  }
  const previous = await client.classroomInsightRecord.findFirst({
    where: { classId, kind: InsightRecordKind.ASSESSMENT, logicalId: record.id },
    orderBy: { version: 'desc' },
  });
  const priorRecord = previous ? InsightRecordSchema.parse(previous.record) : null;
  const highest = await client.classroomInsightRecord.aggregate({
    where: { classId, studentId: snapshot.studentId },
    _max: { episodeOrder: true },
  });
  const episodeOrder =
    priorRecord?.kind === InsightRecordKind.ASSESSMENT
      ? priorRecord.value.episodeOrder
      : imported
        ? null
        : (highest._max.episodeOrder ?? -1) + 1;
  await appendClassroomLearningEvent(client, {
    classId,
    actorId: snapshot.studentId,
    sourceId,
    imported,
    recordedAt: imported ? new Date().toISOString() : (record.completedAt ?? record.createdAt),
    expectedVersion: previous?.version ?? 0,
    record: {
      kind: InsightRecordKind.ASSESSMENT,
      value: {
        id: record.id,
        version: (previous?.version ?? 0) + 1,
        sourceRevision: '0',
        studentId: snapshot.studentId,
        classSessionId: participation.classSessionId,
        activityId: snapshot.attempt.activityId,
        episodeId: snapshot.id,
        episodeOrder,
        snapshotId: snapshot.id,
        checkId: record.id,
        title: record.rubric.title,
        task: record.rubric.task,
        courseRevisionId: snapshot.courseRevisionId,
        rubricRevisionId: snapshot.rubricRevisionId,
        criteria: record.rubric.criteria.map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
          required: criterion.required,
        })),
        results: record.results,
        status: record.status,
        method: AssessmentMethod.MODEL,
        evaluatorRevision: record.evaluator,
        purpose: AssessmentPurpose.PRACTICE,
        assistance: AssistanceContext.UNKNOWN,
        individual: null,
        unaidedConfirmed: false,
        authorId: snapshot.studentId,
        mappingId: null,
        mappingVersion: null,
        taskVariantId: null,
        priorEpisodeId: null,
        supersedesId: null,
        observedAt: record.createdAt,
        recordedAt: imported ? new Date().toISOString() : (record.completedAt ?? record.createdAt),
        sourceIds: [record.id, snapshot.id],
      },
    },
  });
}

export async function captureClassroomSubmission(
  client: Prisma.TransactionClient,
  policy: LearningCapturePolicy,
  id: string,
  attemptId: string,
  submittedAt: Date,
  snapshotId: string | null,
  checkId: string | null,
  courseRevisionId: string | null,
  imported = false,
) {
  const attempt = await client.classroomAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { participation: { include: { meeting: true } } },
  });
  const classId = attempt.participation.meeting.classId,
    studentId = attempt.participation.studentId;
  if (
    !policy.captureClassIds.includes(classId) ||
    (await client.classroomExpiredSource.findFirst({
      where: { classId, sourceId: { in: [id, ...(snapshotId ? [snapshotId] : [])] } },
    })) ||
    (await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.REMOVAL, studentId },
    }))
  ) {
    return;
  }
  if (!imported) {
    await recordCaptureCoverage(client, classId, policy);
  }
  const sourceId = `submission:${id}`;
  if (
    await client.classroomLearningEvent.findUnique({
      where: { classId_identity: { classId, identity: sourceId } },
    })
  ) {
    return;
  }
  await appendClassroomLearningEvent(client, {
    classId,
    actorId: studentId,
    sourceId,
    imported,
    recordedAt: imported ? new Date().toISOString() : submittedAt.toISOString(),
    expectedVersion: 0,
    record: {
      kind: InsightRecordKind.SUBMISSION,
      value: {
        id,
        version: 1,
        sourceRevision: '0',
        studentId,
        classSessionId: attempt.participation.classSessionId,
        activityId: attempt.activityId,
        courseRevisionId,
        sourceKind: snapshotId ? 'snapshot' : 'link',
        snapshotId,
        checkId,
        submittedAt: submittedAt.toISOString(),
        sourceIds: [id, ...(snapshotId ? [snapshotId] : [])],
      },
    },
  });
}

export async function captureClassroomProgress(
  client: Prisma.TransactionClient,
  policy: LearningCapturePolicy,
  attemptId: string,
  eventId: string,
) {
  const attempt = await client.classroomAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { participation: { include: { meeting: true } } },
  });
  const classId = attempt.participation.meeting.classId,
    studentId = attempt.participation.studentId;
  if (
    !policy.captureClassIds.includes(classId) ||
    (await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.REMOVAL, studentId },
    }))
  ) {
    return;
  }
  await recordCaptureCoverage(client, classId, policy);
  const recordedAt = new Date().toISOString();
  await appendClassroomLearningEvent(client, {
    classId,
    actorId: studentId,
    sourceId: `progress:${attemptId}:${eventId}`,
    imported: false,
    recordedAt,
    expectedVersion: 0,
    record: {
      kind: InsightRecordKind.PROGRESS,
      value: {
        id: randomUUID(),
        version: 1,
        sourceRevision: '0',
        studentId,
        classSessionId: attempt.participation.classSessionId,
        activityId: attempt.activityId,
        progressVersion: attempt.progressVersion,
        declaredComplete: attempt.declaredComplete,
        evidence: StudentAttemptSchema.parse({
          id: attempt.id,
          participationId: attempt.participationId,
          activityId: attempt.activityId,
          progressVersion: attempt.progressVersion,
          workspaceUrl: attempt.workspaceUrl,
          evidence: attempt.evidence,
          declaredComplete: attempt.declaredComplete,
          helpSummary: attempt.helpSummary,
        }).evidence,
        recordedAt,
      },
    },
  });
}
