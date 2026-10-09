import { useState, type ReactElement } from 'react';
import { Button, Select, Stack, Text, TextInput } from '@mantine/core';
import type { TeachingContext } from '#contracts/Classroom.js';
import type {
  ClassroomInsightCommand,
  ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { formatInsightFailure } from './InsightLabels.js';

interface StudentHelpRequestProps {
  context: TeachingContext;
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

export function StudentHelpRequest({
  context,
  send,
  onSaved,
}: StudentHelpRequestProps): ReactElement {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [category, setCategory] = useState('');
  const [criterionId, setCriterionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <details>
      <summary>Ask your teacher for help</summary>
      <Stack mt="sm" gap="sm">
        <Text size="sm">Tell your teacher which part you want to work through.</Text>
        <TextInput
          label="What would you like help with?"
          value={category}
          maxLength={200}
          onChange={(event) => {
            setCategory(event.currentTarget.value);
            setId(crypto.randomUUID());
          }}
        />
        <Select
          clearable
          label="Part of the task"
          value={criterionId}
          data={context.activity.criteria.map((criterion) => ({
            value: criterion.id,
            label: criterion.description,
          }))}
          onChange={(value) => {
            setCriterionId(value);
            setId(crypto.randomUUID());
          }}
        />
        <Button
          disabled={busy || !category.trim()}
          loading={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void send({
              kind: 'request-help',
              classId: context.meeting.classId,
              requestId: id,
              id,
              participationId: context.participation.id,
              deviceId: context.participation.deviceId,
              activityId: context.activity.id,
              criterionId,
              category: category.trim(),
            }).then((reply) => {
              setBusy(false);
              if (reply.kind === 'failed') {
                setMessage(formatInsightFailure(reply));
              } else if (reply.kind === 'saved') {
                setMessage('Your teacher can see your request.');
                setCategory('');
                setId(crypto.randomUUID());
                onSaved();
              }
            });
          }}
        >
          Send help request
        </Button>
        {message && (
          <Text size="sm" role="status">
            {message}
          </Text>
        )}
      </Stack>
    </details>
  );
}
