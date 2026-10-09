import {
  AssistanceContext,
  AssessmentMethod,
  AssessmentPurpose,
  InsightCoverage,
  InsightFailure,
  InsightLimits,
  type CriterionCounts,
  type InsightIdentity,
  type InsightSourcePacket,
  type InsightStudentProgress,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus, PracticeFinding } from '#contracts/PracticeCheck.js';
import { ClassroomInsightError } from './ClassroomInsightError.js';
import {
  isWithinInsightWindow,
  isWithinSourceRevision,
  selectLearningEvidence,
  selectRecordVersions,
  type SelectedLearningEvidence,
} from './SelectLearningEvidence.js';

export function createInsightIdentity(
  packet: InsightSourcePacket,
  studentId: string | null,
): InsightIdentity {
  const plans = selectRecordVersions(
    packet.plans.filter((value) => Date.parse(value.approvedAt) <= Date.parse(packet.window.to)),
    packet.sourceRevision,
  ).filter((value) => studentId === null || value.studentIds.includes(studentId));
  const mappingVersions = new Map<string, { id: string; version: number }>();
  const referencedMappings = packet.assessments.filter(
    (value) =>
      (studentId === null || value.studentId === studentId) &&
      isWithinInsightWindow(value.observedAt, packet.window),
  );
  for (const mapping of packet.mappings.filter(
    (value) =>
      isWithinSourceRevision(value.sourceRevision, packet.sourceRevision) &&
      referencedMappings.some(
        (assessment) =>
          assessment.mappingId === value.id && assessment.mappingVersion === value.version,
      ),
  )) {
    mappingVersions.set(JSON.stringify([mapping.id, mapping.version]), {
      id: mapping.id,
      version: mapping.version,
    });
  }
  const mappings = [...mappingVersions.values()].sort(
    (left, right) => left.id.localeCompare(right.id) || left.version - right.version,
  );
  return {
    classId: packet.classId,
    studentId,
    window: { ...packet.window },
    sourceRevision: packet.sourceRevision,
    privacyRevision: packet.privacyRevision,
    coverageRevision: packet.coverage.sourceRevision,
    derivationVersion: InsightLimits.DERIVATION_VERSION,
    planIds: plans.map((plan) => plan.id),
    planVersions: plans.map((plan) => ({ id: plan.id, version: plan.version })),
    mappingIds: [...new Set(mappings.map((mapping) => mapping.id))],
    mappingVersions: mappings,
  };
}

export function assertInsightSourceLimit(sourceIds: readonly string[]): void {
  if (sourceIds.length > 1000) {
    throw new ClassroomInsightError(InsightFailure.LIMIT);
  }
}

export function createCriterionCounts(): CriterionCounts {
  return {
    met: 0,
    needsChanges: 0,
    insufficient: 0,
    notChecked: 0,
    conflict: 0,
    removed: 0,
    total: 0,
    sourceIds: [],
  };
}

/** The slice is selected before inspecting findings, preserving newer missing checks. */
export function selectLatestLearningEpisodes(
  evidence: SelectedLearningEvidence[],
): SelectedLearningEvidence[] {
  const activities = new Map<string, SelectedLearningEvidence[]>();
  for (const entry of evidence) {
    const assessment = entry.assessment;
    const key = JSON.stringify([
      assessment.activityId,
      assessment.courseRevisionId,
      assessment.rubricRevisionId,
    ]);
    const entries = activities.get(key) ?? [];
    entries.push(entry);
    activities.set(key, entries);
  }
  const latest: SelectedLearningEvidence[] = [];
  for (const entries of activities.values()) {
    if (entries.some((entry) => entry.hasUnknownOrder)) {
      latest.push(
        ...entries.map((entry) => ({
          ...entry,
          records: entries.length > 1 ? entries.flatMap((value) => value.records) : entry.records,
          conflictingCriterionIds:
            entries.length > 1
              ? entry.assessment.criteria.map((criterion) => criterion.id)
              : entry.conflictingCriterionIds,
        })),
      );
      continue;
    }
    const order = Math.max(...entries.map((entry) => entry.assessment.episodeOrder ?? 0));
    const candidates = entries.filter((entry) => entry.assessment.episodeOrder === order);
    latest.push(
      ...candidates.map((entry) => ({
        ...entry,
        records:
          candidates.length > 1 ? candidates.flatMap((value) => value.records) : entry.records,
        conflictingCriterionIds:
          candidates.length > 1
            ? entry.assessment.criteria.map((criterion) => criterion.id)
            : entry.conflictingCriterionIds,
      })),
    );
  }
  return latest;
}

