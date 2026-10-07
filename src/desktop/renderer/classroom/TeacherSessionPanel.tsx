import type { ReactElement } from 'react';
import { Button, Select, Text } from '@mantine/core';
import { ClassroomPacing } from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

interface TeacherSessionPanelProps {
  sectionTitle: string | null;
  pacing: string;
  busy: boolean;
  canStart: boolean;
  onPacingChange: (value: string) => void;
  onStart: () => void;
  t: ClassroomTranslate;
}

/** Prepares the initial session; live transitions belong beside the lesson rows. */
export function TeacherSessionPanel({
  sectionTitle,
  pacing,
  busy,
  canStart,
  onPacingChange,
  onStart,
  t,
}: TeacherSessionPanelProps): ReactElement {
  return (
    <section className="teacher-session-panel" aria-label={t('Session controls', 'Buổi học')}>
      <div className="teacher-session-heading">
        <Text component="h3">{t('Session', 'Buổi học')}</Text>
        <span className="teacher-session-status">{t('Not started', 'Chưa bắt đầu')}</span>
      </div>
      <div className="teacher-session-section">
        <Text size="xs" c="dimmed">
          {t('Start with', 'Bắt đầu với')}
        </Text>
        <Text size="sm" fw={600}>
          {sectionTitle ?? t('Choose a section from the list', 'Chọn phần học trong danh sách')}
        </Text>
      </div>
      <Select
        label={t('Student pacing', 'Cách học của học sinh')}
        value={pacing}
        disabled={busy}
        data={[
          { value: ClassroomPacing.TEACHER, label: t('Teacher-paced', 'Cùng giáo viên') },
          { value: ClassroomPacing.STUDENT, label: t('Self-paced', 'Tự chọn phần học') },
        ]}
        onChange={(value) => {
          if (value) {
            onPacingChange(value);
          }
        }}
        description={
          pacing === ClassroomPacing.STUDENT
            ? t('Students choose their own section.', 'Học sinh tự chọn phần để làm.')
            : t('Everyone follows the section you choose.', 'Cả lớp theo phần học bạn chọn.')
        }
      />
      <Button fullWidth disabled={!canStart || busy} onClick={onStart}>
        {t('Start session', 'Bắt đầu buổi học')}
      </Button>
    </section>
  );
}
