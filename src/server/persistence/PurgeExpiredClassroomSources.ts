import { randomUUID } from 'node:crypto';
import {
  InsightCoverage,
  InsightRecordKind,
  InsightRecordSchema,
  LearningEventSchema,
} from '#contracts/ClassroomInsights.js';
import type { Prisma } from '../generated/prisma/client.js';
import { appendClassroomLearningEvent } from './AppendClassroomLearningEvent.js';

/** Policy-owned rolling expiry. Minimal IDs/timestamps survive; content and cached derived prose do not. */
export async function purgeExpiredClassroomSources(
  client: Prisma.TransactionClient,
  classIds: readonly string[],
  now: Date,
  retentionDays: number,
) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('A positive retention policy is required.');
  }
  const cutoff = new Date(now.getTime() - retentionDays * 86400000);
  let expired = 0,
    more = false;
  for (const classId of classIds.slice(0, 200)) {
    const snapshots = await client.classroomWorkSnapshot.findMany({
      where: {
        expiredAt: null,
        createdAt: { lt: cutoff },
        attempt: { participation: { meeting: { classId } } },
      },
      include: { checks: { select: { id: true } }, submissions: { select: { id: true } } },
      orderBy: { id: 'asc' },
      take: 201,
    });
    const currentWork = await client.classroomAttempt.findMany({
      where: { lastSavedAt: { lt: cutoff }, participation: { meeting: { classId } } },
      select: { id: true, lastSavedAt: true },
      take: 201,
      orderBy: { id: 'asc' },
    });
    const events = await client.classroomLearningEvent.findMany({
      where: {
        classId,
        studentId: { not: null },
        observedAt: { lt: cutoff },
        kind: { notIn: [InsightRecordKind.REMOVAL, InsightRecordKind.REPORT] },
      },
      orderBy: { revision: 'asc' },
      take: 201,
    });
    const links = await client.classroomSubmission.findMany({
      where: { submittedAt: { lt: cutoff }, attempt: { participation: { meeting: { classId } } } },
      orderBy: { id: 'asc' },
      take: 201,
    });
    more ||=
      snapshots.length > 200 ||
      events.length > 200 ||
      links.length > 200 ||
      currentWork.length > 200;
    const sourceIds = new Set<string>();
    for (const attempt of currentWork.slice(0, 200)) {
      sourceIds.add(
        `current-work:${attempt.id}:${attempt.lastSavedAt?.toISOString() ?? 'unknown'}`,
      );
      await client.classroomAttempt.updateMany({
        where: { id: attempt.id, lastSavedAt: attempt.lastSavedAt },
        data: {
          workspaceUrl: null,
          evidence: [],
          helpSummary: '',
          declaredComplete: false,
          lastSavedAt: null,
        },
      });
    }
    for (const snapshot of snapshots.slice(0, 200)) {
      sourceIds.add(snapshot.id);
      for (const check of snapshot.checks) {
        sourceIds.add(check.id);
      }
      for (const submission of snapshot.submissions) {
        sourceIds.add(submission.id);
      }
      await client.classroomPracticeEvidence.deleteMany({ where: { snapshotId: snapshot.id } });
      await client.classroomPracticeResult.deleteMany({
        where: { check: { snapshotId: snapshot.id } },
      });
      await client.classroomPracticeCheck.updateMany({
        where: { snapshotId: snapshot.id },
        data: { rubric: {}, finding: null },
      });
      await client.classroomWorkSnapshot.update({
        where: { id: snapshot.id },
        data: { expiredAt: now },
      });
    }
    for (const event of events.slice(0, 200)) {
      const record = LearningEventSchema.parse(event.record).record;
      if (record.kind === InsightRecordKind.PROGRESS) {
        await client.classroomAttempt.updateMany({
          where: {
            activityId: record.value.activityId,
            progressVersion: record.value.progressVersion,
            OR: [{ lastSavedAt: null }, { lastSavedAt: { lt: cutoff } }],
            participation: {
              classSessionId: record.value.classSessionId,
              studentId: record.value.studentId,
            },
          },
          data: { evidence: [], helpSummary: '', workspaceUrl: null, declaredComplete: false },
        });
      }
      const source = await client.classroomInsightRecord.findFirst({
        where: { classId, revision: event.revision },
      });
      if (source) {
        sourceIds.add(source.logicalId);
      }
      sourceIds.add(event.sourceId);
    }
    for (const link of links.slice(0, 200)) {
      sourceIds.add(link.id);
      await client.classroomAttempt.updateMany({
        where: {
          id: link.attemptId,
          workspaceUrl: link.url,
          OR: [{ lastSavedAt: null }, { lastSavedAt: { lt: cutoff } }],
        },
        data: { workspaceUrl: null },
      });
    }
    await client.classroomSubmissionPreparation.deleteMany({
      where: { expiresAt: { lt: cutoff }, attempt: { participation: { meeting: { classId } } } },
    });
    if (sourceIds.size === 0) {
      continue;
    }
    expired += sourceIds.size;
    for (const sourceId of sourceIds) {
      await client.classroomExpiredSource.upsert({
        where: { classId_sourceId: { classId, sourceId } },
        create: { classId, sourceId, expiredAt: now },
        update: {},
      });
    }
    await client.classroomInsightRecord.deleteMany({
      where: {
        classId,
        OR: [
          { logicalId: { in: [...sourceIds] } },
          { sourceId: { in: [...sourceIds] } },
          { kind: InsightRecordKind.REPORT },
        ],
      },
    });
    await client.classroomLearningEvent.deleteMany({
      where: {
        classId,
        OR: [
          { id: { in: events.slice(0, 200).map((event) => event.id) } },
          { sourceId: { in: [...sourceIds] } },
          { kind: InsightRecordKind.REPORT },
        ],
      },
    });
    await client.classroomLearningEvent.deleteMany({
      where: { classId, logicalId: { in: [...sourceIds] } },
    });
    await client.classroomSubmission.deleteMany({
      where: { id: { in: links.slice(0, 200).map((link) => link.id) } },
    });
    await client.classroomInsightReceipt.deleteMany({ where: { classId } });
    await client.classroomInsightState.upsert({
      where: { classId },
      create: { classId, revision: 1, invalidationRevision: 1 },
      update: { revision: { increment: 1 }, invalidationRevision: { increment: 1 } },
    });
    const group = await client.classroomGroup.findUniqueOrThrow({ where: { id: classId } });
    const prior = await client.classroomInsightRecord.findFirst({
      where: { classId, kind: InsightRecordKind.COVERAGE },
      orderBy: { revision: 'desc' },
    });
    const coverage = prior ? InsightRecordSchema.parse(prior.record) : null;
    const priorValue = coverage?.kind === InsightRecordKind.COVERAGE ? coverage.value : null;
    await appendClassroomLearningEvent(client, {
      classId,
      actorId: group.teacherId,
      sourceId: `expiry:${randomUUID()}`,
      imported: false,
      recordedAt: now.toISOString(),
      expectedVersion: priorValue?.version ?? 0,
      record: {
        kind: InsightRecordKind.COVERAGE,
        value: {
          id: priorValue?.id ?? randomUUID(),
          version: (priorValue?.version ?? 0) + 1,
          sourceRevision: '0',
          status: InsightCoverage.PARTIAL,
          captureStartedAt: priorValue?.captureStartedAt ?? null,
          importedThrough: priorValue?.importedThrough ?? null,
          reason: `Sources older than ${String(retentionDays)} days expired under the collection policy; earlier learning and assistance evidence is incomplete. Legacy undated current work has unknown age and requires operator review.`,
        },
      },
    });
  }
  return { expired, more };
}
