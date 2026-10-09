import type { ClassroomInsightPolicy } from '../features/classroom/application/ClassroomInsightPolicy.js';
import { validateClassroomInsightRecord } from './ValidateClassroomInsightRecord.js';
import { ClassroomInsightError } from '../features/classroom/domain/ClassroomInsightError.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  AssessmentMethod,
  InsightFailure,
  InsightRecordKind,
  InsightRecordSchema,
  LearningEventSchema,
} from '#contracts/ClassroomInsights.js';
import type { AppendInsightRecord } from '../features/classroom/application/ClassroomInsightStore.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Must use the source writer's transaction; revision allocation and immutable event commit together. */
export async function appendClassroomLearningEvent(
  client: Prisma.TransactionClient,
  input: AppendInsightRecord,
) {
  await validateClassroomInsightRecord(client, input.classId, input.record);
  const conflictingKind = await client.classroomInsightRecord.findFirst({
    where: {
      classId: input.classId,
      logicalId: input.record.value.id,
      kind: { not: input.record.kind },
    },
  });
  if (conflictingKind) {
    throw new ClassroomInsightError(InsightFailure.STALE);
  }
  const previous = await client.classroomInsightRecord.findFirst({
    where: { classId: input.classId, kind: input.record.kind, logicalId: input.record.value.id },
    orderBy: { version: 'desc' },
  });
  if ((previous?.version ?? 0) !== input.expectedVersion) {
    throw new ClassroomInsightError(InsightFailure.STALE);
  }
  const referencedSources = 'sourceIds' in input.record.value ? input.record.value.sourceIds : [];
  if (
    await client.classroomExpiredSource.findFirst({
      where: {
        classId: input.classId,
        sourceId: { in: [input.record.value.id, ...referencedSources] },
      },
    })
  ) {
    throw new ClassroomInsightError(InsightFailure.REMOVED);
  }
  const removed =
    'studentId' in input.record.value &&
    (await client.classroomInsightRecord.findFirst({
      where: {
        classId: input.classId,
        kind: InsightRecordKind.REMOVAL,
        studentId: input.record.value.studentId,
      },
    }));
  if (removed && input.record.kind !== InsightRecordKind.REMOVAL) {
    throw new ClassroomInsightError(InsightFailure.REMOVED);
  }
  const invalidates =
    input.record.kind === InsightRecordKind.ASSESSMENT &&
    input.record.value.method === AssessmentMethod.TEACHER &&
    (input.expectedVersion > 0 || input.record.value.supersedesId !== null);
  const state = await client.classroomInsightState.upsert({
    where: { classId: input.classId },
    create: { classId: input.classId, revision: 1, invalidationRevision: invalidates ? 1 : 0 },
    update: {
      revision: { increment: 1 },
      invalidationRevision: { increment: invalidates ? 1 : 0 },
    },
  });
  const record = InsightRecordSchema.parse({
    ...input.record,
    value: {
      ...input.record.value,
      version: input.expectedVersion + 1,
      sourceRevision: state.revision.toString(),
    },
  });
  const studentId = 'studentId' in record.value ? record.value.studentId : null;
  const sessionId = 'classSessionId' in record.value ? record.value.classSessionId : null;
  const event = LearningEventSchema.parse({
    id: randomUUID(),
    classId: input.classId,
    revision: state.revision.toString(),
    schemaVersion: 1,
    sourceId: input.sourceId,
    actorId: input.actorId,
    imported: input.imported,
    recordedAt: input.recordedAt,
    record,
  });
  await client.classroomInsightRecord.create({
    data: {
      id: randomUUID(),
      classId: input.classId,
      kind: record.kind,
      logicalId: record.value.id,
      episodeOrder: record.kind === InsightRecordKind.ASSESSMENT ? record.value.episodeOrder : null,
      version: record.value.version,
      revision: state.revision,
      studentId,
      sessionId,
      sourceId: input.sourceId,
      recordedAt: new Date(input.recordedAt),
      record,
    },
  });
  await client.classroomLearningEvent.create({
    data: {
      id: event.id,
      classId: input.classId,
      revision: state.revision,
      identity: input.sourceId,
      logicalId: record.value.id,
      kind: record.kind,
      studentId,
      sessionId,
      sourceId: input.sourceId,
      actorId: input.actorId,
      recordedAt: new Date(input.recordedAt),
      observedAt:
        'observedAt' in record.value
          ? new Date(record.value.observedAt)
          : 'submittedAt' in record.value
            ? new Date(record.value.submittedAt)
            : 'requestedAt' in record.value
              ? new Date(record.value.requestedAt)
              : record.kind === InsightRecordKind.PROGRESS
                ? new Date(record.value.recordedAt)
                : null,
      payloadDigest: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
      record: event,
    },
  });
  return record;
}

export interface LearningCapturePolicy extends ClassroomInsightPolicy {
  collectionPolicy?: string | undefined;
  retentionDays?: number | undefined;
}

export const DisabledLearningCapture: LearningCapturePolicy = { captureClassIds: [] };
