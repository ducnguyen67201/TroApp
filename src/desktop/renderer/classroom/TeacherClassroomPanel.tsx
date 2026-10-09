import { PracticeTeacherResults } from './PracticeTeacherResults.js';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Button, Group, Modal, Select, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import {
  ClassroomPacing,
  ClassroomStatus,
  type ClassroomCommand,
  type ClassroomHome,
  type ClassroomInvitation,
  type ClassroomRosterSchema,
} from '#contracts/Classroom.js';
import type { z } from 'zod';
import { ClassArtwork } from './ClassArtwork.js';
import { ClassSessionBadge } from './ClassSessionBadge.js';
import { ClassSettings } from './ClassSettings.js';
import { ClassView } from '../navigation/DesktopRoute.js';
import type { DesktopNavigation } from '../navigation/UseDesktopNavigation.js';
import { MaterialEditor } from './MaterialEditor.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import { TeacherSessionPanel } from './TeacherSessionPanel.js';
import { TeacherLiveLesson } from './TeacherLiveLesson.js';

interface TeacherClassroomProps {
  home: ClassroomHome;
  navigation: DesktopNavigation;
  userId: string;
  busy: boolean;
  send: (command: ClassroomCommand) => Promise<void>;
  roster: z.infer<typeof ClassroomRosterSchema> | null;
  onClassChange: () => void;
  invitation: ClassroomInvitation | null;
  t: ClassroomTranslate;
  refresh: () => Promise<void>;
  search?: string;
  error?: string | null;
}