export function addCriterionEvidence(
  counts: CriterionCounts,
  entry: SelectedLearningEvidence,
  criterionId: string,
): void {
  counts.total += 1;
  counts.sourceIds = [
    ...new Set([
      ...counts.sourceIds,
      ...entry.records.flatMap((record) => [record.id, ...record.sourceIds]),
    ]),
  ].sort();
  assertInsightSourceLimit(counts.sourceIds);
  if (entry.conflictingCriterionIds.includes(criterionId)) {
    counts.conflict += 1;
    return;
  }
  const result =
    entry.assessment.status === PracticeCheckStatus.COMPLETED
      ? entry.assessment.results.find((value) => value.criterionId === criterionId)
      : undefined;
  if (!result) {
    counts.notChecked += 1;
  } else if (result.finding === PracticeFinding.MET) {
    counts.met += 1;
  } else if (result.finding === PracticeFinding.NEEDS_CHANGES) {
    counts.needsChanges += 1;
  } else {
    counts.insufficient += 1;
  }
  counts.sourceIds = [...new Set(counts.sourceIds)].sort();
}

function isIndependentTask(entry: SelectedLearningEvidence): boolean {
  const assessment = entry.assessment;
  return (
    entry.conflictingCriterionIds.length === 0 &&
    assessment.status === PracticeCheckStatus.COMPLETED &&
    assessment.method === AssessmentMethod.TEACHER &&
    assessment.individual === true &&
    assessment.unaidedConfirmed &&
    assessment.assistance === AssistanceContext.UNAIDED &&
    (assessment.purpose === AssessmentPurpose.FRESH ||
      assessment.purpose === AssessmentPurpose.TRANSFER) &&
    assessment.criteria
      .filter((criterion) => criterion.required)
      .every((criterion) =>
        assessment.results.some(
          (result) => result.criterionId === criterion.id && result.finding === PracticeFinding.MET,
        ),
      )
  );
}

