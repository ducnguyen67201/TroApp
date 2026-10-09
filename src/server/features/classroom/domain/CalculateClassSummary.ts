import {
  type InsightClassSummary,
  type InsightSourcePacket,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus, PracticeFinding } from '#contracts/PracticeCheck.js';
import {
  addCriterionEvidence,
  assertInsightSourceLimit,
  createCriterionCounts,
  createInsightIdentity,
  selectLatestLearningEpisodes,
} from './CalculateStudentProgress.js';
import {
  isWithinInsightWindow,
  selectLearningEvidence,
  selectRecordVersions,
} from './SelectLearningEvidence.js';

/** Count distinct assigned students, retaining unchecked and removed denominators. */
export function calculateClassSummary(
  packet: InsightSourcePacket,
  classSessionId?: string,
): InsightClassSummary {
  const plans = selectRecordVersions(
    packet.plans.filter((plan) => Date.parse(plan.approvedAt) <= Date.parse(packet.window.to)),
    packet.sourceRevision,
  ).filter((plan) => classSessionId === undefined || plan.classSessionId === classSessionId);
  const eligibleIds = new Set(plans.flatMap((plan) => plan.studentIds));
  const hasDenominator = plans.length > 0;
  const observations = packet.students.map((student) => {
    const evidence = selectLatestLearningEpisodes(
      selectLearningEvidence(packet, student.id).filter(
        (entry) =>
          classSessionId === undefined || entry.assessment.classSessionId === classSessionId,
      ),
    );
    return { student, evidence };
  });
  const criterionDefinitions = new Map<string, { description: string; activityIds: Set<string> }>();
  for (const plan of plans) {
    for (const activity of packet.activities.filter(
      (value) =>
        plan.activityIds.includes(value.id) && value.courseRevisionId === plan.courseRevisionId,
    )) {
      for (const criterion of activity.criteria) {
        const definition = criterionDefinitions.get(criterion.id) ?? {
          description: criterion.description,
          activityIds: new Set<string>(),
        };
        definition.activityIds.add(activity.id);
        criterionDefinitions.set(criterion.id, definition);
      }
    }
  }
  for (const { evidence } of observations) {
    for (const entry of evidence) {
      for (const criterion of entry.assessment.criteria) {
        const definition = criterionDefinitions.get(criterion.id) ?? {
          description: criterion.description,
          activityIds: new Set<string>(),
        };
        definition.activityIds.add(entry.assessment.activityId);
        criterionDefinitions.set(criterion.id, definition);
      }
    }
  }
  const criteria = [...criterionDefinitions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([criterionId, definition]) => {
      const counts = createCriterionCounts();
      const assignedIds = new Set(
        plans
          .filter((plan) => plan.activityIds.some((id) => definition.activityIds.has(id)))
          .flatMap((plan) => plan.studentIds),
      );
      const observedIds = observations
        .filter(({ evidence }) =>
          evidence.some((entry) =>
            entry.assessment.criteria.some((criterion) => criterion.id === criterionId),
          ),
        )
        .map(({ student }) => student.id);
      const children = new Set([...assignedIds, ...observedIds]);
      for (const studentId of [...children].sort()) {
        if (packet.removedStudentIds.includes(studentId)) {
          counts.total += 1;
          counts.removed += 1;
          continue;
        }
        const entries =
          observations
            .find(({ student }) => student.id === studentId)
            ?.evidence.filter((entry) =>
              entry.assessment.criteria.some((criterion) => criterion.id === criterionId),
            ) ?? [];
        const entry = entries[0];
        if (!entry) {
          counts.total += 1;
          counts.notChecked += 1;
          continue;
        }
        const findings = new Set(
          entries.map((value) =>
            value.assessment.status === PracticeCheckStatus.COMPLETED
              ? (value.assessment.results.find((result) => result.criterionId === criterionId)
                  ?.finding ?? 'missing')
              : 'missing',
          ),
        );
        const selected =
          entries.length > 1 && findings.size > 1
            ? { ...entry, conflictingCriterionIds: [...entry.conflictingCriterionIds, criterionId] }
            : entry;
        addCriterionEvidence(counts, selected, criterionId);
        counts.sourceIds.push(
          ...entries.flatMap((value) =>
            value.records.flatMap((record) => [record.id, ...record.sourceIds]),
          ),
        );
      }
      counts.sourceIds = [...new Set(counts.sourceIds)].sort();
      assertInsightSourceLimit(counts.sourceIds);
      return { criterionId, description: definition.description, counts };
    });
  const students = observations.map(({ student, evidence }) => ({
    id: student.id,
    name: student.name,
    checked: evidence.some(
      (entry) =>
        entry.assessment.status === PracticeCheckStatus.COMPLETED &&
        entry.assessment.results.length > 0 &&
        entry.conflictingCriterionIds.length === 0,
    ),
    needsChanges: evidence.some(
      (entry) =>
        entry.assessment.status === PracticeCheckStatus.COMPLETED &&
        entry.assessment.results.some(
          (result) =>
            result.finding === PracticeFinding.NEEDS_CHANGES &&
            !entry.conflictingCriterionIds.includes(result.criterionId),
        ),
    ),
  }));
  const checked = students.filter(
    (student) => student.checked && (!hasDenominator || eligibleIds.has(student.id)),
  ).length;
  return {
    identity: createInsightIdentity(packet, null),
    coverage: packet.coverage.status,
    eligible: hasDenominator ? eligibleIds.size : null,
    checked,
    unknown: hasDenominator ? eligibleIds.size - checked : null,
    criteria,
    students,
    openSupport: selectRecordVersions(packet.support, packet.sourceRevision).filter(
      (value) =>
        !packet.removedStudentIds.includes(value.studentId) &&
        value.closedAt === null &&
        isWithinInsightWindow(value.requestedAt, packet.window) &&
        (classSessionId === undefined || value.classSessionId === classSessionId),
    ),
  };
}
