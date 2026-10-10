import { Button, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import {
  StudentRequestResolution,
  StudentRequestStatus,
  type GuidedLessonSummary,
  type StudentLessonRequest,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';

interface GuidedLessonRequestsProps {
  requests: StudentLessonRequest[];
  lessons: GuidedLessonSummary[];
  busy: boolean;
  onResolve: (
    requestId: string,
    resolution: StudentRequestResolution,
    lessonId: string | null,
    text: string,
  ) => Promise<void>;
}

export function GuidedLessonRequests({
  requests,
  lessons,
  busy,
  onResolve,
}: GuidedLessonRequestsProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState<StudentRequestResolution>(
    StudentRequestResolution.TEXT,
  );
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const open = requests.filter((request) => request.status === StudentRequestStatus.OPEN);

  return (
    <section className="guided-requests">
      <Text fw={600}>{translate('Explanation requests')}</Text>
      {open.length === 0 && (
        <Text c="dimmed" size="sm">
          {translate('No explanation requests yet.')}
        </Text>
      )}
      {open.map((request) => (
        <div key={request.id} className="guided-request-row">
          <Text size="sm">{request.text}</Text>
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => {
              setSelectedId(request.id);
              setText('');
            }}
          >
            {translate('Respond to request')}
          </Button>
          {selectedId === request.id && (
            <Stack gap="sm">
              <Select
                label={translate('Response')}
                value={resolution}
                data={[
                  {
                    value: StudentRequestResolution.TEXT,
                    label: translate('Send a text explanation'),
                  },
                  {
                    value: StudentRequestResolution.REUSE,
                    label: translate('Reuse a released lesson'),
                  },
                  { value: StudentRequestResolution.LIVE, label: translate('Address in class') },
                  { value: StudentRequestResolution.DRAFT, label: translate('Plan a new lesson') },
                ]}
                onChange={(value) => {
                  if (Object.values(StudentRequestResolution).some((item) => item === value)) {
                    const selected = Object.values(StudentRequestResolution).find(
                      (item) => item === value,
                    );
                    if (selected) {
                      setResolution(selected);
                    }
                  }
                }}
              />
              {resolution === StudentRequestResolution.REUSE && (
                <Select
                  label={translate('Released lesson')}
                  value={lessonId}
                  data={lessons
                    .filter((lesson) => lesson.releaseId)
                    .map((lesson) => ({ value: lesson.id, label: lesson.title }))}
                  onChange={setLessonId}
                />
              )}
              <Textarea
                label={translate('Reply to student')}
                value={text}
                maxLength={4000}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                }}
              />
              <Text size="xs" c="dimmed">
                {translate('Planning a lesson does not start generation.')}
              </Text>
              <Group>
                <Button
                  disabled={busy || (resolution === StudentRequestResolution.REUSE && !lessonId)}
                  onClick={() =>
                    void onResolve(
                      request.id,
                      resolution,
                      resolution === StudentRequestResolution.REUSE ? lessonId : null,
                      text,
                    ).then(() => {
                      setSelectedId(null);
                    })
                  }
                >
                  {translate('Mark addressed')}
                </Button>
              </Group>
            </Stack>
          )}
        </div>
      ))}
    </section>
  );
}
