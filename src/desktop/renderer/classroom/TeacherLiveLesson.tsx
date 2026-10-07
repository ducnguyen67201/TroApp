import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ActionIcon, Button, Loader, Menu, Text } from '@mantine/core';
import { IconArrowRight, IconCheck, IconDots, IconPlayerStop } from '@tabler/icons-react';
import {
  ClassroomPacing,
  ClassroomPhase,
  type ClassroomCommand,
  type ClassroomHome,
} from '#contracts/Classroom.js';
import { ClassSessionBadge } from './ClassSessionBadge.js';
import { formatPhaseLabel, type ClassroomTranslate } from './ClassroomLabels.js';

type SessionChange = Pick<
  Extract<ClassroomCommand, { kind: 'update-session' }>,
  'activityId' | 'phase' | 'pacing'
>;
type LiveMeeting = ClassroomHome['classes'][number]['meetings'][number];

interface TeacherLiveLessonProps {
  meeting: LiveMeeting;
  activities: ClassroomHome['courses'][number]['activities'];
  busy: boolean;
  error: string | null;
  onUpdate: (change: SessionChange) => Promise<void>;
  onEnd: () => void;
  t: ClassroomTranslate;
}

/** Uses confirmed session state for every highlight; choosing a row only reveals controls. */
export function TeacherLiveLesson({
  meeting,
  activities,
  busy,
  error,
  onUpdate,
  onEnd,
  t,
}: TeacherLiveLessonProps): ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<SessionChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const inFlight = useRef(false);
  const currentIndex = activities.findIndex(
    (activity) => activity.id === meeting.currentActivityId,
  );
  const nextActivity = currentIndex >= 0 ? activities[currentIndex + 1] : undefined;
  const savedLastChange =
    lastChange !== null &&
    meeting.currentActivityId === lastChange.activityId &&
    meeting.phase === lastChange.phase &&
    meeting.pacing === lastChange.pacing;
  const canRetry =
    lastChange !== null && !savedLastChange && !saving && (Boolean(error) || requestFailed);
  const disabled = busy || saving;

  useEffect(() => {
    setExpandedId(null);
  }, [meeting.currentActivityId]);

  useEffect(() => {
    if (error && lastChange && !savedLastChange && !saving) {
      setRequestFailed(true);
    }
  }, [error, lastChange, savedLastChange, saving]);

  async function saveChange(change: SessionChange): Promise<void> {
    if (busy || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setLastChange(change);
    setSaving(true);
    setRequestFailed(false);
    try {
      await onUpdate(change);
    } catch {
      setRequestFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section
      className="teacher-live-lesson"
      aria-label={t('Live lesson controls', 'Điều khiển buổi học')}
    >
      <div className="teacher-live-bar">
        <div className="teacher-live-bar-summary">
          <ClassSessionBadge live t={t} />
          <Text size="sm" fw={600}>
            {currentIndex >= 0
              ? `${t('Section', 'Phần')} ${String(currentIndex + 1)}/${String(activities.length)} · `
              : ''}
            {formatPhaseLabel(meeting.phase, t)}
          </Text>
          {saving && (
            <span className="teacher-live-saving" role="status">
              <Loader size={14} />
              {t('Updating…', 'Đang cập nhật…')}
            </span>
          )}
        </div>
        <div className="teacher-live-bar-actions">
          <Button
            size="sm"
            rightSection={<IconArrowRight size={16} />}
            disabled={disabled || !nextActivity}
            title={
              !nextActivity ? t('You are on the last section', 'Đây là phần học cuối') : undefined
            }
            onClick={() => {
              if (nextActivity) {
                void saveChange({
                  activityId: nextActivity.id,
                  phase: ClassroomPhase.EXPLANATION,
                  pacing: meeting.pacing,
                });
              }
            }}
          >
            {t('Next section', 'Phần tiếp theo')}
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t('Session options', 'Tùy chọn buổi học')}
                disabled={disabled}
              >
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{t('Student pacing', 'Cách học của học sinh')}</Menu.Label>
              {[ClassroomPacing.TEACHER, ClassroomPacing.STUDENT].map((pacing) => (
                <Menu.Item
                  disabled={disabled}
                  key={pacing}
                  leftSection={meeting.pacing === pacing ? <IconCheck size={14} /> : undefined}
                  onClick={() => {
                    if (pacing !== meeting.pacing) {
                      void saveChange({
                        activityId: meeting.currentActivityId,
                        phase: meeting.phase,
                        pacing,
                      });
                    }
                  }}
                >
                  {pacing === ClassroomPacing.TEACHER
                    ? t('Teacher-paced', 'Cùng giáo viên')
                    : t('Self-paced', 'Tự chọn phần học')}
                </Menu.Item>
              ))}
              <Menu.Divider />
              <Menu.Item
                disabled={disabled}
                color="red"
                leftSection={<IconPlayerStop size={14} />}
                onClick={onEnd}
              >
                {t('End session', 'Kết thúc buổi học')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
        {canRetry && (
          <div className="teacher-live-error" role="alert">
            <span>
              {t(
                'Change wasn’t saved. The class is still on the previous stage.',
                'Chưa lưu được thay đổi. Lớp vẫn ở giai đoạn trước.',
              )}
            </span>
            <Button
              size="xs"
              variant="default"
              disabled={disabled}
              onClick={() => {
                void saveChange(lastChange);
              }}
            >
              {t('Retry', 'Thử lại')}
            </Button>
          </div>
        )}
      </div>
      <div className="teacher-live-sections">
        {activities.map((activity, index) => {
          const current = activity.id === meeting.currentActivityId;
          const expanded = current || activity.id === expandedId;
          return (
            <section
              className="teacher-live-section"
              key={activity.id}
              data-current={current}
              aria-label={activity.title}
            >
              <button
                type="button"
                className="classroom-section-row"
                aria-expanded={expanded}
                data-current={current}
                disabled={disabled}
                onClick={() => {
                  setExpandedId(expandedId === activity.id ? null : activity.id);
                }}
              >
                <span className="classroom-section-number">{index + 1}</span>
                <span>{activity.title}</span>
                <span className="classroom-section-status">
                  {current ? (
                    <>
                      <span className="teacher-live-current-badge">
                        <span className="teacher-live-current-dot" aria-hidden="true" />
                        {t('Now', 'Đang học')}
                      </span>
                      <span>{formatPhaseLabel(meeting.phase, t)}</span>
                    </>
                  ) : expanded ? (
                    t('Choose a stage', 'Chọn giai đoạn')
                  ) : (
                    t('Choose section', 'Chọn phần học')
                  )}
                </span>
              </button>
              {expanded && (
                <div
                  className="teacher-live-phases"
                  role="group"
                  aria-label={t('Lesson stage', 'Giai đoạn buổi học')}
                >
                  {[ClassroomPhase.EXPLANATION, ClassroomPhase.PRACTICE, ClassroomPhase.REVIEW].map(
                    (phase) => (
                      <button
                        type="button"
                        className="teacher-live-phase"
                        key={phase}
                        aria-pressed={current && meeting.phase === phase}
                        disabled={disabled}
                        onClick={() => {
                          if (!current || phase !== meeting.phase) {
                            void saveChange({
                              activityId: activity.id,
                              phase,
                              pacing: meeting.pacing,
                            });
                          }
                        }}
                      >
                        {current && meeting.phase === phase && (
                          <IconCheck size={14} aria-hidden="true" />
                        )}
                        {formatPhaseLabel(phase, t)}
                      </button>
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
