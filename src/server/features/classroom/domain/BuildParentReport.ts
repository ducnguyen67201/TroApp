import {
  AssistanceContext,
  InsightCoverage,
  ReportStatus,
  type InsightAssessment,
  type InsightStudentProgress,
  type ParentReport,
} from '#contracts/ClassroomInsights.js';
import { assertInsightSourceLimit } from './CalculateStudentProgress.js';

export interface ParentReportAuthor {
  id: string;
  createdBy: string;
  createdAt: string;
}

const AssistanceDescriptions = {
  [AssistanceContext.UNKNOWN]: 'unknown',
  [AssistanceContext.UNAIDED]: 'recorded as unaided',
  [AssistanceContext.HINT]: 'hint',
  [AssistanceContext.DEMONSTRATION]: 'demonstration',
  [AssistanceContext.GROUP]: 'group work',
} satisfies Record<InsightAssessment['assistance'], string>;

function buildRecordedTaskFacts(assessments: InsightAssessment[]): ParentReport['facts'] {
  const tasks = new Map<string, InsightAssessment[]>();
  for (const assessment of assessments) {
    const key = JSON.stringify([
      assessment.title,
      assessment.criteria.map((criterion) => criterion.description),
    ]);
    const records = tasks.get(key) ?? [];
    records.push(assessment);
    tasks.set(key, records);
  }
  return [...tasks.values()].slice(0, 3).flatMap((records, index) => {
    const task = records[0];
    if (!task) {
      return [];
    }
    const contexts = new Set(records.map((record) => record.assistance));
    const assistance =
      contexts.size === 1
        ? AssistanceDescriptions[task.assistance]
        : contexts.has(AssistanceContext.UNKNOWN)
          ? 'varies across checks; some assistance context is unknown'
          : 'varies across checks';
    const prefix = `Recorded task: ${task.title}. Learning targets: `;
    const assistanceText = ` Recorded assistance: ${assistance}.`;
    const additionalNote = ' Additional learning targets are recorded in the task checks.';
    const targetBudget = 2000 - prefix.length - assistanceText.length - additionalNote.length - 1;
    const descriptions: string[] = [];
    for (const criterion of task.criteria.slice(0, 3)) {
      const candidate = [...descriptions, criterion.description].join('; ');
      if (candidate.length > targetBudget) {
        break;
      }
      descriptions.push(criterion.description);
    }
    const targets =
      descriptions.length > 0 ? descriptions.join('; ') : 'See the recorded task checks';
    const additionalTargets = descriptions.length < task.criteria.length ? additionalNote : '';
    return [
      {
        id: `recorded-task-${String(index + 1)}`,
        text: `${prefix}${targets}.${additionalTargets}${assistanceText}`,
        sourceIds: [
          ...new Set(records.flatMap((record) => [record.id, ...record.sourceIds])),
        ].sort(),
      },
    ];
  });
}

