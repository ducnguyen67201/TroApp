import { DesktopPage } from '../navigation/DesktopRoute.js';
import { ClassroomInsightsPage } from './ClassroomInsightsPage.js';
import { usePracticeShortcut } from './UsePracticeShortcut.js';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  ClassroomCommandSchema,
  ClassroomFailure,
  type ClassroomCommand,
  type ClassroomHome,
  type ClassroomReply,
  type TeachingContext,
  type ClassroomRosterSchema,
} from '#contracts/Classroom.js';
import { TeacherClassroomPanel } from './TeacherClassroomPanel.js';
import { StudentClassroomPanel } from './StudentClassroomPanel.js';
import { IconArrowLeft, IconRefresh, IconSearch } from '@tabler/icons-react';
import type { z } from 'zod';
import { AccountRole } from '#contracts/AccountRole.js';
import type { DesktopNavigation } from '../navigation/UseDesktopNavigation.js';
import { useLocale } from '../localization/UseLocale.js';

/** Owns existing classroom commands and polling; presentation selects no authority. */
interface ClassroomPageProps {
  userId: string;
  active: boolean;
  userName?: string;
  navigation: DesktopNavigation;
  onOpenWorkspace?: (message?: string) => void;
  onRoleChange: (role: AccountRole) => void;
}
export function ClassroomPage({
  userId,
  active,
  userName,
  navigation,
  onRoleChange,
  onOpenWorkspace,
}: ClassroomPageProps): ReactElement {
  const { locale } = useLocale();
  const t = useCallback(
    (english: string, vietnamese: string): string => (locale === 'vi' ? vietnamese : english),
    [locale],
  );
  const [joinCode, setJoinCode] = useState('');
  const [search, setSearch] = useState('');
  const [invitation, setInvitation] = useState<Extract<
    ClassroomReply,
    { kind: 'invitation' }
  > | null>(null);
  const [home, setHome] = useState<ClassroomHome | null>(null);
  const [context, setContext] = useState<TeachingContext | null>(null);
  const contextRef = useRef<TeachingContext | null>(null);
  const [preparation, setPreparation] = useState<Extract<
    ClassroomReply,
    { kind: 'prepared' }
  > | null>(null);
  const [receipt, setReceipt] = useState<Extract<ClassroomReply, { kind: 'submitted' }> | null>(
    null,
  );
  const [roster, setRoster] = useState<{
    sessionId: string;
    students: z.infer<typeof ClassroomRosterSchema>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ classId: string; text: string } | null>(null);
  const generation = useRef(0);
  const practiceReview = usePracticeShortcut(context, navigation.openClass);

  const accept = useCallback(
    (reply: ClassroomReply, rosterSessionId?: string): void => {
      if (reply.kind === 'home') {
        setHome(reply.home);
        onRoleChange(reply.home.role);
      }
      if (reply.kind === 'context') {
        const previous = contextRef.current;
        if (
          previous?.attempt.id !== reply.context.attempt.id ||
          previous.meeting.contextVersion !== reply.context.meeting.contextVersion
        ) {
          setPreparation(null);
          setReceipt(null);
        }
        contextRef.current = reply.context;
        setContext(reply.context);
        setReceipt(
          reply.context.latestSubmission
            ? { kind: 'submitted', receipt: reply.context.latestSubmission }
            : null,
        );
      }
      if (reply.kind === 'prepared') {
        setPreparation(reply);
      }
      if (reply.kind === 'submitted') {
        setReceipt(reply);
        setPreparation(null);
      }
      if (reply.kind === 'invitation') {
        setInvitation(reply);
      }
      if (reply.kind === 'roster' && rosterSessionId) {
        setRoster({ sessionId: rosterSessionId, students: reply.roster });
      }
    },
    [onRoleChange],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const currentGeneration = generation.current;
    const bridge = window.tro.controlClassroom;
    if (!bridge) {
      return;
    }
    const reply = await bridge({ kind: 'home' });
    if (currentGeneration !== generation.current) {
      return;
    }
    if (reply.kind === 'failed') {
      setError(
        t(
          'Could not load your classes. Check your connection and sign-in, then refresh.',
          'Chưa tải được lớp học. Kiểm tra kết nối và đăng nhập rồi cập nhật.',
        ),
      );
      return;
    }
    setError(null);
    accept(reply);
    const current = contextRef.current;
    const updated = await bridge(
      current
        ? {
            kind: 'context',
            participationId: current.participation.id,
            deviceId: current.participation.deviceId,
            activityId: current.activity.id,
          }
        : { kind: 'resume', deviceId: crypto.randomUUID() },
    );
    if (currentGeneration !== generation.current) {
      return;
    }
    if (updated.kind === 'context') {
      accept(updated);
    } else if (updated.kind !== 'ok') {
      if (
        updated.kind === 'failed' &&
        (updated.code === ClassroomFailure.FORBIDDEN ||
          updated.code === ClassroomFailure.STALE ||
          updated.code === ClassroomFailure.NOT_FOUND)
      ) {
        contextRef.current = null;
        setContext(null);
        setPreparation(null);
      }
      setError(
        t(
          'Class connection needs attention. Rejoin to continue.',
          'Kết nối lớp học cần kiểm tra. Hãy vào lại để tiếp tục.',
        ),
      );
    }
    const prepared = await window.tro.readPreparedClassroomSubmission?.();
    if (currentGeneration === generation.current) {
      setPreparation(prepared?.kind === 'prepared' ? prepared : null);
    }
  }, [accept, t]);

  useEffect(() => {
    generation.current += 1;
    contextRef.current = null;
    setContext(null);
    setHome(null);
    setPreparation(null);
    setReceipt(null);
    return () => {
      generation.current += 1;
    };
  }, [userId]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, [active, refresh]);

  useEffect(() => {
    void refresh();
  }, [userId, refresh]);

  async function send(command: ClassroomCommand): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const currentGeneration = generation.current;
    try {
      const parsed = ClassroomCommandSchema.safeParse(command);
      const reply: ClassroomReply | undefined = parsed.success
        ? await window.tro.controlClassroom?.(parsed.data)
        : { kind: 'failed', code: ClassroomFailure.INVALID };
      if (currentGeneration !== generation.current) {
        return;
      }
      if (!reply || reply.kind === 'failed') {
        setError(
          command.kind === 'enroll' &&
            reply?.kind === 'failed' &&
            reply.code === ClassroomFailure.NOT_FOUND
            ? t(
                'No signed-in student was found for this email. Ask them to sign in first, or share an invitation code.',
                'Chưa tìm thấy học sinh với email này. Hãy nhờ họ đăng nhập trước hoặc chia sẻ mã mời.',
              )
            : t(
                'Could not complete this classroom action. Check the details, connection and current session.',
                'Chưa thực hiện được thao tác. Hãy kiểm tra thông tin, kết nối và buổi học hiện tại.',
              ),
        );
        return;
      }
      accept(reply, command.kind === 'session-roster' ? command.classSessionId : undefined);
      if (command.kind === 'enroll') {
        setNotice({
          classId: command.classId,
          text: t(
            'Student added. This class will appear in their classroom.',
            'Đã thêm học sinh. Lớp sẽ xuất hiện trong tài khoản của họ.',
          ),
        });
      }
      if (command.kind === 'revoke-invitations') {
        setInvitation(null);
      }
      if (command.kind === 'accept-invitation') {
        setJoinCode('');
      }
      if (command.kind === 'leave') {
        contextRef.current = null;
        setContext(null);
        setPreparation(null);
        setReceipt(null);
      }
      await refresh();
    } catch {
      setError(t('Classroom service is unavailable.', 'Dịch vụ lớp học chưa sẵn sàng.'));
    } finally {
      setBusy(false);
    }
  }

  const showsInsights = navigation.route.page === DesktopPage.INSIGHTS;
  const participantClasses =
    home?.classes.filter((entry) => entry.schoolClass.teacherId !== userId) ?? [];
  const enrollment = (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t(
            'Enter the code your teacher shared. You can enroll before a session starts.',
            'Nhập mã giáo viên chia sẻ. Bạn có thể vào lớp trước khi buổi học bắt đầu.',
          )}
        </Text>
        <Group align="end">
          <TextInput
            label={t('Class code', 'Mã lớp')}
            value={joinCode}
            maxLength={32}
            onChange={(event) => {
              setJoinCode(event.currentTarget.value);
            }}
          />
          <Button
            disabled={busy || !joinCode.trim()}
            onClick={() => {
              void send({ kind: 'accept-invitation', code: joinCode });
            }}
          >
            {t('Join class', 'Vào lớp')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
  return (
    <section
      hidden={!active}
      aria-label={t('Classroom', 'Lớp học')}
      className="classroom-page"
      data-class-page={navigation.route.classId !== null}
    >
      <div className="classroom-toolbar">
        {navigation.route.classId !== null && (
          <Tooltip label={t('All classes', 'Tất cả lớp học')}>
            <ActionIcon
              variant="subtle"
              size="lg"
              aria-label={t('All classes', 'Tất cả lớp học')}
              onClick={() => {
                navigation.openClassroom(showsInsights);
              }}
            >
              <IconArrowLeft size={20} />
            </ActionIcon>
          </Tooltip>
        )}
        <header className="classroom-page-heading">
          <h1>
            {showsInsights
              ? t('Learning insights', 'Tiến độ học tập')
              : home?.role === AccountRole.TEACHER
                ? (home.classes.find((entry) => entry.schoolClass.id === navigation.route.classId)
                    ?.schoolClass.name ?? t('Your classroom', 'Lớp học của bạn'))
                : `${t('Welcome', 'Chào bạn')}${userName ? `, ${userName.trim().split(' ')[0] ?? ''}` : ''}`}
          </h1>
        </header>
        {!showsInsights && navigation.route.classId === null && (
          <TextInput
            className="classroom-search"
            aria-label={t('Find a class', 'Tìm lớp học')}
            placeholder={t('Find a class…', 'Tìm lớp học…')}
            leftSection={<IconSearch size={17} stroke={1.5} />}
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
          />
        )}
        <Button
          variant="subtle"
          leftSection={<IconRefresh size={16} />}
          loading={busy}
          onClick={() => {
            void refresh();
          }}
        >
          {t('Refresh', 'Cập nhật')}
        </Button>
      </div>
      {notice?.classId === navigation.route.classId && (
        <Text role="status" size="sm" mb="md">
          {notice.text}
        </Text>
      )}
      {error && (
        <Alert role="alert" mb="lg">
          {error}
        </Alert>
      )}
      {!home && <Text c="dimmed">{t('Loading your classroom…', 'Đang tải lớp học…')}</Text>}
      {!showsInsights && home?.role === AccountRole.TEACHER && (
        <TeacherClassroomPanel
          refresh={refresh}
          error={error}
          navigation={navigation}
          home={home}
          userId={userId}
          busy={busy}
          send={send}
          roster={
            home.classes.some(
              (entry) =>
                entry.schoolClass.id === navigation.route.classId &&
                entry.meetings.some((meeting) => meeting.id === roster?.sessionId),
            )
              ? (roster?.students ?? null)
              : null
          }
          invitation={invitation?.invitation ?? null}
          onClassChange={() => {
            setRoster(null);
            setInvitation(null);
            setNotice(null);
          }}
          search={search}
          t={t}
        />
      )}
      {!showsInsights && home && home.role !== AccountRole.TEACHER && (
        <StudentClassroomPanel
          home={home}
          navigation={navigation}
          userId={userId}
          context={context}
          practiceReview={practiceReview}
          search={search}
          busy={busy}
          send={send}
          preparation={preparation}
          receipt={receipt}
          t={t}
          {...(onOpenWorkspace ? { onAskForHelp: onOpenWorkspace } : {})}
        />
      )}
      {showsInsights && home && (
        <ClassroomInsightsPage
          home={home}
          userId={userId}
          classId={navigation.route.classId}
          context={context}
          t={t}
        />
      )}
      <details
        hidden={
          showsInsights || (home?.role === AccountRole.TEACHER && navigation.route.classId !== null)
        }
        className="classroom-disclosure classroom-enrollment"
        open={(home?.role === AccountRole.STUDENT && participantClasses.length === 0) || undefined}
      >
        <summary>
          {home?.role === AccountRole.TEACHER
            ? t('Join another class', 'Tham gia lớp khác')
            : t('Join with a class code', 'Tham gia bằng mã lớp')}
        </summary>
        {enrollment}
      </details>
      {!showsInsights && home?.role === AccountRole.TEACHER && participantClasses.length > 0 && (
        <div className="classroom-enrolled-activity">
          <StudentClassroomPanel
            home={home}
            userId={userId}
            context={context}
            practiceReview={practiceReview}
            search=""
            busy={busy}
            send={send}
            preparation={preparation}
            receipt={receipt}
            t={t}
            {...(onOpenWorkspace ? { onAskForHelp: onOpenWorkspace } : {})}
          />
        </div>
      )}
    </section>
  );
}
