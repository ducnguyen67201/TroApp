import { useEffect, useState, type ReactElement } from 'react';
import { Button, Modal, Stack, Text } from '@mantine/core';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
  InsightStudentProgress,
} from '#contracts/ClassroomInsights.js';
import { LearningProgressChart } from './LearningProgressChart.js';
import { StudentWorkGallery } from './StudentWorkGallery.js';
import { NextLearningTaskPicker } from './NextLearningTaskPicker.js';
import { TeacherAssessmentForm } from './TeacherAssessmentForm.js';
import { formatAssistance } from './InsightLabels.js';
import { selectLatestPlans } from './InsightDefinitions.js';

interface StudentLearningProgressProps {
  userId: string;
  progress: InsightStudentProgress;
  status: Extract<ClassroomInsightReply, { kind: 'status' }>;
  teacher: boolean;
  classSessionId: string | null;
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

export function StudentLearningProgress({
  userId,
  progress,
  status,
  teacher,
  classSessionId,
  send,
  onSaved,
}: StudentLearningProgressProps): ReactElement {
  const [sessionId, setSessionId] = useState<string | null>(
    progress.sessions.at(-1)?.classSessionId ?? null,
  );
  const [detailActivity, setDetailActivity] = useState<string | null>(null);
  const scope = `${progress.studentId}:${progress.identity.classId}:${progress.identity.window.from}:${progress.identity.window.to}`;
  useEffect(() => {
    setSessionId(progress.sessions.at(-1)?.classSessionId ?? null);
    setDetailActivity(null);
  }, [scope]);
  const session =
    progress.sessions.find((item) => item.classSessionId === sessionId) ?? progress.sessions.at(-1);
  const planIds = [
    ...new Set(
      selectLatestPlans(status.plans)
        .filter((plan) => plan.studentIds.includes(progress.studentId))
        .flatMap((plan) => plan.activityIds),
    ),
  ];
  const planned = planIds.flatMap((id) => {
    const activity = status.activities.find((item) => item.id === id);
    return activity ? [activity] : [];
  });
  const selectedActivity = status.activities.find((activity) => activity.id === detailActivity);
  const selectedWork = progress.assessments.filter(
    (assessment) => assessment.activityId === detailActivity,
  );
  return (
    <Stack gap="lg">
      <div className="learning-heading">
        <div>
          <h2>{progress.name}’s learning journey</h2>
          <p>Tasks tried, skills shown and the next step.</p>
        </div>
        <Text size="xs" c="dimmed">
          Saved data through revision {progress.identity.sourceRevision}
        </Text>
      </div>
      <div className="learning-stat-grid">
        <div className="learning-stat">
          <span>Tasks handed in</span>
          <strong>
            {progress.assigned === null
              ? progress.handedIn
              : `${String(progress.handedIn)}/${String(progress.assigned)}`}
          </strong>
          <small>
            {progress.assigned === null
              ? 'Recorded hand-ins · assignment total unavailable'
              : 'From the teacher-approved assignment plan'}
          </small>
        </div>
        <div className="learning-stat">
          <span>Skills shown in selected lesson</span>
          <strong>
            {session?.counts.total
              ? `${String(session.counts.met)}/${String(session.counts.total)}`
              : '—'}
          </strong>
          <small>Criteria met · support may be included</small>
        </div>
        <div className="learning-stat">
          <span>New tasks completed unaided</span>
          <strong>{progress.independentTasks}</strong>
          <small>Fresh or transfer tasks · teacher confirmed · across this period</small>
        </div>
      </div>
      {progress.coverage !== 'complete' && (
        <Text size="sm" c="dimmed">
          Partial history: {progress.coverageReason || 'Some earlier work is not shown.'}
        </Text>
      )}
      <div className="learning-journey-grid">
        <LearningProgressChart
          lessons={progress.sessions.map((item) => ({
            sessionId: item.classSessionId,
            title: new Date(item.observedAt).toLocaleDateString(),
            met: item.counts.met,
            needsPractice: item.counts.needsChanges,
            unknown: item.counts.insufficient + item.counts.notChecked,
            conflicting: item.counts.conflict + item.counts.removed,
            denominator: item.counts.total,
            comparable: false,
          }))}
          selectedSessionId={session?.classSessionId ?? null}
          onSelect={setSessionId}
        />
        <NextLearningTaskPicker
          key={`${scope}:${String(progress.nextTask?.version ?? 0)}`}
          progress={progress}
          activities={status.activities}
          teacher={teacher}
          send={send}
          onSaved={onSaved}
        />
      </div>
      <section>
        <h3>Your learning path</h3>
        <p>Teacher-set task order. Select a task to see your work.</p>
        <div className="learning-path">
          {planned.map((activity, index) => (
            <button
              type="button"
              className="learning-path-item"
              key={activity.id}
              onClick={() => {
                setDetailActivity(activity.id);
              }}
            >
              <strong>
                {index + 1}. {activity.title}
              </strong>
              <small>
                {progress.submissions.some((submission) => submission.activityId === activity.id)
                  ? 'Work handed in'
                  : progress.assessments.some((assessment) => assessment.activityId === activity.id)
                    ? 'Checked work recorded'
                    : 'No hand-in shown'}
              </small>
            </button>
          ))}
          {planned.length === 0 && <p>A teacher-approved task path has not been assigned yet.</p>}
        </div>
      </section>
      <StudentWorkGallery
        key={`${scope}:${session?.classSessionId ?? ''}:${progress.identity.sourceRevision}:${progress.identity.privacyRevision}`}
        userId={userId}
        progress={progress}
        selectedSessionId={session?.classSessionId ?? null}
      />
      {teacher && (
        <TeacherAssessmentForm
          key={scope}
          progress={progress}
          status={status}
          classSessionId={classSessionId}
          send={send}
          onSaved={onSaved}
        />
      )}
      <details>
        <summary>Comparable skills and delayed checks</summary>
        <Stack mt="sm" gap="sm">
          {progress.comparisons.map((comparison) => (
            <Text
              key={`${comparison.skillId}:${comparison.standardRevisionId}:${comparison.comparisonGroupId}:${comparison.scoringRevisionId}:${comparison.assistance}:${String(comparison.individual)}`}
              size="sm"
            >
              {comparison.title} · {formatAssistance(comparison.assistance)} ·{' '}
              {comparison.individual === true
                ? 'Individual observation'
                : comparison.individual === false
                  ? 'Shared task context'
                  : 'Individual context unknown'}{' '}
              · {comparison.assessmentIds.length} task observations in this comparison group
            </Text>
          ))}
          {progress.delayedChecks.map((check) => (
            <Text key={check.assessmentId} size="sm">
              Delayed check:{' '}
              {check.delayDays === null
                ? 'elapsed time unavailable'
                : `${check.delayDays.toFixed(1)} days after the earlier task`}
              . Result and support remain attached to the task.
            </Text>
          ))}
          {progress.comparisons.length === 0 && (
            <Text size="sm">No teacher-approved comparable skill history shown yet.</Text>
          )}
        </Stack>
      </details>
      <Modal
        opened={Boolean(detailActivity)}
        onClose={() => {
          setDetailActivity(null);
        }}
        title={selectedActivity?.title ?? 'Task detail'}
      >
        <Stack>
          <Text size="sm">Teacher-approved criteria</Text>
          <ul>
            {selectedActivity?.criteria.map((criterion) => (
              <li key={criterion.id}>{criterion.description}</li>
            ))}
          </ul>
          {selectedWork.map((assessment) => (
            <div key={assessment.id}>
              <Text fw={600}>{assessment.title}</Text>
              <Text size="sm">
                {formatAssistance(assessment.assistance, assessment.unaidedConfirmed)}
              </Text>
              <ul>
                {assessment.results.map((result) => (
                  <li key={result.criterionId}>{result.feedback}</li>
                ))}
              </ul>
            </div>
          ))}
          {selectedWork.length === 0 && <Text size="sm">No checked work shown for this task.</Text>}
          <Button
            variant="default"
            onClick={() => {
              setDetailActivity(null);
            }}
          >
            Close
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
