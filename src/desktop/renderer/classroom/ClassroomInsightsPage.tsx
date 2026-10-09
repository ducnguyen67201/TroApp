import { Select, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import type { ClassroomHome, TeachingContext } from '#contracts/Classroom.js';
import { ClassroomInsightsPanel } from './ClassroomInsightsPanel.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** Uses the authorized classroom roster; a selected route never grants access. */
export function ClassroomInsightsPage({
  home,
  userId,
  classId,
  context,
  t,
}: {
  home: ClassroomHome;
  userId: string;
  classId: string | null;
  context: TeachingContext | null;
  t: ClassroomTranslate;
}): ReactElement {
  const selected =
    home.classes.find((entry) => entry.schoolClass.id === classId) ?? home.classes[0];
  return (
    <Stack gap="lg">
      <Select
        label={t('Class', 'Lớp')}
        placeholder={t('Choose a class', 'Chọn lớp')}
        value={selected?.schoolClass.id ?? null}
        data={home.classes.map((entry) => ({
          value: entry.schoolClass.id,
          label: entry.schoolClass.name,
        }))}
        searchable
        allowDeselect={false}
        onChange={(selectedClassId) => {
          if (selectedClassId) {
            window.location.hash = `#/insights/${selectedClassId}`;
          }
        }}
      />
      {selected ? (
        <ClassroomInsightsPanel
          key={`${userId}:${selected.schoolClass.id}`}
          userId={userId}
          classId={selected.schoolClass.id}
          teacher={selected.schoolClass.teacherId === userId}
          context={context?.meeting.classId === selected.schoolClass.id ? context : null}
        />
      ) : (
        <Text c="dimmed">
          {t(
            'Create or join a class to view learning insights.',
            'Tạo hoặc tham gia lớp để xem tiến độ học tập.',
          )}
        </Text>
      )}
    </Stack>
  );
}
