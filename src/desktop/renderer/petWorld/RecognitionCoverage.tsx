import type { ReactElement } from 'react';
import { Badge, Group, Text } from '@mantine/core';
import type { PetWorldReply } from '#contracts/PetWorld.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

type RecognitionView = Extract<PetWorldReply, { kind: 'class-recognition' }>;

/** Describes who has a recorded recognition without inferring mastery or attention. */
export function RecognitionCoverage({
  recognition,
  t,
}: {
  recognition: RecognitionView;
  t: PetWorldTranslate;
}): ReactElement {
  return (
    <section className="pet-world-panel" aria-label={t('Recognition coverage', 'Phạm vi ghi nhận')}>
      <Group justify="space-between" mb="sm">
        <h2>{t('Make room for every student.', 'Dành chỗ cho mọi học sinh.')}</h2>
        <Badge variant="light">
          {recognition.coverage.recognizedStudents} / {recognition.coverage.eligibleStudents}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t(
          'Current enrolled students with a recorded, uncorrected recognition in the selected period. This describes recognition, not learning progress.',
          'Học sinh hiện ghi danh có sự ghi nhận chưa bị sửa trong khoảng thời gian đã chọn. Đây là dữ liệu ghi nhận, không phải tiến độ học tập.',
        )}
      </Text>
      <div className="pet-world-coverage">
        {recognition.roster.map((student) => (
          <article key={student.studentId}>
            <Text size="sm" fw={600}>
              {student.displayName}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              {recognition.coverage.recognizedStudentIds.includes(student.studentId)
                ? t('A moment recognized', 'Đã có khoảnh khắc được ghi nhận')
                : t(
                    'No recognition recorded in this period',
                    'Chưa có ghi nhận trong thời gian này',
                  )}
            </Text>
          </article>
        ))}
      </div>
    </section>
  );
}
