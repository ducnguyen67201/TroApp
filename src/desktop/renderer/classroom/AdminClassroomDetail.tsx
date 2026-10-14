import type { ReactElement } from 'react';
import { Accordion, Badge, Card, Group, Select, Stack, Table, Text } from '@mantine/core';
import {
  ClassroomPacing,
  ClassroomStatus,
  type AdminClassroomDetail as ClassroomDetail,
} from '#contracts/Classroom.js';
import { formatPhaseLabel, type ClassroomTranslate } from './ClassroomLabels.js';

/** Read-only summaries intentionally expose no teacher controls or participation actions. */
export function AdminClassroomDetail({
  detail,
  t,
  onSessionChange,
}: {
  detail: ClassroomDetail;
  t: ClassroomTranslate;
  onSessionChange: (classSessionId: string | null) => void;
}): ReactElement {
  const activities = detail.course.content.modules.flatMap((module) =>
    module.lessons.flatMap((lesson) => lesson.activities),
  );
  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="lg">
        <Stack gap="xs">
          <Group justify="space-between">
            <Text component="h2" size="xl" fw={600}>
              {detail.schoolClass.name}
            </Text>
            <Badge variant="light">{t('Read only', 'Chỉ đọc')}</Badge>
          </Group>
          <Text>
            {t('Teacher', 'Giáo viên')}: {detail.teacherName}
          </Text>
          <Text size="sm" c="dimmed">
            {detail.teacherEmail}
          </Text>
          <Text>
            {t('Course', 'Khóa học')}: {detail.course.title}
          </Text>
        </Stack>
      </Card>
      <section aria-label={t('Course activities', 'Hoạt động khóa học')}>
        <Text component="h2" size="lg" fw={600} mb="sm">
          {t('Course activities', 'Hoạt động khóa học')}
        </Text>
        <Accordion variant="separated">
          {detail.course.content.modules.flatMap((module) =>
            module.lessons.flatMap((lesson) =>
              lesson.activities.map((activity) => (
                <Accordion.Item key={activity.id} value={activity.id}>
                  <Accordion.Control>
                    <Text fw={500}>{activity.title}</Text>
                    <Text size="xs" c="dimmed">
                      {module.title} · {lesson.title}
                    </Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Text>{activity.objective}</Text>
                      {activity.instructions && (
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {activity.instructions}
                        </Text>
                      )}
                      {activity.criteria.length > 0 && (
                        <div>
                          <Text fw={500} size="sm">
                            {t('Success criteria', 'Tiêu chí hoàn thành')}
                          </Text>
                          <ul>
                            {activity.criteria.map((criterion) => (
                              <li key={criterion.id}>{criterion.description}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {activity.materials.length > 0 && (
                        <Stack gap="xs">
                          <Text fw={500} size="sm">
                            {t('Material links', 'Đường dẫn tài liệu')}
                          </Text>
                          {activity.materials.map((material) => (
                            <div key={material.id}>
                              <Text size="sm" fw={500}>
                                {material.title}
                              </Text>
                              <Text size="xs" c="dimmed" className="material-link">
                                {material.url}
                              </Text>
                              {material.summary && <Text size="sm">{material.summary}</Text>}
                            </div>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              )),
            ),
          )}
        </Accordion>
      </section>
      <section aria-label={t('Sessions and students', 'Buổi học và học sinh')}>
        <Text component="h2" size="lg" fw={600} mb="sm">
          {t('Sessions and students', 'Buổi học và học sinh')}
        </Text>
        {detail.meetings.length === 0 && (
          <Text c="dimmed">
            {t('This class has no sessions yet.', 'Lớp này chưa có buổi học.')}
          </Text>
        )}
        {detail.meetings.length > 0 && (
          <Select
            label={t('Session to view', 'Buổi học muốn xem')}
            mb="md"
            value={detail.rosters[0]?.classSessionId ?? null}
            allowDeselect={false}
            data={detail.meetings.map((meeting, index) => ({
              value: meeting.id,
              label: `${t('Session', 'Buổi học')} ${String(index + 1)} · ${meeting.status === ClassroomStatus.LIVE ? t('Live now', 'Đang diễn ra') : t('Ended', 'Đã kết thúc')}`,
            }))}
            onChange={onSessionChange}
          />
        )}
        <Stack gap="md">
          {detail.rosters.map((roster) => {
            const meeting = detail.meetings.find((entry) => entry.id === roster.classSessionId);
            if (!meeting) {
              return null;
            }
            const index = detail.meetings.indexOf(meeting);
            const students = roster.students;
            return (
              <Card key={meeting.id} withBorder radius="md" padding="lg">
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text component="h3" fw={600}>
                      {t('Session', 'Buổi học')} {index + 1}
                    </Text>
                    <Badge
                      color={meeting.status === ClassroomStatus.LIVE ? 'green' : 'gray'}
                      variant="light"
                    >
                      {meeting.status === ClassroomStatus.LIVE
                        ? t('Live now', 'Đang diễn ra')
                        : t('Ended', 'Đã kết thúc')}
                    </Badge>
                  </Group>
                  <Text size="sm">
                    {formatPhaseLabel(meeting.phase, t)} ·{' '}
                    {meeting.pacing === ClassroomPacing.TEACHER
                      ? t('Teacher-paced', 'Cùng giáo viên')
                      : t('Self-paced', 'Tự chọn phần học')}
                  </Text>
                  <Text size="sm">
                    {t('Current activity', 'Hoạt động hiện tại')}:{' '}
                    {activities.find((activity) => activity.id === meeting.currentActivityId)
                      ?.title ?? t('Unavailable', 'Không có')}
                  </Text>
                  {students.length === 0 ? (
                    <Text c="dimmed" size="sm">
                      {t('No students to show.', 'Chưa có học sinh để hiển thị.')}
                    </Text>
                  ) : (
                    <Table.ScrollContainer minWidth={480}>
                      <Table captionSide="top">
                        <Table.Caption>
                          {t('Session roster', 'Danh sách học sinh theo buổi')}
                        </Table.Caption>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('Student', 'Học sinh')}</Table.Th>
                            <Table.Th>{t('Participation', 'Tham gia')}</Table.Th>
                            <Table.Th>
                              {t('Activities marked complete', 'Hoạt động đã đánh dấu hoàn thành')}
                            </Table.Th>
                            <Table.Th>{t('Submissions', 'Bài đã nộp')}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {students.map((student) => (
                            <Table.Tr key={student.studentId}>
                              <Table.Td>{student.name}</Table.Td>
                              <Table.Td>
                                {!student.participation
                                  ? t('Not joined', 'Chưa tham gia')
                                  : student.participation.left
                                    ? t('Left', 'Đã rời')
                                    : t('Joined', 'Đã tham gia')}
                              </Table.Td>
                              <Table.Td>
                                {
                                  student.attempts.filter((attempt) => attempt.declaredComplete)
                                    .length
                                }
                              </Table.Td>
                              <Table.Td>{student.submissions.length}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                </Stack>
              </Card>
            );
          })}
        </Stack>
      </section>
    </Stack>
  );
}