/** Freeze factual blocks separately from the teacher's reviewed commentary. */
export function buildParentReport(
  progress: InsightStudentProgress,
  author: ParentReportAuthor,
): ParentReport {
  const assessmentSources = [
    ...new Set(progress.assessments.flatMap((value) => [value.id, ...value.sourceIds])),
  ].sort();
  const submissionSources = [
    ...new Set(progress.submissions.flatMap((value) => [value.id, ...value.sourceIds])),
  ].sort();
  const facts: ParentReport['facts'] = [
    {
      id: 'coverage',
      text:
        progress.coverage === InsightCoverage.REMOVED
          ? 'Learning history was removed.'
          : `${progress.coverage === InsightCoverage.COMPLETE ? 'Complete' : 'Partial'} capture coverage for this period. ${progress.coverageReason}`,
      sourceIds: [`coverage:${progress.identity.coverageRevision}`],
    },
  ];
  if (progress.coverage !== InsightCoverage.REMOVED) {
    facts.push(...buildRecordedTaskFacts(progress.assessments));
    facts.push({
      id: 'hand-ins',
      text:
        progress.assigned === null
          ? `${String(progress.handedIn)} distinct session activity hand-ins were recorded. The assigned total is unknown.`
          : `${String(progress.handedIn)} assigned task hand-ins were recorded; ${String(progress.assigned)} task assignments were recorded.`,
      sourceIds: [...new Set([...submissionSources, ...progress.identity.planIds])].sort(),
    });
    facts.push({
      id: 'independent-checks',
      text: `${String(progress.independentTasks)} fresh or transfer task episodes met all required criteria with individual, unaided teacher confirmation.`,
      sourceIds: assessmentSources,
    });
    const totals = progress.sessions.reduce(
      (counts, session) => ({
        met: counts.met + session.counts.met,
        needsChanges: counts.needsChanges + session.counts.needsChanges,
        insufficient: counts.insufficient + session.counts.insufficient,
        notChecked: counts.notChecked + session.counts.notChecked,
        conflict: counts.conflict + session.counts.conflict,
      }),
      { met: 0, needsChanges: 0, insufficient: 0, notChecked: 0, conflict: 0 },
    );
    facts.push({
      id: 'criterion-observations',
      text: `Recorded session criterion observations: ${String(totals.met)} met, ${String(totals.needsChanges)} needing changes, ${String(totals.insufficient)} with insufficient evidence, ${String(totals.notChecked)} without a recorded check, and ${String(totals.conflict)} conflicting. Assistance and task context must be read with each check.`,
      sourceIds: [
        ...new Set(progress.sessions.flatMap((session) => session.counts.sourceIds)),
      ].sort(),
    });
    if (progress.delayedChecks.length > 0) {
      facts.push({
        id: 'delayed-checks',
        text: `${String(progress.delayedChecks.length)} delayed checks were recorded. These are task observations, not a general retention score.`,
        sourceIds: progress.delayedChecks.map((value) => value.assessmentId).sort(),
      });
    }
    if (progress.support.length > 0) {
      const types = [
        ...new Set(
          progress.support.flatMap((request) =>
            request.interventions.map((intervention) => AssistanceDescriptions[intervention.type]),
          ),
        ),
      ].sort();
      const interventionContext =
        types.length > 0
          ? `Recorded teacher intervention types: ${types.join(', ')}.`
          : 'Teacher intervention details are unknown; no entries were recorded.';
      const recordedOutcomes = progress.support.filter(
        (request) => request.reportedOutcome !== null && request.reportedOutcome.trim() !== '',
      ).length;
      facts.push({
        id: 'recorded-support',
        text: `${String(progress.support.length)} help ${progress.support.length === 1 ? 'request was' : 'requests were'} recorded. ${interventionContext} Recorded outcome notes: ${String(recordedOutcomes)} ${recordedOutcomes === 1 ? 'request' : 'requests'}. Unrecorded outcomes remain unknown.`,
        sourceIds: [
          ...new Set(
            progress.support.flatMap((request) => [
              request.id,
              ...request.sourceIds,
              ...request.interventions.map((intervention) => intervention.id),
            ]),
          ),
        ].sort(),
      });
    }
    if (progress.nextTask) {
      facts.push({
        id: 'next-task',
        text:
          typeof progress.nextTask.title === 'string'
            ? `The teacher selected the next activity: ${progress.nextTask.title}.`
            : 'The teacher selected a next activity for this student.',
        sourceIds: [...new Set([progress.nextTask.id, ...progress.nextTask.sourceIds])].sort(),
      });
    }
  }
  const sourceIds = [...new Set(facts.flatMap((fact) => fact.sourceIds))].sort();
  assertInsightSourceLimit(sourceIds);
  return {
    id: author.id,
    version: 1,
    sourceRevision: progress.identity.sourceRevision,
    classId: progress.identity.classId,
    studentId: progress.studentId,
    studentName: progress.name,
    identity: structuredClone(progress.identity),
    facts,
    sessions: structuredClone(progress.sessions),
    commentary: '',
    status: ReportStatus.DRAFT,
    createdBy: author.createdBy,
    createdAt: author.createdAt,
    approvedBy: null,
    approvedAt: null,
    sourceIds,
    invalidationReason: null,
  };
}
