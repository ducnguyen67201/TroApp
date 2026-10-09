import { useState, type ReactElement } from 'react';
import { Button, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import {
  AssistanceContext,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
  type InsightSupport,
} from '#contracts/ClassroomInsights.js';
import { formatAssistance, formatInsightFailure } from './InsightLabels.js';

interface TeacherHelpQueueProps {
  classId: string;
  requests: InsightSupport[];
  students: { id: string; name: string }[];
  send: (command: ClassroomInsightCommand) => Promise<ClassroomInsightReply>;
  onSaved: () => void;
}

export function TeacherHelpQueue({
  classId,
  requests,
  students,
  send,
  onSaved,
}: TeacherHelpQueueProps): ReactElement {
  return (
    <section aria-label="Help requests">
      <h3>Help requests</h3>
      <p>Requests show what students asked for. Record the support you actually gave.</p>
      <Stack mt="sm">
        {requests.map((request) => (
          <TeacherHelpRequest
            key={`${request.id}:${String(request.version)}`}
            classId={classId}
            request={request}
            name={students.find((student) => student.id === request.studentId)?.name ?? 'Student'}
            send={send}
            onSaved={onSaved}
          />
        ))}
        {requests.length === 0 && (
          <Text size="sm" c="dimmed">
            No open help requests.
          </Text>
        )}
      </Stack>
    </section>
  );
}

function TeacherHelpRequest({
  classId,
  request,
  name,
  send,
  onSaved,
}: {
  classId: string;
  request: InsightSupport;
  name: string;
  send: TeacherHelpQueueProps['send'];
  onSaved: () => void;
}): ReactElement {
  const [type, setType] = useState<AssistanceContext>(AssistanceContext.HINT);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(command: ClassroomInsightCommand): Promise<void> {
    setBusy(true);
    setMessage(null);
    const reply = await send(command);
    setBusy(false);
    if (reply.kind === 'failed') {
      setMessage(formatInsightFailure(reply));
    } else if (reply.kind === 'saved') {
      onSaved();
    }
  }

  return (
    <details className="learning-work-card">
      <summary>
        {name} · {request.category}
      </summary>
      <Stack gap="sm" mt="sm">
        {request.checkId && <Text size="xs">Practice feedback review · {request.checkId}</Text>}
        <Text size="xs">Requested {new Date(request.requestedAt).toLocaleString()}</Text>
        {request.interventions.map((intervention) => (
          <Text key={intervention.id} size="sm">
            {formatAssistance(intervention.type)} · {intervention.note}
          </Text>
        ))}
        <Select
          label="Support given"
          value={type}
          data={Object.values(AssistanceContext).map((value) => ({
            value,
            label: formatAssistance(value),
          }))}
          onChange={(value) => {
            if (
              value === AssistanceContext.UNKNOWN ||
              value === AssistanceContext.UNAIDED ||
              value === AssistanceContext.HINT ||
              value === AssistanceContext.DEMONSTRATION ||
              value === AssistanceContext.GROUP
            ) {
              setType(value);
            }
          }}
        />
        <Textarea
          label="What you did"
          value={note}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
        />
        <Button
          disabled={busy || !note.trim()}
          onClick={() => {
            void save({
              kind: 'record-support',
              classId,
              requestId: crypto.randomUUID(),
              id: request.id,
              expectedVersion: request.version,
              type,
              note: note.trim(),
            });
          }}
        >
          Record support
        </Button>
        <Textarea
          label="Reported outcome"
          description="A reported outcome is separate from a checked result."
          value={outcome}
          maxLength={1000}
          onChange={(event) => {
            setOutcome(event.currentTarget.value);
          }}
        />
        <Group>
          <Button
            variant="default"
            disabled={busy || !outcome.trim()}
            onClick={() => {
              void save({
                kind: 'close-help',
                classId,
                requestId: crypto.randomUUID(),
                id: request.id,
                expectedVersion: request.version,
                reportedOutcome: outcome.trim(),
              });
            }}
          >
            Close request
          </Button>
        </Group>
        {message && (
          <Text role="status" size="sm">
            {message}
          </Text>
        )}
      </Stack>
    </details>
  );
}
