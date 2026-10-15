import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import {
  StudentAccessKind,
  StudentAccessReplySchema,
  type StudentAccessCommand,
  type StudentAccessReply,
} from '#contracts/StudentAccess.js';
import { useLocale } from '../localization/UseLocale.js';

type ComputerUsage = Extract<StudentAccessReply, { kind: 'organization-access' }>;

/** Owner controls act on the selected organization; installation credentials never enter this view. */
export function OrganizationComputerPanel({
  organizationId,
}: {
  organizationId: string;
}): ReactElement {
  const { locale } = useLocale();
  const t = (english: string, vietnamese: string): string =>
    locale === 'vi' ? vietnamese : english;
  const [usage, setUsage] = useState<ComputerUsage | null>(null);
  const [code, setCode] = useState<Extract<StudentAccessReply, { kind: 'admission' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);

  async function readUsage(): Promise<void> {
    const raw = await window.tro.controlStudentAccess?.({
      kind: StudentAccessKind.ORGANIZATION_ACCESS,
      organizationId,
    });
    if (!alive.current) {
      return;
    }
    const reply = StudentAccessReplySchema.parse(raw);
    if (
      reply.kind === StudentAccessKind.ORGANIZATION_ACCESS &&
      reply.organizationId === organizationId
    ) {
      setUsage(reply);
    } else if (reply.kind === 'failed') {
      setError(reply.message);
    }
  }

  async function send(command: StudentAccessCommand): Promise<void> {
    if (pending.current || !window.tro.controlStudentAccess) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const reply = StudentAccessReplySchema.parse(await window.tro.controlStudentAccess(command));
      if (!alive.current) {
        return;
      }
      if (reply.kind === 'failed') {
        setError(reply.message);
        return;
      }
      if (reply.kind === 'admission') {
        setCode(reply);
      }
      await readUsage();
    } catch {
      if (alive.current) {
        setError(
          t(
            'Computer access is unavailable. Please retry.',
            'Chưa quản lý được máy tính. Vui lòng thử lại.',
          ),
        );
      }
    } finally {
      if (alive.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    alive.current = true;
    void readUsage().catch(() => {
      if (alive.current) {
        setError(t('Could not load computer usage.', 'Chưa tải được số liệu sử dụng máy tính.'));
      }
    });
    return () => {
      alive.current = false;
    };
  }, []);

  return (
    <Paper
      withBorder
      p="md"
      component="section"
      aria-label={t('Company computers', 'Máy tính của tổ chức')}
    >
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{t('Company computers', 'Máy tính của tổ chức')}</Title>
          <Button
            variant="subtle"
            disabled={busy}
            onClick={() => {
              void send({ kind: StudentAccessKind.ORGANIZATION_ACCESS, organizationId });
            }}
          >
            {t('Refresh usage', 'Cập nhật số liệu')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t(
            'Use the same organization code to authorize multiple company computers. Each computer gets a name automatically. Students then sign in with their school QR.',
            'Dùng cùng một mã tổ chức để kích hoạt nhiều máy tính. Mỗi máy được đặt tên tự động. Sau đó học sinh đăng nhập bằng QR của trường.',
          )}
        </Text>
        {error && <Alert role="alert">{error}</Alert>}
        {usage && (
          <Stack gap={3} role="status">
            <Text>
              {t('Authorized computers', 'Máy đã được cấp quyền')}: {usage.authorizedComputers}
            </Text>
            <Text>
              {t('Unique student accounts', 'Tài khoản học sinh riêng biệt')}:{' '}
              {usage.registeredStudents}
            </Text>
            <Text>
              {t('Students signed in today (UTC)', 'Học sinh đăng nhập hôm nay (UTC)')}:{' '}
              {usage.studentsToday}
            </Text>
            <Text>
              {t('Sign-ins today / all time', 'Lượt đăng nhập hôm nay / tổng cộng')}:{' '}
              {usage.signInsToday} / {usage.totalSignIns}
            </Text>
            <Text size="xs" c="dimmed">
              {t(
                'Repeated sign-ins count as one student. These counts cover QR accounts on organization-authorized computers.',
                'Đăng nhập nhiều lần vẫn tính là một học sinh. Số liệu dành cho tài khoản QR trên các máy được tổ chức cấp quyền.',
              )}
            </Text>
          </Stack>
        )}
        <Button
          loading={busy}
          onClick={() => {
            void send({ kind: StudentAccessKind.CREATE_COMPUTER_CODE, organizationId });
          }}
        >
          {t('Create organization activation code', 'Tạo mã kích hoạt tổ chức')}
        </Button>
        {code && (
          <Stack gap={3}>
            <TextInput
              readOnly
              label={t('Organization activation code', 'Mã kích hoạt tổ chức')}
              value={code.code}
            />
            <Text size="xs">
              {t(
                'Reusable across this organization’s computers. Expires',
                'Dùng chung cho các máy của tổ chức. Hết hạn',
              )}
              : {new Date(code.expiresAt).toLocaleString()}
            </Text>
            <Text size="sm">
              {t(
                'On each computer, sign out saved personal accounts, choose Company computer on the welcome screen, then enter this code. Names such as Computer 1 are generated automatically.',
                'Trên mỗi máy, đăng xuất các tài khoản cá nhân đã lưu, chọn Máy tính của tổ chức ở màn hình chào, rồi nhập mã này. Tên như Computer 1 được tạo tự động.',
              )}
            </Text>
          </Stack>
        )}
        {usage && usage.activationCodes.length > 0 && (
          <Text size="xs" c="dimmed">
            {t(
              'Stopping a code blocks new activations. Computers already authorized stay active until you revoke them individually.',
              'Dừng mã sẽ chặn kích hoạt mới. Các máy đã được cấp quyền vẫn hoạt động cho đến khi bạn thu hồi từng máy.',
            )}
          </Text>
        )}
        {usage?.activationCodes.map((activationCode) => (
          <Group key={activationCode.id} justify="space-between">
            <Stack gap={2}>
              <Text size="sm">
                {t('Active organization code', 'Mã tổ chức đang hoạt động')} ·{' '}
                {t('Computers activated', 'Số máy đã kích hoạt')}: {activationCode.activations}
              </Text>
              <Text size="xs" c="dimmed">
                {t('Expires', 'Hết hạn')}: {new Date(activationCode.expiresAt).toLocaleString()}
              </Text>
            </Stack>
            <Button
              variant="subtle"
              color="red"
              disabled={busy}
              onClick={() => {
                setCode(null);
                void send({
                  kind: StudentAccessKind.REVOKE_COMPUTER_CODE,
                  organizationId,
                  admissionId: activationCode.id,
                });
              }}
            >
              {t('Stop new activations', 'Dừng kích hoạt máy mới')}
            </Button>
          </Group>
        ))}
        {usage?.computers.map((computer) => (
          <Group key={computer.id} justify="space-between">
            <Stack gap={2}>
              <Text size="sm">{computer.name}</Text>
              <Text size="xs" c="dimmed">
                {computer.revoked
                  ? t('Revoked', 'Đã thu hồi')
                  : new Date(computer.expiresAt) <= new Date()
                    ? t('Expired', 'Hết hạn')
                    : t('Authorized', 'Đã cấp quyền')}
                {computer.lastSignInAt
                  ? ` · ${t('Last student sign-in', 'Học sinh đăng nhập gần nhất')}: ${new Date(computer.lastSignInAt).toLocaleString()}`
                  : ''}
              </Text>
            </Stack>
            <Button
              variant="subtle"
              color="red"
              disabled={busy || computer.revoked}
              onClick={() => {
                void send({
                  kind: StudentAccessKind.REVOKE_COMPUTER,
                  organizationId,
                  deviceId: computer.id,
                });
              }}
            >
              {t('Revoke computer', 'Thu hồi quyền máy tính')}
            </Button>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