function buildComparisons(
  packet: InsightSourcePacket,
  evidence: SelectedLearningEvidence[],
): InsightStudentProgress['comparisons'] {
  const mappings = packet.mappings.filter((value) =>
    isWithinSourceRevision(value.sourceRevision, packet.sourceRevision),
  );
  const comparisons = new Map<string, InsightStudentProgress['comparisons'][number]>();
  for (const entry of evidence) {
    const assessment = entry.assessment;
    if (
      entry.conflictingCriterionIds.length > 0 ||
      assessment.status !== PracticeCheckStatus.COMPLETED
    ) {
      continue;
    }
    const mapping = mappings.find(
      (value) => value.id === assessment.mappingId && value.version === assessment.mappingVersion,
    );
    const variant = mapping?.variants.find((value) => value.id === assessment.taskVariantId);
    if (
      !mapping ||
      !variant ||
      !variant.criterionIds.every((id) =>
        assessment.criteria.some((criterion) => criterion.id === id),
      )
    ) {
      continue;
    }
    const key = JSON.stringify([
      mapping.skillId,
      mapping.standardRevisionId,
      variant.comparisonGroupId,
      variant.scoringRevisionId,
      assessment.assistance,
      assessment.individual,
    ]);
    const comparison = comparisons.get(key) ?? {
      skillId: mapping.skillId,
      title: mapping.title,
      standardRevisionId: mapping.standardRevisionId,
      comparisonGroupId: variant.comparisonGroupId,
      scoringRevisionId: variant.scoringRevisionId,
      assistance: assessment.assistance,
      individual: assessment.individual,
      assessmentIds: [],
    };
    comparison.assessmentIds.push(assessment.id);
    comparisons.set(key, comparison);
  }
  if (
    comparisons.size > 1000 ||
    [...comparisons.values()].some((value) => value.assessmentIds.length > 1000)
  ) {
    throw new ClassroomInsightError(InsightFailure.LIMIT);
  }
  return [...comparisons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

/** Recompute facts from visible sources; no mastery score or causal inference is generated. */
export function calculateStudentProgress(
  packet: InsightSourcePacket,
  studentId: string,
): InsightStudentProgress {
  const student = packet.students.find((value) => value.id === studentId);
  if (!student) {
    throw new ClassroomInsightError(InsightFailure.INVALID);
  }
  const removed = packet.removedStudentIds.includes(studentId);
  const evidence = selectLearningEvidence(packet, studentId);
  const plans = selectRecordVersions(
    packet.plans.filter((plan) => Date.parse(plan.approvedAt) <= Date.parse(packet.window.to)),
    packet.sourceRevision,
  ).filter((plan) => plan.studentIds.includes(studentId));
  const assignedActivities = new Set(
    plans.flatMap((plan) =>
      plan.activityIds.map((id) =>
        JSON.stringify([plan.classSessionId, id, plan.courseRevisionId]),
      ),
    ),
  );
  const submissions = removed
    ? []
    : selectRecordVersions(packet.submissions, packet.sourceRevision).filter(
        (value) =>
          value.studentId === studentId && isWithinInsightWindow(value.submittedAt, packet.window),
      );
  const support = removed
    ? []
    : selectRecordVersions(packet.support, packet.sourceRevision).filter(
        (value) =>
          value.studentId === studentId && isWithinInsightWindow(value.requestedAt, packet.window),
      );
  const nextTasks = removed
    ? []
    : selectRecordVersions(packet.nextTasks, packet.sourceRevision)
        .filter(
          (value) =>
            value.studentId === studentId &&
            Date.parse(value.selectedAt) <= Date.parse(packet.window.to),
        )
        .sort(
          (left, right) =>
            Date.parse(right.selectedAt) - Date.parse(left.selectedAt) ||
            left.id.localeCompare(right.id),
        );
  const sessionIds = [
    ...new Set([
      ...evidence.map((value) => value.assessment.classSessionId),
      ...submissions.map((value) => value.classSessionId),
    ]),
  ];
  const sessions = sessionIds
    .map((classSessionId) => {
      const sessionEvidence = evidence.filter(
        (entry) => entry.assessment.classSessionId === classSessionId,
      );
      const counts = createCriterionCounts();
      const seen = new Set<string>();
      for (const entry of selectLatestLearningEpisodes(sessionEvidence)) {
        for (const criterion of entry.assessment.criteria) {
          const key = JSON.stringify([
            entry.assessment.activityId,
            entry.assessment.courseRevisionId,
            entry.assessment.rubricRevisionId,
            criterion.id,
          ]);
          if (!seen.has(key)) {
            addCriterionEvidence(counts, entry, criterion.id);
            seen.add(key);
          }
        }
      }
      const observedAt =
        [
          ...sessionEvidence.map((entry) => entry.assessment.observedAt),
          ...submissions
            .filter((value) => value.classSessionId === classSessionId)
            .map((value) => value.submittedAt),
        ].sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? packet.window.from;
      return { classSessionId, observedAt, counts };
    })
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
        left.classSessionId.localeCompare(right.classSessionId),
    );
  const delayedChecks = evidence.flatMap((entry) => {
    const assessment = entry.assessment;
    if (assessment.purpose !== AssessmentPurpose.DELAYED || !assessment.priorEpisodeId) {
      return [];
    }
    const priors = selectRecordVersions(packet.assessments, packet.sourceRevision).filter(
      (value) => value.studentId === studentId && value.episodeId === assessment.priorEpisodeId,
    );
    const times = new Set(priors.map((value) => value.observedAt));
    const prior = priors[0];
    const delay =
      prior && times.size === 1
        ? (Date.parse(assessment.observedAt) - Date.parse(prior.observedAt)) / 86400000
        : null;
    return [
      {
        assessmentId: assessment.id,
        priorEpisodeId: assessment.priorEpisodeId,
        delayDays: delay !== null && delay >= 0 ? delay : null,
      },
    ];
  });
  if (sessions.length > 1000 || delayedChecks.length > 1000) {
    throw new ClassroomInsightError(InsightFailure.LIMIT);
  }
  const handedInActivities = new Set<string>();
  for (const submission of submissions) {
    if (plans.length === 0) {
      handedInActivities.add(
        JSON.stringify([
          submission.classSessionId,
          submission.activityId,
          submission.courseRevisionId,
        ]),
      );
      continue;
    }
    for (const plan of plans.filter(
      (value) =>
        value.activityIds.includes(submission.activityId) &&
        value.courseRevisionId === submission.courseRevisionId &&
        (value.classSessionId === null || value.classSessionId === submission.classSessionId),
    )) {
      handedInActivities.add(
        JSON.stringify([plan.classSessionId, submission.activityId, submission.courseRevisionId]),
      );
    }
  }
  return {
    identity: createInsightIdentity(packet, studentId),
    studentId,
    name: student.name,
    coverage: removed ? InsightCoverage.REMOVED : packet.coverage.status,
    coverageReason: removed ? 'Learning history removed.' : packet.coverage.reason,
    handedIn: handedInActivities.size,
    assigned: removed || plans.length === 0 ? null : assignedActivities.size,
    independentTasks: new Set(
      evidence.filter(isIndependentTask).map((entry) => entry.assessment.episodeId),
    ).size,
    sessions,
    assessments: evidence.flatMap((entry) => entry.records),
    submissions,
    support,
    nextTask: nextTasks[0] ?? null,
    comparisons: buildComparisons(packet, evidence),
    delayedChecks,
  };
}
