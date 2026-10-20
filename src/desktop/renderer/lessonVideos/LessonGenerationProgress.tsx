import type { ReactElement } from 'react';
import { Alert, Button, Group, Loader, Text, Title } from '@mantine/core';
import { IconCheck, IconFileText, IconPlayerPlay } from '@tabler/icons-react';
import {
  LessonCommand,
  LessonVideoStage,
  LessonVideoStatus,
  type LessonVideo,
  type LessonVideoCommand,
} from '#contracts/LessonVideos.js';
import { LessonVisualStatus, LessonVisualTreatment } from '#contracts/LessonVisuals.js';
import { describeLesson, describeLessonFailure, isLessonGenerating } from './LessonVideoLabels.js';

/** Checkmarks reflect saved artifacts; stages may interleave across scenes on the server. */
export function LessonGenerationProgress({
  lesson,
  vi,
  busy,
  execute,
  close,
  preview,
}: {
  lesson: LessonVideo;
  vi: boolean;
  busy: boolean;
  execute: (command: LessonVideoCommand) => Promise<void>;
  close: () => void;
  preview: () => void;
}): ReactElement {
  const active = isLessonGenerating(lesson);
  const ready = lesson.status === LessonVideoStatus.READY;
  const total = lesson.screens.length;
  const narrated = lesson.screens.filter((screen) => screen.audioId || screen.silent).length;
  const illustrated = lesson.screens.filter(
    (screen) =>
      !screen.visual ||
      screen.visual.treatment === LessonVisualTreatment.BASELINE ||
      screen.visual.status !== LessonVisualStatus.PENDING,
  ).length;
  const rendered = lesson.screens.filter((screen) => screen.clipId).length;
  const steps = [
    {
      stage: LessonVideoStage.CONTENT,
      label: vi ? 'Lên kịch bản bài giảng' : 'Write the lesson script',
      complete: total > 0,
      count: null,
    },
    {
      stage: LessonVideoStage.SPEECH,
      label: vi ? 'Chuẩn bị giọng đọc hoặc lời giảng' : 'Prepare narration or captions',
      complete: total > 0 && narrated === total,
      count: total ? `${String(narrated)}/${String(total)}` : null,
    },
    {
      stage: LessonVideoStage.VISUAL,
      label: vi ? 'Chuẩn bị cảnh minh họa' : 'Prepare scene animations',
      complete: total > 0 && illustrated === total,
      count: total ? `${String(illustrated)}/${String(total)}` : null,
    },
    {
      stage: LessonVideoStage.CLIP,
      label: vi ? 'Dựng các cảnh' : 'Render scenes',
      complete: total > 0 && rendered === total,
      count: total ? `${String(rendered)}/${String(total)}` : null,
    },
    {
      stage: LessonVideoStage.COMBINE,
      label: vi ? 'Ghép và hoàn thiện video' : 'Combine the finished video',
      complete: ready,
      count: null,
    },
  ];
  return (
    <div className="lesson-generation">
      <div className="lesson-generation-art" aria-hidden="true">
        {active ? (
          <Loader size={46} color="#668257" />
        ) : ready ? (
          <IconPlayerPlay size={42} />
        ) : (
          <IconFileText size={42} />
        )}
      </div>
      <Title order={3}>
        {ready
          ? vi
            ? 'Bài giảng đã sẵn sàng!'
            : 'Your lesson is ready!'
          : active
            ? vi
              ? 'Bài giảng đang thành hình'
              : 'Your lesson is taking shape'
            : vi
              ? 'Bản nháp của bạn'
              : 'Your lesson draft'}
      </Title>
      <Text size="sm" className="lesson-generation-context">
        {lesson.title || lesson.prompt}
      </Text>
      <Text size="sm" role="status">
        {describeLesson(lesson, vi)}
      </Text>
      {lesson.error && <Alert color="orange">{describeLessonFailure(lesson.error, vi)}</Alert>}
      <ol className="lesson-generation-steps">
        {steps.map((step, index) => (
          <li
            key={step.stage}
            data-complete={step.complete}
            aria-current={active && lesson.stage === step.stage ? 'step' : undefined}
          >
            <span className="lesson-step-marker" aria-hidden="true">
              {step.complete ? <IconCheck size={15} /> : index + 1}
            </span>
            <span>{step.label}</span>
            <span className="lesson-step-count">{step.count}</span>
          </li>
        ))}
      </ol>
      <Text size="xs" c="dimmed">
        {active
          ? vi
            ? 'Bạn có thể đóng cửa sổ này. Video vẫn tiếp tục được tạo và cập nhật trong thư viện.'
            : 'You can close this window. Generation continues and updates in your library.'
          : vi
            ? 'Nội dung đã lưu có thể xem lại trong thư viện.'
            : 'Saved content remains available in your library.'}
      </Text>
      <Group justify="space-between" className="lesson-generation-actions">
        {active ? (
          <Button
            color="red"
            variant="subtle"
            disabled={busy}
            onClick={() => {
              void execute({
                kind: LessonCommand.CANCEL,
                id: lesson.id,
                revision: lesson.revision,
              });
            }}
          >
            {vi ? 'Hủy tạo video' : 'Cancel generation'}
          </Button>
        ) : lesson.canContinue ? (
          <Button
            className="lesson-primary"
            disabled={busy}
            onClick={() => {
              void execute({
                kind: LessonCommand.CONTINUE,
                id: lesson.id,
                revision: lesson.revision,
              });
            }}
          >
            {vi ? 'Tiếp tục dựng video' : 'Continue rendering'}
          </Button>
        ) : null}
        <Group gap="xs">
          <Button variant="default" onClick={close}>
            {vi ? 'Về thư viện' : 'Back to library'}
          </Button>
          {(!active || lesson.screens.length > 0 || lesson.videoId) && (
            <Button className="lesson-primary" onClick={preview}>
              {active
                ? vi
                  ? 'Xem nội dung đã lưu'
                  : 'View saved content'
                : ready
                  ? vi
                    ? 'Xem bài giảng'
                    : 'Watch lesson'
                  : vi
                    ? 'Mở bản nháp'
                    : 'Open draft'}
            </Button>
          )}
        </Group>
      </Group>
      {!active && lesson.canContinue && (
        <Text size="xs" c="dimmed">
          {vi
            ? 'Tiếp tục dùng nội dung và hoạt ảnh đã lưu; không cấp thêm lượt gọi AI.'
            : 'Continue reuses saved content and animation; it does not grant new AI attempts.'}
        </Text>
      )}
    </div>
  );
}
