import { randomUUID } from 'node:crypto';
import { PracticeRecordSchema } from '#contracts/PracticeCheck.js';
import {
  InsightCoverage,
  InsightRecordKind,
  InsightRecordSchema,
} from '#contracts/ClassroomInsights.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  captureClassroomSubmission,
  capturePracticeAssessment,
} from './CaptureClassroomLearning.js';
import { appendClassroomLearningEvent } from './AppendClassroomLearningEvent.js';

/** Conservative resumable import: immutable snapshots only; no reconstructed support or assignment claims. */
export const LearningImportStage = {
  CHECKS: 'checks',
  SNAPSHOTS: 'snapshots',
  LINKS: 'links',
} as const;

export interface LearningImportBatch {
  stage: (typeof LearningImportStage)[keyof typeof LearningImportStage];
  afterId?: string;
  limit: number;
}

export async function importClassroomLearning(
  client: Prisma.TransactionClient,
  classId: string,
  apply: boolean,
  batch?: LearningImportBatch,
) {
  const group = await client.classroomGroup.findUniqueOrThrow({ where: { id: classId } });
  const scope = { attempt: { participation: { meeting: { classId } } } };
  if (!apply) {
    return {
      checks: await client.classroomPracticeCheck.count({ where: scope }),
      snapshotSubmissions: await client.classroomWorkSubmission.count({ where: scope }),
      linkSubmissions: await client.classroomSubmission.count({ where: scope }),
      nextCursor: null,
    };
  }
  const paging = batch
    ? { take: batch.limit, orderBy: { id: 'asc' as const } }
    : { take: 30001, orderBy: { id: 'asc' as const } };
  const where = { ...scope, ...(batch?.afterId ? { id: { gt: batch.afterId } } : {}) };
  const checks =
    !batch || batch.stage === LearningImportStage.CHECKS
      ? await client.classroomPracticeCheck.findMany({
          where,
          include: {
            results: true,
            snapshot: {
              include: {
                evidence: {
                  select: { id: true, kind: true, name: true, byteCount: true, digest: true },
                },
              },
            },
          },
          ...paging,
        })
      : [];
  const snapshots =
    !batch || batch.stage === LearningImportStage.SNAPSHOTS
      ? await client.classroomWorkSubmission.findMany({
          where,
          include: { snapshot: true },
          ...paging,
        })
      : [];
  const links =
    !batch || batch.stage === LearningImportStage.LINKS
      ? await client.classroomSubmission.findMany({ where, ...paging })
      : [];
  if (!batch && checks.length + snapshots.length + links.length > 30000) {
    throw new Error('Use bounded import batches.');
  }
  const batchRows =
    batch?.stage === LearningImportStage.CHECKS
      ? checks
      : batch?.stage === LearningImportStage.SNAPSHOTS
        ? snapshots
        : links;
  const counts = {
    checks: checks.length,
    snapshotSubmissions: snapshots.length,
    linkSubmissions: links.length,
    nextCursor: batch && batchRows.length === batch.limit ? (batchRows.at(-1)?.id ?? null) : null,
  };
  const policy = { captureClassIds: [classId] };
  for (const row of checks) {
    if (
      row.snapshot.expiredAt ||
      (await client.classroomExpiredSource.findFirst({
        where: { classId, sourceId: { in: [row.id, row.snapshotId] } },
      })) ||
      (await client.classroomInsightRecord.findFirst({
        where: { classId, kind: InsightRecordKind.REMOVAL, studentId: row.studentId },
      }))
    ) {
      continue;
    }
    if (row.snapshot.evidence.length === 0) {
      continue;
    }
    const record = PracticeRecordSchema.parse({
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
      evidence: row.snapshot.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        byteCount: item.byteCount,
        digest: item.digest,
      })),
    });
    await capturePracticeAssessment(client, policy, record, true);
  }
  for (const row of snapshots) {
    await captureClassroomSubmission(
      client,
      policy,
      row.id,
      row.attemptId,
      row.submittedAt,
      row.snapshotId,
      row.checkId,
      row.snapshot.courseRevisionId,
      true,
    );
  }
  for (const row of links) {
    await captureClassroomSubmission(
      client,
      policy,
      row.id,
      row.attemptId,
      row.submittedAt,
      null,
      null,
      null,
      true,
    );
  }
  const sourceId = 'import:classroom-insights-v1';
  if (
    (!batch || (batch.stage === LearningImportStage.LINKS && counts.nextCursor === null)) &&
    !(await client.classroomLearningEvent.findUnique({
      where: { classId_identity: { classId, identity: sourceId } },
    }))
  ) {
    const prior = await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.COVERAGE },
      orderBy: { revision: 'desc' },
    });
    const parsed = prior ? InsightRecordSchema.parse(prior.record) : null;
    const coverage = parsed?.kind === InsightRecordKind.COVERAGE ? parsed.value : null;
    await appendClassroomLearningEvent(client, {
      classId,
      actorId: group.teacherId,
      sourceId,
      imported: true,
      recordedAt: new Date().toISOString(),
      expectedVersion: coverage?.version ?? 0,
      record: {
        kind: InsightRecordKind.COVERAGE,
        value: {
          id: coverage?.id ?? randomUUID(),
          version: (coverage?.version ?? 0) + 1,
          sourceRevision: '0',
          status: InsightCoverage.PARTIAL,
          captureStartedAt: coverage?.captureStartedAt ?? null,
          importedThrough: new Date().toISOString(),
          reason:
            'Imported saved snapshots and hand-ins; historical assignments, deleted evidence and support delivery remain unknown.',
        },
      },
    });
  }
  return counts;
}
