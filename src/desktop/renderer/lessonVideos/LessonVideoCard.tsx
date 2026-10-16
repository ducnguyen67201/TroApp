import type { ReactElement } from 'react';
import { IconArrowRight, IconFileText, IconPlayerPlay, IconSchool } from '@tabler/icons-react';
import { Loader } from '@mantine/core';
import { LessonVideoStatus, type LessonVideo } from '#contracts/LessonVideos.js';
import { describeLesson, isLessonGenerating } from './LessonVideoLabels.js';

/** Content thumbnails use saved text, never fetch entire video artifacts for the grid. */
export function LessonVideoCard({
  lesson,
  className,
  vi,
  open,
}: {
  lesson: LessonVideo;
  className: string;
  vi: boolean;
  open: () => void;
}): ReactElement {
  const active = isLessonGenerating(lesson);
  const ready = lesson.status === LessonVideoStatus.READY;
  const firstScreen = lesson.screens[0];
  const rendered = lesson.screens.filter((screen) => screen.clipId).length;
  const duration = ready
    ? Math.ceil(lesson.screens.reduce((total, screen) => total + screen.durationSeconds, 0))
    : 0;
  const date = new Date(lesson.createdAt);
  const action = active
    ? vi
      ? 'Xem tiến độ'
      : 'View progress'
    : ready
      ? vi
        ? 'Xem bài giảng'
        : 'Watch lesson'
      : vi
        ? 'Mở bản nháp'
        : 'Open draft';
  return (
    <article className="lesson-card" data-status={lesson.status}>
      <button
        type="button"
        className="lesson-card-open"
        onClick={open}
        aria-label={`${action}: ${lesson.title || lesson.prompt}`}
      >
        <div className="lesson-card-poster">
          <span className="lesson-poster-kicker">
            {firstScreen
              ? vi
                ? 'Nội dung bài giảng'
                : 'Lesson content'
              : vi
                ? 'Ý tưởng bài giảng'
                : 'Lesson idea'}
          </span>
          <span className="lesson-poster-title">
            {firstScreen?.title ?? (lesson.title || lesson.prompt)}
          </span>
          {firstScreen?.points[0] && (
            <span className="lesson-poster-point">{firstScreen.points[0]}</span>
          )}
          <span className="lesson-card-duration">
            {duration > 0
              ? `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`
              : active
                ? vi
                  ? 'Đang tạo'
                  : 'In progress'
                : ready
                  ? vi
                    ? 'Sẵn sàng'
                    : 'Ready'
                  : vi
                    ? 'Bản nháp'
                    : 'Draft'}
          </span>
          <span className="lesson-card-play" aria-hidden="true">
            {active ? (
              <Loader size={19} color="#668257" />
            ) : ready ? (
              <IconPlayerPlay size={19} />
            ) : (
              <IconFileText size={19} />
            )}
          </span>
        </div>
        <div className="lesson-card-body">
          <span className="lesson-card-status">{describeLesson(lesson, vi)}</span>
          <h3>{lesson.title || lesson.prompt}</h3>
          <span className="lesson-card-meta">
            {lesson.screens.length
              ? `${String(lesson.screens.length)} ${vi ? 'cảnh' : 'scenes'}`
              : active
                ? vi
                  ? 'Đang chuẩn bị nội dung'
                  : 'Preparing lesson content'
                : vi
                  ? 'Chưa có kịch bản'
                  : 'No script yet'}
          </span>
          {active && (
            <div className="lesson-card-progress">
              <progress
                aria-label={vi ? 'Số cảnh đã dựng' : 'Rendered scenes'}
                max={lesson.screens.length || 1}
                value={lesson.screens.length ? rendered : undefined}
              />
              <span>
                {lesson.screens.length
                  ? `${String(rendered)}/${String(lesson.screens.length)} ${vi ? 'cảnh đã dựng' : 'scenes rendered'}`
                  : vi
                    ? 'Bạn có thể quay lại sau'
                    : 'You can come back later'}
              </span>
            </div>
          )}
          <div className="lesson-card-footer">
            <span>
              <IconSchool size={15} aria-hidden="true" />
              {className}
            </span>
            {Number.isNaN(date.getTime()) ? null : (
              <time dateTime={lesson.createdAt}>
                {new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en', {
                  day: 'numeric',
                  month: 'short',
                }).format(date)}
              </time>
            )}
          </div>
          <span className="lesson-card-action">
            {action}
            <IconArrowRight size={15} aria-hidden="true" />
          </span>
        </div>
      </button>
    </article>
  );
}
