import { createHash, randomUUID } from 'node:crypto';
import { ClassroomPacing, ClassroomPhase, ClassroomStatus } from '#contracts/Classroom.js';
import {
  AssessmentMethod,
  AssessmentPurpose,
  ClassroomInsightCommandSchema,
  InsightFailure,
  InsightLimits,
  InsightRecordKind,
  InsightRecordSchema,
  ReportStatus,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
  type InsightRecord,
  type InsightSourcePacket,
  type InsightWindow,
  type ParentReport,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus } from '#contracts/PracticeCheck.js';
import { ClassroomInsightError } from '../domain/ClassroomInsightError.js';
import { calculateStudentProgress } from '../domain/CalculateStudentProgress.js';
import { calculateClassSummary } from '../domain/CalculateClassSummary.js';
import { buildParentReport } from '../domain/BuildParentReport.js';
import { selectRecordVersions } from '../domain/SelectLearningEvidence.js';
import type { ClassroomInsightStore, InsightAccess } from './ClassroomInsightStore.js';

import {
  canCaptureClassroomLearning,
  type ClassroomInsightPolicy,
} from './ClassroomInsightPolicy.js';
export type { ClassroomInsightPolicy } from './ClassroomInsightPolicy.js';

/** Owns authorized commands and exact report revisions; calculations stay provider-free. */
export class ClassroomInsightService {
  constructor(
    private readonly store: ClassroomInsightStore,
    private readonly policy: ClassroomInsightPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(userId: string, input: ClassroomInsightCommand): Promise<ClassroomInsightReply> {
    const command = ClassroomInsightCommandSchema.parse(input);
    return this.store.runAtomically(async (store) => {
      const access = await store.readAccess(userId, command.classId);
      if (!access || access.deleted || (!access.isTeacher && !access.studentIds.includes(userId))) {
        throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
      }
      const enabled = canCaptureClassroomLearning(this.policy, command.classId);
      if (command.kind === 'status') {
        const packet = await store.readPacket(command.classId, this.defaultWindow());
        const permitted = access.isTeacher ? packet : restrictPacketToStudent(packet, userId);
        return {
          kind: 'status',
          enabled,
          teacher: access.isTeacher,
          students: permitted.students.map(({ id, name }) => ({ id, name })),
          activities: permitted.activities,
          plans: selectRecordVersions(permitted.plans, permitted.sourceRevision),
          mappings: selectRecordVersions(permitted.mappings, permitted.sourceRevision),
        };
      }
      if (!enabled && command.kind !== 'remove-student-sources') {
        throw new ClassroomInsightError(InsightFailure.UNAVAILABLE);
      }
      if (command.kind === 'read-class-insights') {
        requireTeacher(access);
        if (
          command.classSessionId &&
          !(await store.readClassSession(command.classId, command.classSessionId))
        ) {
          throw new ClassroomInsightError(InsightFailure.INVALID);
        }
        return {
          kind: 'class-insights',
          summary: calculateClassSummary(
            await store.readPacket(command.classId, command.window),
            command.classSessionId,
          ),
        };
      }
      if (command.kind === 'read-student-progress') {
        requireStudentRead(access, userId, command.studentId);
        const packet = await store.readPacket(command.classId, command.window);
        return {
          kind: 'student-progress',
          progress: calculateStudentProgress(
            access.isTeacher ? packet : restrictPacketToStudent(packet, userId),
            command.studentId,
          ),
        };
      }
      if (command.kind === 'read-evidence') {
        requireStudentRead(access, userId, command.studentId);
        const record = await store.readRecord(
          command.classId,
          InsightRecordKind.ASSESSMENT,
          command.assessmentId,
        );
        if (
          !record ||
          record.kind !== InsightRecordKind.ASSESSMENT ||
          record.value.studentId !== command.studentId
        ) {
          throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
        }
        const evidence = await store.readEvidence(command.classId, command.assessmentId);
        if (!evidence) {
          throw new ClassroomInsightError(InsightFailure.REMOVED);
        }
        return { kind: 'evidence', evidence };
      }
      if (command.kind === 'read-source-page') {
        const studentId = access.isTeacher ? command.studentId : userId;
        if (command.studentId) {
          requireStudentRead(access, userId, command.studentId);
        }
        const page = await store.readSourcePage(
          command.classId,
          command.window,
          command.cutoff,
          command.cursor,
          command.limit,
          studentId,
        );
        return { kind: 'source-page', ...page, cutoff: command.cutoff };
      }
      if (command.kind === 'read-parent-report') {
        requireTeacher(access);
        const report = await requireReport(store, command.classId, command.id);
        const packet = await store.readPacket(command.classId, report.identity.window);
        return { kind: 'parent-report', report: invalidateReportIfNeeded(report, packet) };
      }
      if (command.kind !== 'request-help') {
        requireTeacher(access);
      }
      const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const receipt = await store.findReceipt(userId, command.requestId);
      if (receipt) {
        if (receipt.digest !== digest) {
          throw new ClassroomInsightError(InsightFailure.STALE);
        }
        if (receipt.reply.kind === 'saved') {
          const packet = await store.readPacket(command.classId, this.defaultWindow());
          const value = receipt.reply.record.value;
          if (
            ('studentId' in value && packet.removedStudentIds.includes(value.studentId)) ||
            ('studentIds' in value &&
              value.studentIds.some((id) => packet.removedStudentIds.includes(id)))
          ) {
            throw new ClassroomInsightError(InsightFailure.REMOVED);
          }
          const current = await store.readRecord(
            command.classId,
            receipt.reply.record.kind,
            value.id,
          );
          if (!current || current.value.version !== value.version) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
        }
        if (receipt.reply.kind === 'export' || receipt.reply.kind === 'parent-report') {
          const current = await requireReport(store, command.classId, receipt.reply.report.id);
          const packet = await store.readPacket(command.classId, current.identity.window);
          if (
            current.version !== receipt.reply.report.version ||
            invalidateReportIfNeeded(current, packet).status === ReportStatus.INVALIDATED
          ) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
        }
        return receipt.reply;
      }
      const now = this.now().toISOString();
      let reply: ClassroomInsightReply;
      if (command.kind === 'remove-student-sources') {
        if (
          !access.studentIds.includes(command.studentId) &&
          !access.historicalStudentIds?.includes(command.studentId)
        ) {
          throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
        }
        reply = {
          kind: 'removed',
          privacyRevision: await store.removeStudentSources(
            command.classId,
            command.studentId,
            userId,
            now,
          ),
        };
      } else {
        const packet = await store.readPacket(command.classId, this.defaultWindow());
        if ('studentId' in command && packet.removedStudentIds.includes(command.studentId)) {
          throw new ClassroomInsightError(InsightFailure.REMOVED);
        }
        const existing =
          'id' in command
            ? await store.readRecord(
                command.classId,
                readCommandRecordKind(command.kind),
                command.id,
              )
            : null;
        if (
          existing &&
          'studentId' in existing.value &&
          packet.removedStudentIds.includes(existing.value.studentId)
        ) {
          throw new ClassroomInsightError(InsightFailure.REMOVED);
        }
        if (
          existing &&
          'studentId' in existing.value &&
          'studentId' in command &&
          existing.value.studentId !== command.studentId
        ) {
          throw new ClassroomInsightError(InsightFailure.INVALID);
        }
        let record: InsightRecord;
        let expectedVersion = 'expectedVersion' in command ? command.expectedVersion : 0;
        if (command.kind === 'approve-plan') {
          if (
            command.courseRevisionId !== access.courseRevisionId ||
            command.activityIds.some(
              (id) => !access.activities.some((activity) => activity.id === id),
            ) ||
            command.studentIds.some(
              (id) => !access.studentIds.includes(id) || packet.removedStudentIds.includes(id),
            )
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          if (
            command.classSessionId &&
            !(await store.readClassSession(command.classId, command.classSessionId))
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          record = {
            kind: InsightRecordKind.PLAN,
            value: {
              id: command.id,
              version: expectedVersion + 1,
              sourceRevision: '0',
              classSessionId: command.classSessionId ?? null,
              courseRevisionId: command.courseRevisionId,
              title: command.title,
              activityIds: command.activityIds,
              studentIds: command.studentIds,
              completionRule: 'hand_in',
              approvedBy: userId,
              approvedAt: now,
            },
          };
        } else if (command.kind === 'approve-mapping') {
          const approvedCriteria = access.activities.flatMap(
            (activity) =>
              activity.practiceCheckpoints
                ?.filter((checkpoint) => checkpoint.approved)
                .flatMap((checkpoint) => checkpoint.criteria.map((criterion) => criterion.id)) ??
              [],
          );
          const retainedCriteria = packet.assessments.flatMap((assessment) =>
            assessment.criteria.map((criterion) => criterion.id),
          );
          const priorCriteria =
            existing?.kind === InsightRecordKind.MAPPING ? existing.value.criterionIds : [];
          if (
            command.criterionIds.some(
              (id) =>
                !approvedCriteria.includes(id) &&
                !retainedCriteria.includes(id) &&
                !priorCriteria.includes(id),
            )
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          record = {
            kind: InsightRecordKind.MAPPING,
            value: {
              id: command.id,
              version: expectedVersion + 1,
              sourceRevision: '0',
              skillId: command.skillId,
              standardRevisionId: command.standardRevisionId,
              title: command.title,
              criterionIds: command.criterionIds,
              variants: command.variants,
              approvedBy: userId,
              approvedAt: now,
            },
          };
        } else if (command.kind === 'select-next-task') {
          requireKnownStudent(access, command.studentId);
          const activity = access.activities.find((item) => item.id === command.activityId);
          if (command.courseRevisionId !== access.courseRevisionId || !activity) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          record = {
            kind: InsightRecordKind.NEXT_TASK,
            value: {
              id: command.id,
              version: expectedVersion + 1,
              sourceRevision: '0',
              studentId: command.studentId,
              activityId: command.activityId,
              courseRevisionId: command.courseRevisionId,
              title: activity.title,
              selectedBy: userId,
              selectedAt: now,
              sourceIds: [command.id],
            },
          };
        } else if (command.kind === 'record-assessment') {
          requireKnownStudent(access, command.studentId);
          if (
            !(await store.readClassSession(command.classId, command.classSessionId)) ||
            Date.parse(command.observedAt) > Date.parse(now)
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          const mapping = packet.mappings.find(
            (value) => value.id === command.mappingId && value.version === command.mappingVersion,
          );
          const variant = mapping?.variants.find((value) => value.id === command.taskVariantId);
          const activity = access.activities.find((value) => value.id === command.activityId);
          if (!mapping || !variant) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          const target = command.supersedesId
            ? packet.assessments.find((value) => value.id === command.supersedesId)
            : null;
          const checked = command.checkId
            ? packet.assessments.find(
                (value) =>
                  value.checkId === command.checkId && value.studentId === command.studentId,
              )
            : null;
          const sameEpisode = packet.assessments.find(
            (value) =>
              value.episodeId === command.episodeId &&
              value.studentId === command.studentId &&
              value.activityId === command.activityId &&
              value.classSessionId === command.classSessionId,
          );
          if (
            packet.assessments.some(
              (value) =>
                value.episodeId === command.episodeId &&
                (value.studentId !== command.studentId ||
                  value.activityId !== command.activityId ||
                  value.classSessionId !== command.classSessionId),
            )
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          const pinned = target ?? checked ?? sameEpisode;
          if (
            packet.mappings.some(
              (value) => value.id === mapping.id && value.version > mapping.version,
            ) &&
            (!target ||
              target.mappingId !== mapping.id ||
              target.mappingVersion !== mapping.version)
          ) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          const criteria =
            pinned?.criteria ??
            activity?.practiceCheckpoints
              ?.filter((checkpoint) => checkpoint.approved)
              .flatMap((checkpoint) => checkpoint.criteria)
              .filter((criterion) => variant.criterionIds.includes(criterion.id));
          if (
            !criteria?.length ||
            criteria.length !== variant.criterionIds.length ||
            criteria.some((criterion) => !variant.criterionIds.includes(criterion.id)) ||
            command.results.some((result) => !variant.criterionIds.includes(result.criterionId)) ||
            command.results.length !== criteria.length ||
            (command.purpose === AssessmentPurpose.DELAYED && !command.priorEpisodeId)
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          const prior = command.priorEpisodeId
            ? packet.assessments.find(
                (value) =>
                  value.episodeId === command.priorEpisodeId &&
                  value.studentId === command.studentId,
              )
            : null;
          if (
            command.priorEpisodeId &&
            (!prior ||
              command.priorEpisodeId === command.episodeId ||
              Date.parse(prior.observedAt) >= Date.parse(command.observedAt))
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          if (
            command.supersedesId &&
            (!target ||
              target.studentId !== command.studentId ||
              target.episodeId !== command.episodeId ||
              target.activityId !== command.activityId ||
              target.classSessionId !== command.classSessionId ||
              Date.parse(target.observedAt) !== Date.parse(command.observedAt))
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          if (
            command.checkId &&
            (!checked ||
              checked.activityId !== command.activityId ||
              checked.classSessionId !== command.classSessionId ||
              checked.episodeId !== command.episodeId)
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          if (
            (pinned && Date.parse(pinned.observedAt) !== Date.parse(command.observedAt)) ||
            (existing?.kind === InsightRecordKind.ASSESSMENT &&
              (existing.value.episodeId !== command.episodeId ||
                existing.value.activityId !== command.activityId ||
                existing.value.classSessionId !== command.classSessionId))
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          const evidenceIds = pinned
            ? ((await store.readEvidence(command.classId, pinned.id))?.map((value) => value.id) ??
              [])
            : [];
          if (
            command.results.some((result) =>
              result.evidenceIds.some((id) => !evidenceIds.includes(id)),
            )
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          const orders = packet.assessments
            .filter(
              (value) =>
                value.studentId === command.studentId && value.activityId === command.activityId,
            )
            .map((value) => value.episodeOrder ?? 0);
          const laterObservation = packet.assessments.some(
            (value) =>
              value.studentId === command.studentId &&
              value.activityId === command.activityId &&
              Date.parse(value.observedAt) >= Date.parse(command.observedAt),
          );
          const checkpoint = activity?.practiceCheckpoints?.find(
            (value) =>
              value.approved &&
              value.criteria.length === criteria.length &&
              value.criteria.every((criterion) => variant.criterionIds.includes(criterion.id)),
          );
          record = {
            kind: InsightRecordKind.ASSESSMENT,
            value: {
              id: command.id,
              version: expectedVersion + 1,
              sourceRevision: '0',
              studentId: command.studentId,
              classSessionId: command.classSessionId,
              activityId: command.activityId,
              episodeId: command.episodeId,
              episodeOrder: pinned
                ? pinned.episodeOrder
                : laterObservation
                  ? null
                  : Math.max(0, ...orders) + 1,
              snapshotId: pinned?.snapshotId ?? null,
              checkId: pinned?.checkId ?? command.checkId,
              title: variant.title,
              task: variant.task,
              courseRevisionId: pinned?.courseRevisionId ?? access.courseRevisionId,
              rubricRevisionId: pinned
                ? pinned.rubricRevisionId
                : (checkpoint?.rubricRevisionId ?? null),
              criteria: criteria.map(({ id, description, required }) => ({
                id,
                description,
                required,
              })),
              results: command.results,
              status: PracticeCheckStatus.COMPLETED,
              method: AssessmentMethod.TEACHER,
              evaluatorRevision: null,
              purpose: command.purpose,
              assistance: command.assistance,
              individual: command.individual,
              unaidedConfirmed: command.unaidedConfirmed,
              authorId: userId,
              mappingId: mapping.id,
              mappingVersion: mapping.version,
              taskVariantId: variant.id,
              priorEpisodeId: command.priorEpisodeId,
              supersedesId: command.supersedesId,
              observedAt: command.observedAt,
              recordedAt: now,
              sourceIds: [
                ...new Set([command.id, ...(pinned ? [pinned.id, ...pinned.sourceIds] : [])]),
              ],
            },
          };
        } else if (command.kind === 'request-help') {
          if (access.isTeacher) {
            throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
          }
          const authority = await store.readStudentAuthority(
            userId,
            command.participationId,
            command.activityId,
          );
          if (
            !authority ||
            authority.meeting.classId !== command.classId ||
            authority.participation.deviceId !== command.deviceId ||
            authority.participation.left ||
            Date.parse(authority.participation.leaseUntil) <= this.now().getTime() ||
            authority.meeting.status !== ClassroomStatus.LIVE ||
            authority.meeting.phase !== ClassroomPhase.PRACTICE ||
            (authority.meeting.pacing === ClassroomPacing.TEACHER &&
              authority.meeting.currentActivityId !== command.activityId)
          ) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          if (
            command.criterionId &&
            !authority.activity.practiceCheckpoints?.some(
              (checkpoint) =>
                checkpoint.approved &&
                checkpoint.criteria.some((criterion) => criterion.id === command.criterionId),
            )
          ) {
            throw new ClassroomInsightError(InsightFailure.INVALID);
          }
          if (packet.removedStudentIds.includes(userId)) {
            throw new ClassroomInsightError(InsightFailure.REMOVED);
          }
          record = {
            kind: InsightRecordKind.SUPPORT,
            value: {
              id: command.id,
              version: 1,
              sourceRevision: '0',
              studentId: userId,
              classSessionId: authority.meeting.id,
              activityId: command.activityId,
              criterionId: command.criterionId,
              requestedAt: now,
              category: command.category,
              interventions: [],
              closedAt: null,
              reportedOutcome: null,
              sourceIds: [command.id],
            },
          };
        } else if (command.kind === 'record-support' || command.kind === 'close-help') {
          if (!existing || existing.kind !== InsightRecordKind.SUPPORT || existing.value.closedAt) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          record = {
            kind: InsightRecordKind.SUPPORT,
            value: {
              ...existing.value,
              version: expectedVersion + 1,
              interventions:
                command.kind === 'record-support'
                  ? [
                      ...existing.value.interventions,
                      {
                        id: randomUUID(),
                        authorId: userId,
                        at: now,
                        type: command.type,
                        note: command.note,
                      },
                    ]
                  : existing.value.interventions,
              closedAt: command.kind === 'close-help' ? now : null,
              reportedOutcome: command.kind === 'close-help' ? command.reportedOutcome : null,
            },
          };
        } else if (command.kind === 'create-parent-report') {
          requireKnownStudent(access, command.studentId);
          const progress = calculateStudentProgress(
            await store.readPacket(command.classId, command.window),
            command.studentId,
          );
          record = {
            kind: InsightRecordKind.REPORT,
            value: buildParentReport(progress, {
              id: command.id,
              createdBy: userId,
              createdAt: now,
            }),
          };
        } else {
          const report = await requireReport(store, command.classId, command.id);
          const current = invalidateReportIfNeeded(
            report,
            await store.readPacket(command.classId, report.identity.window),
          );
          if (current.status === ReportStatus.INVALIDATED || current.version !== expectedVersion) {
            throw new ClassroomInsightError(InsightFailure.STALE);
          }
          if (command.kind === 'export-parent-report') {
            if (current.status !== ReportStatus.APPROVED) {
              throw new ClassroomInsightError(InsightFailure.STALE);
            }
            reply = { kind: 'export', report: current, acceptedAt: now };
            await store.saveReceipt(userId, command.classId, command.requestId, digest, reply);
            return reply;
          }
          record = {
            kind: InsightRecordKind.REPORT,
            value: {
              ...current,
              version: expectedVersion + 1,
              commentary:
                command.kind === 'edit-parent-report' ? command.commentary : current.commentary,
              status:
                command.kind === 'approve-parent-report'
                  ? ReportStatus.APPROVED
                  : ReportStatus.DRAFT,
              approvedBy: command.kind === 'approve-parent-report' ? userId : null,
              approvedAt: command.kind === 'approve-parent-report' ? now : null,
            },
          };
        }
        if (existing && existing.kind !== record.kind) {
          throw new ClassroomInsightError(InsightFailure.STALE);
        }
        expectedVersion = 'expectedVersion' in command ? command.expectedVersion : 0;
        const saved = await store.appendRecord({
          classId: command.classId,
          actorId: userId,
          sourceId: `${command.kind}:${command.requestId}`,
          imported: false,
          recordedAt: now,
          record: InsightRecordSchema.parse(record),
          expectedVersion,
        });
        reply =
          saved.kind === InsightRecordKind.REPORT
            ? { kind: 'parent-report', report: saved.value }
            : { kind: 'saved', record: saved };
      }
      await store.saveReceipt(userId, command.classId, command.requestId, digest, reply);
      return reply;
    });
  }

  private defaultWindow(): InsightWindow {
    const now = this.now();
    return {
      from: new Date(now.getTime() - InsightLimits.MAX_DAYS * 86400000).toISOString(),
      to: now.toISOString(),
      timezone: 'UTC',
    };
  }
}

function requireTeacher(access: InsightAccess): void {
  if (!access.isTeacher) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
}

function requireKnownStudent(access: InsightAccess, studentId: string): void {
  if (!access.studentIds.includes(studentId)) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
}

function requireStudentRead(access: InsightAccess, userId: string, studentId: string): void {
  if (!access.isTeacher && (studentId !== userId || !access.studentIds.includes(userId))) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
}

function readCommandRecordKind(kind: ClassroomInsightCommand['kind']): InsightRecordKind {
  if (kind === 'approve-plan') {
    return InsightRecordKind.PLAN;
  }
  if (kind === 'approve-mapping') {
    return InsightRecordKind.MAPPING;
  }
  if (kind === 'select-next-task') {
    return InsightRecordKind.NEXT_TASK;
  }
  if (kind === 'record-assessment') {
    return InsightRecordKind.ASSESSMENT;
  }
  if (kind === 'request-help' || kind === 'record-support' || kind === 'close-help') {
    return InsightRecordKind.SUPPORT;
  }
  return InsightRecordKind.REPORT;
}

async function requireReport(
  store: ClassroomInsightStore,
  classId: string,
  id: string,
): Promise<ParentReport> {
  const record = await store.readRecord(classId, InsightRecordKind.REPORT, id);
  if (!record || record.kind !== InsightRecordKind.REPORT) {
    throw new ClassroomInsightError(InsightFailure.FORBIDDEN);
  }
  return record.value;
}

function invalidateReportIfNeeded(report: ParentReport, packet: InsightSourcePacket): ParentReport {
  const sourceIds = new Set(report.sourceIds);
  const cutoff = BigInt(report.identity.sourceRevision);
  const correctedAssessment = packet.assessments.some(
    (value) =>
      value.studentId === report.studentId &&
      BigInt(value.sourceRevision) > cutoff &&
      value.method === AssessmentMethod.TEACHER &&
      ((sourceIds.has(value.id) && value.version > 1) ||
        (value.supersedesId !== null && sourceIds.has(value.supersedesId))),
  );
  const changedPlan = report.identity.planVersions.some((reference) =>
    packet.plans.some((value) => value.id === reference.id && value.version > reference.version),
  );
  const mappingVersions = new Map<string, number>();
  for (const reference of report.identity.mappingVersions) {
    mappingVersions.set(
      reference.id,
      Math.max(mappingVersions.get(reference.id) ?? 0, reference.version),
    );
  }
  const changedMapping = packet.mappings.some((value) => {
    const version = mappingVersions.get(value.id);
    if (version === undefined || value.version <= version) {
      return false;
    }
    const previous = packet.mappings.find(
      (mapping) => mapping.id === value.id && mapping.version === version,
    );
    return (
      !previous ||
      previous.skillId !== value.skillId ||
      previous.standardRevisionId !== value.standardRevisionId ||
      previous.title !== value.title ||
      previous.criterionIds.some((id) => !value.criterionIds.includes(id)) ||
      previous.variants.some((variant) => {
        const next = value.variants.find((candidate) => candidate.id === variant.id);
        return !next || JSON.stringify(variant) !== JSON.stringify(next);
      })
    );
  });
  if (
    packet.removedStudentIds.includes(report.studentId) ||
    report.identity.privacyRevision !== packet.privacyRevision ||
    correctedAssessment ||
    changedPlan ||
    changedMapping
  ) {
    return {
      ...report,
      status: ReportStatus.INVALIDATED,
      invalidationReason: 'Source history or permission changed; create and review a new draft.',
    };
  }
  return report;
}

function restrictPacketToStudent(
  packet: InsightSourcePacket,
  studentId: string,
): InsightSourcePacket {
  const assignedPlans = new Set(
    selectRecordVersions(
      packet.plans.filter((plan) => Date.parse(plan.approvedAt) <= Date.parse(packet.window.to)),
      packet.sourceRevision,
    )
      .filter((plan) => plan.studentIds.includes(studentId))
      .map((plan) => plan.id),
  );
  return {
    ...packet,
    students: packet.students.filter((student) => student.id === studentId),
    plans: packet.plans
      .filter((plan) => assignedPlans.has(plan.id))
      .map((plan) => ({ ...plan, studentIds: [studentId] })),
    assessments: packet.assessments.filter((record) => record.studentId === studentId),
    submissions: packet.submissions.filter((record) => record.studentId === studentId),
    support: packet.support.filter((record) => record.studentId === studentId),
    nextTasks: packet.nextTasks.filter((record) => record.studentId === studentId),
    removedStudentIds: packet.removedStudentIds.filter((id) => id === studentId),
  };
}
