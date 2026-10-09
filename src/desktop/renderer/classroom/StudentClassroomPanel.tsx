import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import { useEffect, useState, type ReactElement } from 'react';
import { Button, Stack, Tabs, Text } from '@mantine/core';
import { IconArrowRight, IconBooks, IconSchool } from '@tabler/icons-react';
import {
  ClassroomStatus,
  type ClassroomCommand,
  type ClassroomHome,
  type ClassroomReply,
  type TeachingContext,
} from '#contracts/Classroom.js';
import { ClassView } from '../navigation/DesktopRoute.js';
import type { DesktopNavigation } from '../navigation/UseDesktopNavigation.js';
import { ClassArtwork } from './ClassArtwork.js';
import { ClassSessionBadge } from './ClassSessionBadge.js';
import { StudentActivityPanel } from './StudentActivityPanel.js';
import { StudentMaterials } from './StudentMaterials.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

const StudentClassroomView = {
  CLASSES: 'classes',
  ACTIVITIES: 'activities',
  MATERIALS: 'materials',
} as const;
interface StudentClassroomPanelProps {
  home: ClassroomHome;
  navigation?: DesktopNavigation;
  userId: string;
  practiceReview?: PracticeShortcutEvent | undefined;
  context: TeachingContext | null;
  search: string;
  busy: boolean;
  send: (command: ClassroomCommand) => Promise<void>;
  preparation: Extract<ClassroomReply, { kind: 'prepared' }> | null;
  receipt: Extract<ClassroomReply, { kind: 'submitted' }> | null;
  t: ClassroomTranslate;
  onAskForHelp?: (message?: string) => void;
}

