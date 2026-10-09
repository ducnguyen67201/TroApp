import { useRef, useState, type ReactElement } from 'react';
import { Button, Text } from '@mantine/core';
import type { TeachingContext } from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

export function PracticeFeedbackReview({
  context,
  checkId,
  criterionId,
  t,
}: {
  context: TeachingContext;
  checkId: string;
  criterionId: string;
  t: ClassroomTranslate;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  if (!window.tro.controlClassroomInsights) {
    return null;
  }
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        disabled={busy || saved}
        loading={busy}
        onClick={() => {
          setBusy(true);
          void window.tro
            .controlClassroomInsights?.({
              kind: 'request-help',
              requestId: requestId.current,
              id: requestId.current,
              classId: context.meeting.classId,
              participationId: context.participation.id,
              deviceId: context.participation.deviceId,
              activityId: context.activity.id,
              criterionId,
              checkId,
              category: t(
                'Please review this practice feedback.',
                'Xin kiểm tra lại phản hồi thực hành này.',
              ),
            })
            .then((reply) => {
              setSaved(reply.kind === 'saved');
              setMessage(
                reply.kind === 'saved'
                  ? t(
                      'Your teacher can review this check.',
                      'Giáo viên có thể xem lại lượt kiểm tra này.',
                    )
                  : t(
                      'Could not request review. Try again.',
                      'Chưa gửi được yêu cầu. Hãy thử lại.',
                    ),
              );
            })
            .catch(() => {
              setMessage(
                t('Could not request review. Try again.', 'Chưa gửi được yêu cầu. Hãy thử lại.'),
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {t('Ask teacher to review', 'Nhờ giáo viên kiểm tra lại')}
      </Button>
      {message && (
        <Text size="xs" role="status">
          {message}
        </Text>
      )}
    </>
  );
}