export function TeacherClassroomPanel({
  home,
  navigation,
  userId,
  busy,
  send,
  roster,
  onClassChange,
  invitation,
  t,
  refresh,
  search = '',
  error = null,
}: TeacherClassroomProps): ReactElement {
  const [preparationSidebar, setPreparationSidebar] = useState<HTMLDivElement | null>(null);
  const [className, setClassName] = useState('');
  const [createOpened, setCreateOpened] = useState(false);
  const classId =
    navigation.route.classId ??
    home.classes.find((entry) => entry.schoolClass.teacherId === userId)?.schoolClass.id ??
    null;
  const isClassPage = navigation.route.classId !== null;
  const tab = isClassPage ? navigation.route.classView : ClassView.OVERVIEW;
  const previousClassId = useRef(classId);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [pacing, setPacing] = useState<string>(ClassroomPacing.TEACHER);
  const ownedClasses = useMemo(
    () => home.classes.filter((entry) => entry.schoolClass.teacherId === userId),
    [home.classes, userId],
  );
  const selectedClass = ownedClasses.find((entry) => entry.schoolClass.id === classId);
  const selectedCourse = home.courses.find(
    (course) => course.id === selectedClass?.schoolClass.courseRevisionId,
  );
  const activities = selectedCourse?.activities ?? [];
  const liveMeeting = selectedClass?.meetings.find(
    (meeting) => meeting.status === ClassroomStatus.LIVE,
  );
  const showsLiveLesson = Boolean(isClassPage && liveMeeting && tab === ClassView.OVERVIEW);
  const searchText = search.trim().toLocaleLowerCase();
  const visibleClasses = ownedClasses.filter((entry) => {
    const course = home.courses.find(
      (candidate) => candidate.id === entry.schoolClass.courseRevisionId,
    );
    return `${entry.schoolClass.name} ${course?.title ?? ''}`
      .toLocaleLowerCase()
      .includes(searchText);
  });

  useEffect(() => {
    if (previousClassId.current !== classId) {
      previousClassId.current = classId;
      onClassChange();
    }
    if (isClassPage && navigation.route.classView === ClassView.ACTIVITIES && classId) {
      navigation.openClass(classId, ClassView.OVERVIEW);
    }
    if (isClassPage && !ownedClasses.some((entry) => entry.schoolClass.id === classId)) {
      navigation.openClassroom();
    }
  }, [
    ownedClasses,
    classId,
    isClassPage,
    navigation.openClassroom,
    navigation.openClass,
    navigation.route.classView,
    onClassChange,
  ]);

  useEffect(() => {
    setActivityId(selectedCourse?.activities[0]?.id ?? null);
  }, [selectedCourse?.id, selectedClass?.schoolClass.id]);

  useEffect(() => {
    setPacing(liveMeeting?.pacing ?? ClassroomPacing.TEACHER);
  }, [liveMeeting?.id, liveMeeting?.pacing]);

  function selectClass(nextClassId: string | null): void {
    if (nextClassId) {
      navigation.openClass(nextClassId, ClassView.OVERVIEW);
    }
  }

  function setTab(nextView: string | null): void {
    if (
      classId &&
      (nextView === ClassView.OVERVIEW ||
        nextView === ClassView.MATERIALS ||
        nextView === ClassView.SETTINGS)
    ) {
      navigation.openClass(classId, nextView);
    }
  }

  return (
    <Tabs className="classroom-tabs" value={tab} onChange={setTab}>
      <Modal
        opened={createOpened}
        onClose={() => {
          if (!busy) {
            setCreateOpened(false);
          }
        }}
        title={t('Create a class', 'Tạo lớp học')}
        closeOnEscape={!busy}
        closeOnClickOutside={!busy}
        withCloseButton={!busy}
        centered
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!className.trim() || busy) {
              return;
            }
            void send({ kind: 'create-class', name: className }).then(() => {
              setCreateOpened(false);
            });
          }}
        >
          <Stack gap="md">
            <TextInput
              label={t('Class name', 'Tên lớp')}
              data-autofocus
              value={className}
              maxLength={200}
              disabled={busy}
              onChange={(event) => {
                setClassName(event.currentTarget.value);
              }}
            />
            <Group justify="flex-end">
              <Button
                variant="default"
                disabled={busy}
                onClick={() => {
                  setCreateOpened(false);
                }}
              >
                {t('Cancel', 'Hủy')}
              </Button>
              <Button type="submit" disabled={!className.trim() || busy} loading={busy}>
                {t('Create class', 'Tạo lớp')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <div className="classroom-tabs-toolbar">
        <Tabs.List>
          <Tabs.Tab value="classes">
            {isClassPage ? t('Overview', 'Tổng quan') : t('My classes', 'Lớp của tôi')}
          </Tabs.Tab>
          <Tabs.Tab value="lessons">{t('Class materials', 'Tài liệu lớp học')}</Tabs.Tab>
          {isClassPage && (
            <Tabs.Tab value="settings">{t('Class settings', 'Cài đặt lớp')}</Tabs.Tab>
          )}
        </Tabs.List>
        {!isClassPage && (
          <Button
            variant="default"
            size="sm"
            leftSection={<IconPlus size={16} />}
            disabled={busy}
            onClick={() => {
              setCreateOpened(true);
            }}
          >
            {t('Create a class', 'Tạo lớp học')}
          </Button>
        )}
      </div>
      <div className="classroom-experience-grid" data-live-lesson={showsLiveLesson || undefined}>
        <div className="classroom-overview">
          <Tabs.Panel value="classes">
            <Stack className="classroom-overview" gap="lg">
              {!isClassPage && (
                <>
                  <Group className="classroom-overview-heading" justify="space-between">
                    <Text component="h2">{t('Your classes', 'Các lớp của bạn')}</Text>
                    <Text size="sm" c="dimmed">
                      {ownedClasses.length} {t('classes', 'lớp')}
                    </Text>
                  </Group>
                  <div
                    className="classroom-class-grid"
                    aria-label={t('Manage class', 'Quản lý lớp')}
                  >
                    {visibleClasses.map((entry) => {
                      const course = home.courses.find(
                        (candidate) => candidate.id === entry.schoolClass.courseRevisionId,
                      );
                      const isLive = entry.meetings.some(
                        (meeting) => meeting.status === ClassroomStatus.LIVE,
                      );
                      const artworkIndex = ownedClasses.indexOf(entry) % 3;
                      return (
                        <button
                          key={entry.schoolClass.id}
                          type="button"
                          className="classroom-class-card"
                          data-selected={entry.schoolClass.id === classId}
                          aria-pressed={entry.schoolClass.id === classId}
                          aria-label={t(
                            `Manage ${entry.schoolClass.name}`,
                            `Quản lý ${entry.schoolClass.name}`,
                          )}
                          onClick={() => {
                            selectClass(entry.schoolClass.id);
                          }}
                        >
                          <ClassSessionBadge live={isLive} t={t} />
                          <ClassArtwork
                            className="classroom-card-art"
                            kind={
                              artworkIndex === 0 ? 'lesson' : artworkIndex === 1 ? 'code' : 'design'
                            }
                          />
                          <span className="classroom-card-title">{entry.schoolClass.name}</span>
                          <span className="classroom-card-copy">
                            {course?.title ??
                              t(
                                'Prepare materials for this class.',
                                'Chuẩn bị tài liệu cho lớp này.',
                              )}
                          </span>
                          <span className="classroom-card-meta">
                            {course?.activities.length ?? 0} {t('sections', 'phần học')}
                            <span aria-hidden="true">↗</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {visibleClasses.length === 0 && (
                    <div className="classroom-empty">
                      <Text fw={600}>
                        {ownedClasses.length
                          ? t('No matching classes', 'Không có lớp phù hợp')
                          : t('Your first class starts here', 'Bắt đầu với lớp học đầu tiên')}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {ownedClasses.length
                          ? t('Try another class name.', 'Thử tìm tên lớp khác.')
                          : t(
                              'Create a class, then prepare its materials and invite students.',
                              'Tạo lớp, chuẩn bị tài liệu rồi mời học sinh.',
                            )}
                      </Text>
                    </div>
                  )}
                </>
              )}
              {showsLiveLesson && liveMeeting && (
                <TeacherLiveLesson
                  key={liveMeeting.id}
                  meeting={liveMeeting}
                  activities={activities}
                  busy={busy}
                  error={error}
                  t={t}
                  onUpdate={(change) =>
                    send({
                      kind: 'update-session',
                      classSessionId: liveMeeting.id,
                      contextVersion: liveMeeting.contextVersion,
                      ...change,
                    })
                  }
                  onEnd={() => {
                    void send({
                      kind: 'end-session',
                      classSessionId: liveMeeting.id,
                      contextVersion: liveMeeting.contextVersion,
                    });
                  }}
                />
              )}
              {isClassPage && selectedClass && !liveMeeting && (
                <section aria-label={t('Class sections', 'Các phần học')}>
                  <Group justify="space-between" mb="sm">
                    <Text component="h3">{t('Class sections', 'Các phần học')}</Text>
                    <Text size="sm" c="dimmed">
                      {selectedClass.schoolClass.name}
                    </Text>
                  </Group>
                  {activities.length ? (
                    <div className="classroom-section-list" aria-label={t('Section', 'Phần học')}>
                      {activities.map((activity, index) => (
                        <button
                          key={activity.id}
                          type="button"
                          className="classroom-section-row"
                          data-selected={activity.id === activityId}
                          aria-pressed={activity.id === activityId}
                          onClick={() => {
                            setActivityId(activity.id);
                          }}
                        >
                          <span className="classroom-section-number">{index + 1}</span>
                          <span>{activity.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t(
                        'Prepare and review materials to add class sections.',
                        'Chuẩn bị và duyệt tài liệu để thêm phần học.',
                      )}
                    </Text>
                  )}
                </section>
              )}
              {!showsLiveLesson && (
                <div className="classroom-note">
                  <Text fw={600}>
                    {t('Make room for a good lesson', 'Chuẩn bị cho một buổi học tốt')}
                  </Text>
                  <Text size="sm">
                    {t(
                      'Bring your materials, review the teaching notes, then choose a section to begin.',
                      'Thêm tài liệu, xem lại ghi chú giảng dạy rồi chọn phần học để bắt đầu.',
                    )}
                  </Text>
                </div>
              )}
              {isClassPage && selectedClass && liveMeeting && (
                <section aria-label={t('Student status', 'Tình trạng học sinh')}>
                  <PracticeTeacherResults key={liveMeeting.id} sessionId={liveMeeting.id} t={t} />
                  <Group justify="space-between" mb="sm">
                    <Text component="h3">{t('Student status', 'Tình trạng học sinh')}</Text>
                    <Button
                      variant="default"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        void send({ kind: 'session-roster', classSessionId: liveMeeting.id });
                      }}
                    >
                      {t('Student status', 'Tình trạng học sinh')}
                    </Button>
                  </Group>
                  {roster === null && (
                    <Text size="sm" c="dimmed">
                      {t(
                        'Load student status to see participation and submitted work.',
                        'Xem tình trạng học sinh để biết mức tham gia và bài đã nộp.',
                      )}
                    </Text>
                  )}
                  {roster?.length === 0 && (
                    <Text size="sm" c="dimmed">
                      {t('No enrolled students.', 'Chưa có học sinh ghi danh.')}
                    </Text>
                  )}
                  <div className="classroom-roster-list">
                    {roster?.map((student) => (
                      <Stack className="classroom-roster-row" key={student.studentId} gap={4}>
                        <Text fw={500}>{student.name}</Text>
                        <Text size="sm">
                          {student.participation && !student.participation.left
                            ? Date.parse(student.participation.leaseUntil) > Date.now()
                              ? t('Connected', 'Đang kết nối')
                              : t('Connection unknown', 'Chưa rõ kết nối')
                            : t('Not joined', 'Chưa tham gia')}
                        </Text>
                        {student.attempts.map((attempt) => (
                          <Text key={attempt.id} size="sm">
                            {
                              activities.find((activity) => activity.id === attempt.activityId)
                                ?.title
                            }
                            : {attempt.evidence.length}{' '}
                            {t('reported criteria', 'tiêu chí được báo cáo')} ·{' '}
                            {attempt.declaredComplete
                              ? t('Student says finished', 'Học sinh báo đã xong')
                              : t('In progress / unknown', 'Đang làm / chưa rõ')}{' '}
                            {attempt.helpSummary}
                          </Text>
                        ))}
                        {student.submissions.map((submission) => (
                          <Text key={submission.id} size="sm">
                            {t('Submitted link', 'Đường dẫn đã nộp')}: {submission.url}
                          </Text>
                        ))}
                      </Stack>
                    ))}
                  </div>
                </section>
              )}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="lessons">
            <Stack gap="md">
              {!isClassPage && (
                <Select
                  className="material-class-picker"
                  label={t('Class', 'Lớp')}
                  data={ownedClasses.map((entry) => ({
                    value: entry.schoolClass.id,
                    label: entry.schoolClass.name,
                  }))}
                  value={classId}
                  onChange={selectClass}
                />
              )}
              {classId && selectedClass ? (
                <MaterialEditor
                  key={classId}
                  classId={classId}
                  live={Boolean(liveMeeting)}
                  t={t}
                  onApproved={refresh}
                  preparationSidebar={preparationSidebar}
                  sessionControls={
                    <Stack gap="sm" className="material-session-controls">
                      <Text fw={600}>
                        {liveMeeting
                          ? t('Class is live', 'Lớp đang học')
                          : t('Ready for your class', 'Sẵn sàng cho lớp học')}
                      </Text>
                      {liveMeeting ? (
                        <Button
                          variant="default"
                          onClick={() => {
                            setTab('classes');
                          }}
                        >
                          {t('Manage session', 'Điều phối buổi học')}
                        </Button>
                      ) : (
                        <>
                          <Select
                            label={t('Start with', 'Bắt đầu với')}
                            data={activities.map((activity) => ({
                              value: activity.id,
                              label: activity.title,
                            }))}
                            value={activityId}
                            onChange={setActivityId}
                          />
                          <Button
                            disabled={busy || !activityId}
                            onClick={() => {
                              if (activityId) {
                                void send({
                                  kind: 'start-session',
                                  classId,
                                  activityId,
                                  pacing:
                                    pacing === ClassroomPacing.STUDENT
                                      ? ClassroomPacing.STUDENT
                                      : ClassroomPacing.TEACHER,
                                });
                              }
                            }}
                          >
                            {t('Start class', 'Bắt đầu lớp')}
                          </Button>
                          <Text size="xs" c="dimmed">
                            {t(
                              'Add students and manage invitations in Class settings.',
                              'Thêm học sinh và quản lý mã mời trong Cài đặt lớp.',
                            )}
                          </Text>
                        </>
                      )}
                    </Stack>
                  }
                />
              ) : (
                <Text>
                  {t(
                    'Create or choose a class to add materials.',
                    'Tạo hoặc chọn lớp để thêm tài liệu.',
                  )}
                </Text>
              )}
            </Stack>
          </Tabs.Panel>
          {isClassPage && selectedClass && (
            <Tabs.Panel value="settings">
              <ClassSettings
                key={selectedClass.schoolClass.id}
                classId={selectedClass.schoolClass.id}
                name={selectedClass.schoolClass.name}
                live={Boolean(liveMeeting)}
                busy={busy}
                invitation={invitation}
                roster={roster}
                sessionId={liveMeeting?.id ?? null}
                send={send}
                t={t}
              />
            </Tabs.Panel>
          )}
        </div>
        {showsLiveLesson ? null : selectedClass ? (
          <aside className="classroom-detail" aria-label={t('Class details', 'Chi tiết lớp')}>
            <div
              ref={setPreparationSidebar}
              className="material-preparation-sidebar"
              hidden={tab !== ClassView.MATERIALS}
            />
            <div className="classroom-detail-status">
              <ClassSessionBadge live={Boolean(liveMeeting)} t={t} />
            </div>
            <ClassArtwork kind="books" className="classroom-detail-art" />
            <div className="classroom-detail-heading">
              <Text className="classroom-eyebrow">
                {t('Your teaching space', 'Không gian giảng dạy')}
              </Text>
              <Text component="h2">{selectedClass.schoolClass.name}</Text>
              <Text size="sm" c="dimmed">
                {selectedCourse?.title ??
                  t(
                    'Materials and sessions for your class.',
                    'Tài liệu và buổi học cho lớp của bạn.',
                  )}
              </Text>
            </div>
            {!isClassPage ? (
              <Button
                variant="default"
                fullWidth
                onClick={() => {
                  selectClass(selectedClass.schoolClass.id);
                }}
              >
                {t('Open class', 'Mở lớp học')}
              </Button>
            ) : (
              tab === ClassView.OVERVIEW && (
                <Stack className="classroom-detail-content" gap="lg">
                  <section>
                    <Text component="h3" mb="xs">
                      {t('Class materials', 'Tài liệu lớp học')}
                    </Text>
                    <Text size="sm" c="dimmed" mb="sm">
                      {t(
                        'Add source files and review the notes your students will use.',
                        'Thêm tài liệu gốc và duyệt ghi chú học sinh sẽ sử dụng.',
                      )}
                    </Text>
                    <Button
                      variant="default"
                      fullWidth
                      onClick={() => {
                        setTab('lessons');
                      }}
                    >
                      {t('Prepare class materials', 'Chuẩn bị tài liệu lớp')}
                    </Button>
                  </section>
                  <TeacherSessionPanel
                    sectionTitle={
                      activities.find(
                        (activity) =>
                          activity.id === (liveMeeting?.currentActivityId ?? activityId),
                      )?.title ?? null
                    }
                    pacing={pacing}
                    busy={busy}
                    canStart={Boolean(activityId)}
                    onPacingChange={setPacing}
                    onStart={() => {
                      if (activityId) {
                        void send({
                          kind: 'start-session',
                          classId: selectedClass.schoolClass.id,
                          activityId,
                          pacing:
                            pacing === ClassroomPacing.STUDENT
                              ? ClassroomPacing.STUDENT
                              : ClassroomPacing.TEACHER,
                        });
                      }
                    }}
                    t={t}
                  />
                </Stack>
              )
            )}
          </aside>
        ) : (
          <aside
            className="classroom-detail classroom-empty"
            aria-label={t('Class details', 'Chi tiết lớp')}
          >
            <ClassArtwork kind="books" className="classroom-detail-art" />
            <Text component="h2">{t('A space for your class', 'Không gian cho lớp của bạn')}</Text>
            <Text size="sm" c="dimmed">
              {t(
                'Create a class to prepare materials, invite students and guide a session.',
                'Tạo lớp để chuẩn bị tài liệu, mời học sinh và điều phối buổi học.',
              )}
            </Text>
          </aside>
        )}
      </div>
    </Tabs>
  );
}
