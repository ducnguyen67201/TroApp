import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import { PracticeCheckPanel } from './PracticeCheckPanel.js';
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Badge, Button, Group, Select, Text, TextInput, Stack } from '@mantine/core';
import {
  SubmissionRequirement,
  type ClassroomCommand,
  type ClassroomReply,
  type TeachingContext,
} from '#contracts/Classroom.js';
import { formatPhaseLabel, type ClassroomTranslate } from './ClassroomLabels.js';
interface StudentActivityProps {
  practiceReview?: PracticeShortcutEvent | undefined;
  context: TeachingContext;
  busy: boolean;
  send: (command: ClassroomCommand) => Promise<void>;
  preparation: Extract<ClassroomReply, { kind: 'prepared' }> | null;
  receipt: Extract<ClassroomReply, { kind: 'submitted' }> | null;
  t: ClassroomTranslate;
  onShowMaterials: () => void;
  onAskForHelp?: (message?: string) => void;
}
export function StudentActivityPanel({
  context,
  practiceReview,
  busy,
  send,
  preparation,
  receipt,
  t,
  onShowMaterials,
  onAskForHelp,
}: StudentActivityProps): ReactElement {
  const [workspaceUrl, setWorkspaceUrl] = useState(context.attempt.workspaceUrl ?? '');
  useEffect(() => {
    setWorkspaceUrl(context.attempt.workspaceUrl ?? '');
  }, [context.attempt.id, context.attempt.workspaceUrl]);
  const mutation = {
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
  };

  return (
    <Stack className="student-activity-panel" gap="md">
      <Group justify="space-between">
        <h2 className="classroom-detail-heading">{context.className}</h2>
        <Badge>{formatPhaseLabel(context.meeting.phase, t)}</Badge>
      </Group>
      <Select
        label={t('Your activity', 'Hoạt động của bạn')}
        value={context.activity.id}
        data={context.availableActivities.map((activity) => ({
          value: activity.id,
          label: activity.title,
        }))}
        disabled={busy}
        onChange={(value) => {
          if (value) {
            void send({
              kind: 'context',
              participationId: context.participation.id,
              deviceId: context.participation.deviceId,
              activityId: value,
            });
          }
        }}
      />
      <div className="classroom-current-activity">
        <Text size="xs" className="classroom-eyebrow">
          {t('Current activity', 'Đang làm')}
        </Text>
        <Text fw={600} size="sm">
          {context.activity.title}
        </Text>
        <Text size="sm" c="dimmed" mt={5}>
          {context.activity.objective}
        </Text>
      </div>
      <Button variant="default" onClick={onShowMaterials}>
        {t('Materials for this session', 'Tài liệu cho buổi này')}
      </Button>
      {onAskForHelp && (
        <Button
          variant="subtle"
          onClick={() => {
            onAskForHelp();
          }}
        >
          {t('Ask Tro for a hint', 'Nhờ Tro gợi ý')}
        </Button>
      )}
      <Text size="sm">
        {t(
          'Ask Tro in chat when you need help or cannot find your project. You still perform the learning actions.',
          'Hỏi Tro trong trò chuyện khi cần giúp hoặc không tìm thấy dự án. Bạn vẫn tự thực hiện bài tập.',
        )}
      </Text>
      {context.activity.practiceCheckpoints?.some((item) => item.approved) && (
        <PracticeCheckPanel
          key={context.attempt.id}
          context={context}
          practiceReview={practiceReview}
          t={t}
          {...(onAskForHelp ? { onAskForHelp } : {})}
        />
      )}
      <div className="classroom-work-controls">
        <TextInput
          label={t('Your working project URL', 'Đường dẫn dự án đang làm')}
          value={workspaceUrl}
          onChange={(event) => {
            setWorkspaceUrl(event.currentTarget.value);
          }}
        />
        <Button
          disabled={busy}
          onClick={() => {
            void send({ kind: 'save-workspace', ...mutation, url: workspaceUrl });
          }}
        >
          {t('Remember this project', 'Ghi nhớ dự án này')}
        </Button>
        <Button
          variant="default"
          disabled={busy}
          onClick={() => {
            void send({
              kind: 'report-progress',
              ...mutation,
              eventId: crypto.randomUUID(),
              evidence: context.attempt.evidence,
              declaredComplete: true,
              helpSummary: context.attempt.helpSummary,
            });
          }}
        >
          {t('I have finished', 'Tôi đã làm xong')}
        </Button>
        {context.activity.submission === SubmissionRequirement.SCRATCH_LINK && (
          <Button
            disabled={busy || !context.attempt.workspaceUrl}
            onClick={() => {
              void send({ kind: 'prepare-submission', ...mutation });
            }}
          >
            {t('Review hand-in', 'Kiểm tra bài nộp')}
          </Button>
        )}
        {preparation && (
          <Alert role="alert" title={t('Confirm your project', 'Xác nhận dự án của bạn')}>
            <Stack>
              <Text size="sm">{preparation.preparation.url}</Text>
              <Text size="sm">
                {t(
                  'This submits a link. Your teacher reviews the project; Tro has not verified its access or graded it.',
                  'Thao tác này nộp đường dẫn. Giáo viên sẽ kiểm tra dự án; Tro chưa xác minh quyền xem hoặc chấm điểm.',
                )}
              </Text>
              <Button
                loading={busy}
                onClick={() => {
                  void send({
                    kind: 'submit-work',
                    ...mutation,
                    preparedSubmissionId: preparation.preparation.id,
                    idempotencyKey: preparation.preparation.id,
                  });
                }}
              >
                {t('Submit this project', 'Nộp dự án này')}
              </Button>
            </Stack>
          </Alert>
        )}
        {receipt && (
          <Alert role="alert">
            {t('Submitted', 'Đã nộp')}: {receipt.receipt.url} · {receipt.receipt.submittedAt}
          </Alert>
        )}
      </div>
      <Button
        variant="subtle"
        disabled={busy}
        onClick={() => {
          void send({
            kind: 'leave',
            participationId: context.participation.id,
            deviceId: context.participation.deviceId,
          });
        }}
      >
        {t('Leave session', 'Rời buổi học')}
      </Button>
    </Stack>
  );
}
