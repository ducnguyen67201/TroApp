import { CourseContentSchema } from '#contracts/Classroom.js';
import {
  InsightFailure,
  InsightRecordKind,
  InsightRecordSchema,
  type InsightRecord,
} from '#contracts/ClassroomInsights.js';
import { ClassroomInsightError } from '../features/classroom/domain/ClassroomInsightError.js';
import type { Prisma, ClassroomInsightRecord } from '../generated/prisma/client.js';

/** Prevent IDs from another teacher's class being persisted even through a direct adapter caller. */
export async function validateClassroomInsightRecord(
  client: Prisma.TransactionClient,
  classId: string,
  record: InsightRecord,
) {
  const group = await client.classroomGroup.findUnique({
    where: { id: classId },
    include: { enrollments: true },
  });
  if (!group) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
  const value = record.value;
  if ('observedAt' in value && Date.parse(value.observedAt) > Date.parse(value.recordedAt)) {
    throw new ClassroomInsightError(InsightFailure.INVALID);
  }
  if (
    'studentId' in value &&
    !group.enrollments.some((item) => item.studentId === value.studentId)
  ) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
  if (
    'studentIds' in value &&
    value.studentIds.some(
      (id) => !group.enrollments.some((item) => item.studentId === id && item.active),
    )
  ) {
    throw new ClassroomInsightError(InsightFailure.INVALID);
  }
  if ('classSessionId' in value && value.classSessionId) {
    const session = await client.classroomMeeting.findUnique({
      where: { id: value.classSessionId },
    });
    if (!session || session.classId !== classId) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
  }
  if ('courseRevisionId' in value && value.courseRevisionId) {
    const course = await client.classroomCourseRevision.findUnique({
      where: { id: value.courseRevisionId },
    });
    if (!course || course.ownerId !== group.teacherId) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
    const activities = CourseContentSchema.parse(course.content).modules.flatMap((module) =>
      module.lessons.flatMap((lesson) => lesson.activities),
    );
    if (
      ('activityId' in value && !activities.some((activity) => activity.id === value.activityId)) ||
      ('activityIds' in value &&
        value.activityIds.some((id) => !activities.some((activity) => activity.id === id)))
    ) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
  }
  if (record.kind === InsightRecordKind.ASSESSMENT && record.value.snapshotId) {
    const snapshot = await client.classroomWorkSnapshot.findUnique({
      where: { id: record.value.snapshotId },
      include: { attempt: { include: { participation: { include: { meeting: true } } } } },
    });
    if (
      !snapshot ||
      snapshot.studentId !== record.value.studentId ||
      snapshot.attempt.participation.meeting.classId !== classId ||
      snapshot.courseRevisionId !== record.value.courseRevisionId ||
      snapshot.attempt.activityId !== record.value.activityId
    ) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
  }
  if (record.kind === InsightRecordKind.MAPPING) {
    const course = await client.classroomCourseRevision.findUniqueOrThrow({
      where: { id: group.courseRevisionId },
    });
    const criteria = CourseContentSchema.parse(course.content).modules.flatMap((module) =>
      module.lessons.flatMap((lesson) =>
        lesson.activities.flatMap(
          (activity) =>
            activity.practiceCheckpoints
              ?.filter((checkpoint) => checkpoint.approved)
              .flatMap((checkpoint) => checkpoint.criteria.map((criterion) => criterion.id)) ?? [],
        ),
      ),
    );
    const retained = await client.classroomInsightRecord.findMany({
      where: { classId, kind: { in: [InsightRecordKind.ASSESSMENT, InsightRecordKind.MAPPING] } },
      take: 30001,
    });
    if (retained.length > 30000) {
      throw new ClassroomInsightError(InsightFailure.LIMIT);
    }
    for (const row of retained) {
      const approved = InsightRecordSchema.parse(row.record);
      if (approved.kind === InsightRecordKind.ASSESSMENT) {
        criteria.push(...approved.value.criteria.map((criterion) => criterion.id));
      }
      if (approved.kind === InsightRecordKind.MAPPING && approved.value.id === record.value.id) {
        criteria.push(...approved.value.criterionIds);
      }
    }
    if (record.value.criterionIds.some((id) => !criteria.includes(id))) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
  }
  if (record.kind === InsightRecordKind.ASSESSMENT && record.value.mappingId) {
    const row = await client.classroomInsightRecord.findFirst({
      where: {
        classId,
        kind: InsightRecordKind.MAPPING,
        logicalId: record.value.mappingId,
        version: record.value.mappingVersion ?? -1,
      },
    });
    const mapping = row ? InsightRecordSchema.parse(row.record) : null;
    const variant =
      mapping?.kind === InsightRecordKind.MAPPING
        ? mapping.value.variants.find((item) => item.id === record.value.taskVariantId)
        : null;
    if (
      !variant ||
      record.value.criteria.length !== variant.criterionIds.length ||
      record.value.criteria.some((criterion) => !variant.criterionIds.includes(criterion.id))
    ) {
      throw new ClassroomInsightError(InsightFailure.INVALID);
    }
  }
  if (record.kind === InsightRecordKind.ASSESSMENT && record.value.supersedesId) {
    let id: string | null = record.value.supersedesId;
    const seen = new Set([record.value.id]);
    while (id) {
      if (seen.has(id) || seen.size > 1000) {
        throw new ClassroomInsightError(InsightFailure.INVALID);
      }
      seen.add(id);
      const row: ClassroomInsightRecord | null = await client.classroomInsightRecord.findFirst({
        where: { classId, kind: InsightRecordKind.ASSESSMENT, logicalId: id },
        orderBy: { version: 'desc' },
      });
      const target: InsightRecord | null = row ? InsightRecordSchema.parse(row.record) : null;
      if (
        !target ||
        target.kind !== InsightRecordKind.ASSESSMENT ||
        target.value.studentId !== record.value.studentId ||
        target.value.episodeId !== record.value.episodeId ||
        target.value.activityId !== record.value.activityId
      ) {
        throw new ClassroomInsightError(InsightFailure.INVALID);
      }
      id = target.value.supersedesId;
    }
  }
}