/** Class selection is local browsing; session participation still requires Join. */
export function StudentClassroomPanel({
  home,
  navigation,
  userId,
  context,
  practiceReview,
  search,
  busy,
  send,
  preparation,
  receipt,
  t,
  onAskForHelp,
}: StudentClassroomPanelProps): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localView, setLocalView] = useState<string | null>(StudentClassroomView.CLASSES);
  const isClassPage = Boolean(navigation?.route.classId);
  const view =
    navigation && isClassPage
      ? navigation.route.classView === ClassView.MATERIALS
        ? StudentClassroomView.MATERIALS
        : StudentClassroomView.ACTIVITIES
      : localView;
  const classes = home.classes.filter((entry) => entry.schoolClass.teacherId !== userId);
  const selected = isClassPage
    ? classes.find((entry) => entry.schoolClass.id === navigation?.route.classId)
    : (classes.find((entry) => entry.schoolClass.id === selectedId) ??
      classes.find((entry) => entry.schoolClass.id === context?.meeting.classId) ??
      classes[0]);
  const course = home.courses.find((entry) => entry.id === selected?.schoolClass.courseRevisionId);
  const joined = context && context.meeting.classId === selected?.schoolClass.id ? context : null;
  const live = selected?.meetings.find((meeting) => meeting.status === ClassroomStatus.LIVE);
  const activities = joined?.availableActivities ?? course?.activities ?? [];
  const matching = classes.filter((entry) =>
    entry.schoolClass.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    if (navigation?.route.classId && !selected) {
      navigation.openClassroom();
    }
  }, [navigation?.route.classId, navigation?.openClassroom, selected]);

  function setView(nextView: string | null): void {
    if (navigation && selected && nextView !== StudentClassroomView.CLASSES) {
      navigation.openClass(
        selected.schoolClass.id,
        nextView === StudentClassroomView.MATERIALS ? ClassView.MATERIALS : ClassView.ACTIVITIES,
      );
    } else {
      setLocalView(nextView);
    }
  }

  function selectActivity(activityId: string): void {
    if (joined) {
      void send({
        kind: 'context',
        participationId: joined.participation.id,
        deviceId: joined.participation.deviceId,
        activityId,
      });
    }
  }

  const sections = (
    <section className="classroom-sections" aria-label={t('Lesson sections', 'Các phần học')}>
      <Text fw={600} size="lg">
        {t('Your learning path', 'Lộ trình buổi học')}
      </Text>
      {activities.length > 0 ? (
        <div className="classroom-section-list">
          {activities.map((activity, index) => (
            <button
              key={activity.id}
              className="classroom-section-row"
              data-current={joined?.activity.id === activity.id || undefined}
              disabled={!joined || busy}
              onClick={() => {
                selectActivity(activity.id);
              }}
            >
              <span className="classroom-section-number">{index + 1}</span>
              <span>{activity.title}</span>
              {joined?.activity.id === activity.id && (
                <small>{t('Current activity', 'Đang làm')}</small>
              )}
            </button>
          ))}
        </div>
      ) : (
        <Text c="dimmed" size="sm" mt="sm">
          {t(
            'Your teacher will share the sections when the class is ready.',
            'Giáo viên sẽ chia sẻ các phần học khi lớp sẵn sàng.',
          )}
        </Text>
      )}
      {joined && (
        <div className="classroom-activity-notes">
          <Text fw={500}>{joined.activity.objective}</Text>
          <Text size="sm" className="material-prose">
            {joined.activity.instructions}
          </Text>
          {joined.activity.prerequisites.length > 0 && (
            <>
              <Text fw={500} size="sm" mt="md">
                {t('Before you start', 'Trước khi bắt đầu')}
              </Text>
              <ul>
                {joined.activity.prerequisites.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          <Text fw={500} size="sm" mt="md">
            {t('What to check', 'Những điều cần kiểm tra')}
          </Text>
          <ul>
            {joined.activity.criteria.map((criterion) => (
              <li key={criterion.id}>{criterion.description}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );

  return (
    <Tabs keepMounted={false} className="classroom-tabs" value={view} onChange={setView}>
      <Tabs.List>
        {!isClassPage && (
          <Tabs.Tab value={StudentClassroomView.CLASSES} leftSection={<IconSchool size={16} />}>
            {t('Your classes', 'Lớp của bạn')}{' '}
            <span className="classroom-count">{classes.length}</span>
          </Tabs.Tab>
        )}
        <Tabs.Tab value={StudentClassroomView.ACTIVITIES} leftSection={<IconBooks size={16} />}>
          {t('Activities', 'Hoạt động')}
        </Tabs.Tab>
        <Tabs.Tab value={StudentClassroomView.MATERIALS}>{t('Materials', 'Tài liệu')}</Tabs.Tab>
      </Tabs.List>
      <div className="classroom-experience-grid">
        <div>
          <Tabs.Panel value={StudentClassroomView.CLASSES}>
            <Text fw={600} size="lg" mb="md">
              {t('Pick a class', 'Chọn một lớp học')}
            </Text>
            {matching.length > 0 ? (
              <div className="classroom-class-grid">
                {matching.map((entry, index) => {
                  const meeting = entry.meetings.find(
                    (item) => item.status === ClassroomStatus.LIVE,
                  );
                  const linkedCourse = home.courses.find(
                    (item) => item.id === entry.schoolClass.courseRevisionId,
                  );
                  return (
                    <button
                      key={entry.schoolClass.id}
                      className="classroom-class-card"
                      data-selected={selected?.schoolClass.id === entry.schoolClass.id || undefined}
                      aria-pressed={selected?.schoolClass.id === entry.schoolClass.id}
                      onClick={() => {
                        if (navigation) {
                          navigation.openClass(entry.schoolClass.id, ClassView.ACTIVITIES);
                        } else {
                          setSelectedId(entry.schoolClass.id);
                        }
                      }}
                    >
                      <ClassSessionBadge live={Boolean(meeting)} t={t} />
                      <ClassArtwork
                        kind={index % 3 === 0 ? 'lesson' : index % 3 === 1 ? 'code' : 'design'}
                        className="classroom-card-art"
                      />
                      <span className="classroom-card-title">{entry.schoolClass.name}</span>
                      <span className="classroom-card-copy">
                        {linkedCourse?.title ?? t('Your classroom', 'Lớp học của bạn')}
                      </span>
                      <span className="classroom-card-meta">
                        {linkedCourse
                          ? `${String(linkedCourse.activities.length)} ${t('sections', 'phần học')}`
                          : t('Materials from your teacher', 'Tài liệu từ giáo viên')}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="classroom-empty">
                <ClassArtwork kind="books" className="classroom-empty-art" />
                <Text fw={600}>
                  {classes.length === 0
                    ? t('Your next adventure starts here.', 'Một hành trình mới bắt đầu từ đây.')
                    : t('No matching classes', 'Không tìm thấy lớp phù hợp')}
                </Text>
                <Text size="sm" c="dimmed">
                  {classes.length === 0
                    ? t(
                        'Use a code from your teacher to join your class.',
                        'Nhập mã giáo viên cung cấp để vào lớp của bạn.',
                      )
                    : t('Try a different class name.', 'Thử tìm bằng tên lớp khác.')}
                </Text>
              </div>
            )}
            {selected && sections}
            <div className="classroom-note">
              <Text fw={600} size="sm">
                {t('You don’t have to know everything.', 'Không cần biết hết mọi thứ.')}
              </Text>
              <Text size="sm" c="dimmed">
                {t(
                  'Try something. Ask a question. Tro is here when you need a hint.',
                  'Thử một chút, hỏi một câu. Tro ở đây khi bạn cần một gợi ý.',
                )}
              </Text>
            </div>
          </Tabs.Panel>
          <Tabs.Panel value={StudentClassroomView.ACTIVITIES}>{sections}</Tabs.Panel>
          <Tabs.Panel value={StudentClassroomView.MATERIALS}>
            {joined ? (
              <StudentMaterials context={joined} t={t} />
            ) : (
              <div className="classroom-empty">
                <IconBooks size={32} stroke={1.4} />
                <Text size="sm" c="dimmed">
                  {t(
                    'Join the session to see its shared materials.',
                    'Vào buổi học để xem tài liệu được chia sẻ.',
                  )}
                </Text>
              </div>
            )}
          </Tabs.Panel>
        </div>
        <aside className="classroom-detail" aria-label={t('Class details', 'Chi tiết lớp học')}>
          {selected && (
            <div className="classroom-detail-status">
              <ClassSessionBadge live={Boolean(live)} t={t} />
            </div>
          )}
          <ClassArtwork kind="books" className="classroom-detail-art" />
          {joined ? (
            <StudentActivityPanel
              context={joined}
              practiceReview={practiceReview}
              busy={busy}
              send={send}
              preparation={preparation}
              receipt={receipt}
              t={t}
              onShowMaterials={() => {
                setView(StudentClassroomView.MATERIALS);
              }}
              {...(onAskForHelp ? { onAskForHelp } : {})}
            />
          ) : (
            <Stack gap="md">
              <Text size="xs" className="classroom-eyebrow">
                {t('Your classroom', 'Lớp học của bạn')}
              </Text>
              <h2 className="classroom-detail-heading">
                {selected?.schoolClass.name ?? t('A place to learn together', 'Cùng nhau khám phá')}
              </h2>
              <Text c="dimmed" size="sm">
                {live
                  ? t(
                      'Your teacher has started a session. Join when you are ready.',
                      'Giáo viên đã bắt đầu buổi học. Vào lớp khi bạn sẵn sàng.',
                    )
                  : t(
                      'Your teacher leads the lesson. Tro helps when you have a question.',
                      'Giáo viên dẫn dắt buổi học. Tro giúp khi bạn có câu hỏi.',
                    )}
              </Text>
              {live && (
                <Button
                  fullWidth
                  disabled={busy}
                  rightSection={<IconArrowRight size={16} />}
                  onClick={() => {
                    void send({
                      kind: 'join',
                      classSessionId: live.id,
                      deviceId: crypto.randomUUID(),
                    });
                  }}
                >
                  {t('Join session', 'Vào buổi học')}
                </Button>
              )}
            </Stack>
          )}
        </aside>
      </div>
    </Tabs>
  );
}
