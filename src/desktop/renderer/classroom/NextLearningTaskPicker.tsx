import { useState, type ReactElement } from 'react';
import { Button, Select, Text } from '@mantine/core';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
  InsightStudentProgress,
} from '#contracts/ClassroomInsights.js';
import { formatInsightFailure } from './InsightLabels.js';

interface NextLearningTaskPickerProps {
  progress: InsightStudentProgress;
  activities: Extract<ClassroomInsightReply, { kind: 'status' }>['activities'];
  teacher: boolean;
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

export function NextLearningTaskPicker({
  progress,
  activities,
  teacher,
  send,
  onSaved,
}: NextLearningTaskPickerProps): ReactElement {
  const [activityId, setActivityId] = useState<string | null>(
    progress.nextTask?.activityId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const task = activities.find((activity) => activity.id === progress.nextTask?.activityId);
  const taskTitle = progress.nextTask?.title ?? task?.title;
  return (
    <aside className="learning-next">
      <h3>Next learning task</h3>
      {progress.nextTask ? (
        <>
          <Text fw={600}>{taskTitle ?? 'Teacher-selected activity'}</Text>
          <p>Selected by your teacher based on the learning plan and saved work.</p>
          {!taskTitle && <p>Task details are unavailable.</p>}
        </>
      ) : (
        <p>Your teacher can choose the next activity after reviewing your work.</p>
      )}
      {teacher && (
        <>
          <Select
            label="Teacher-selected task"
            value={activityId}
            data={activities.map((activity) => ({ value: activity.id, label: activity.title }))}
            onChange={setActivityId}
          />
          <Button
            disabled={busy || !activityId}
            loading={busy}
            onClick={() => {
              const selected = activities.find((activity) => activity.id === activityId);
              if (!selected) {
                return;
              }
              const id = progress.nextTask?.id ?? crypto.randomUUID();
              setBusy(true);
              setMessage(null);
              void send({
                kind: 'select-next-task',
                classId: progress.identity.classId,
                studentId: progress.studentId,
                id,
                requestId: crypto.randomUUID(),
                activityId: selected.id,
                courseRevisionId: selected.courseRevisionId,
                expectedVersion: progress.nextTask?.version ?? 0,
              }).then((reply) => {
                setBusy(false);
                if (reply.kind === 'failed') {
                  setMessage(formatInsightFailure(reply));
                } else if (reply.kind === 'saved') {
                  setMessage('Next task selected.');
                  onSaved();
                }
              });
            }}
          >
            Select next task
          </Button>
        </>
      )}
      {message && (
        <Text size="sm" role="status">
          {message}
        </Text>
      )}
    </aside>
  );
}
