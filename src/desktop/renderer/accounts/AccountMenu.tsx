import {
  Avatar,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Popover,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArrowsExchange,
  IconArrowRight,
  IconBrandGoogle,
  IconCheck,
  IconLogout,
  IconPlus,
  IconQrcode,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState, type ReactElement } from 'react';
import { AccountRole } from '#contracts/AccountRole.js';
import type { ComputerUseController } from '../UseComputerUse.js';
import { useLocale } from '../localization/UseLocale.js';
import { StudentAccessForm } from './StudentAccessForm.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';

interface AccountMenuProps {
  controller: ComputerUseController;
  roleLabel: string;
  disabled: boolean;
}

/** Shows metadata only; session selection and browser authentication stay in main. */
export function AccountMenu({ controller, roleLabel, disabled }: AccountMenuProps): ReactElement {
  const { messages, locale } = useLocale();
  const [opened, setOpened] = useState(false);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [expiredStudent, setExpiredStudent] = useState(false);
  const [studentSignIn, setStudentSignIn] = useState(false);
  const { user, savedAccounts, isSigning, isSwitchingAccount } = controller;
  const shared =
    user?.learner?.mode === StudentDeviceMode.SHARED ||
    savedAccounts?.deviceMode === StudentDeviceMode.SHARED;
  const identityLabel = (identity: NonNullable<typeof user>): string =>
    identity.learner
      ? `${locale === 'vi' ? 'Mã QR' : 'QR ID'} · ${identity.learner.externalId}`
      : (identity.email ?? '');

  useEffect(() => {
    if (!isSigning && !starting) {
      setAdding(false);
    }
  }, [user?.id, isSigning, starting]);

  function openAddAccount(): void {
    setOpened(false);
    setStudentSignIn(false);
    setAdding(true);
  }

  async function startGoogleSignIn(): Promise<void> {
    setStarting(true);
    try {
      await controller.addGoogleAccount();
    } finally {
      setStarting(false);
    }
  }

  async function closeAddAccount(): Promise<void> {
    if (starting || isSwitchingAccount) {
      return;
    }
    if (isSigning) {
      await controller.cancelAccountSignIn();
    }
    setAdding(false);
  }

  return (
    <>
      <Popover
        opened={opened}
        onChange={setOpened}
        position="right-end"
        width={344}
        shadow="md"
        withinPortal
        trapFocus
        returnFocus
      >
        <Popover.Target>
          <UnstyledButton
            className="sidebar-account-trigger"
            aria-label={messages.switchAccount}
            aria-haspopup="dialog"
            aria-expanded={opened}
            disabled={disabled}
            onClick={() => {
              setOpened(!opened);
              if (!opened) {
                void controller.refreshAccounts();
              }
            }}
          >
            <Group gap={10} wrap="nowrap">
              <span className="account-avatar">
                <Avatar size={34} radius="xl" color="charcoal" variant="light">
                  {user?.name.trim().slice(0, 1).toUpperCase() ?? <IconArrowsExchange size={18} />}
                </Avatar>
                {user && <IconArrowsExchange size={12} className="account-avatar-switch" />}
              </span>
              <Stack gap={3} className="account-details">
                <Text size="sm" fw={500} truncate title={user?.name}>
                  {user?.name ?? messages.accountChoose}
                </Text>
                {user && (
                  <Text size="xs" c="dimmed" truncate title={identityLabel(user)}>
                    {identityLabel(user)}
                  </Text>
                )}
              </Stack>
            </Group>
            {user && (
              <Text size="xs" className="sidebar-role">
                {roleLabel}
              </Text>
            )}
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown
          className="account-menu"
          role="dialog"
          aria-label={messages.switchAccount}
        >
          <Group justify="space-between" mb="xs">
            <Text fw={650} size="sm">
              {messages.switchAccount}
            </Text>
            <UnstyledButton
              className="account-menu-close"
              aria-label={messages.accountCloseMenu}
              onClick={() => {
                setOpened(false);
              }}
            >
              <IconX size={16} />
            </UnstyledButton>
          </Group>
          <Text size="xs" c="dimmed" mb="sm">
            {messages.savedAccounts}
          </Text>
          <Stack gap={4}>
            {(savedAccounts?.accounts ?? []).map((account) => {
              const current = account.id === savedAccounts?.activeAccountId && Boolean(user);
              const accountRole = current
                ? roleLabel
                : account.role === AccountRole.TEACHER
                  ? messages.accountTeacher
                  : account.role === AccountRole.STUDENT
                    ? messages.accountStudent
                    : messages.accountRoleUnknown;
              return (
                <UnstyledButton
                  key={account.id}
                  className="account-menu-row"
                  data-current={current || undefined}
                  disabled={disabled || current}
                  aria-label={`${account.user.name}, ${accountRole}${current ? `, ${messages.currentAccount}` : ''}`}
                  onClick={() => {
                    setOpened(false);
                    if (account.requiresSignIn) {
                      setExpiredStudent(Boolean(account.user.learner));
                      openAddAccount();
                    } else {
                      void controller.switchAccount(account.id);
                    }
                  }}
                >
                  <Avatar size={38} radius="xl" color="charcoal" variant="light">
                    {account.user.name.trim().slice(0, 1).toUpperCase()}
                  </Avatar>
                  <div className="account-menu-identity">
                    <Group gap={6} wrap="nowrap">
                      <Text fw={550} size="sm" truncate>
                        {account.user.name}
                      </Text>
                      <Badge size="xs" variant="light">
                        {accountRole}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" truncate title={identityLabel(account.user)}>
                      {identityLabel(account.user)}
                    </Text>
                    {account.requiresSignIn && (
                      <Text size="xs" c="dimmed">
                        {messages.accountExpired}
                      </Text>
                    )}
                  </div>
                  {current ? (
                    <IconCheck size={17} aria-label={messages.currentAccount} />
                  ) : (
                    <IconArrowRight size={16} />
                  )}
                </UnstyledButton>
              );
            })}
          </Stack>
          <div className="account-menu-actions">
            {!shared && (
              <UnstyledButton
                className="account-menu-action"
                disabled={disabled}
                onClick={() => {
                  setExpiredStudent(false);
                  openAddAccount();
                }}
              >
                <IconPlus size={17} />
                <span>{messages.addAccount}</span>
              </UnstyledButton>
            )}
            {user && (
              <UnstyledButton
                className="account-menu-action"
                disabled={disabled}
                onClick={() => {
                  setOpened(false);
                  void controller.signOut();
                }}
              >
                <IconLogout size={17} />
                <span>
                  {shared
                    ? locale === 'vi'
                      ? 'Đổi học sinh'
                      : 'Change student'
                    : messages.signOutCurrentAccount}
                </span>
              </UnstyledButton>
            )}
          </div>
          <Text size="xs" c="dimmed" mt="sm">
            {shared
              ? locale === 'vi'
                ? 'Phiên học tạm thời trên máy dùng chung.'
                : 'Temporary lesson on a shared device.'
              : messages.accountStorageHint}
          </Text>
        </Popover.Dropdown>
      </Popover>
      <Modal
        opened={adding}
        onClose={() => void closeAddAccount()}
        title={messages.accountSignInHeading}
        centered
        size="sm"
        closeButtonProps={{ 'aria-label': messages.accountCancel }}
        closeOnClickOutside={!isSwitchingAccount}
        closeOnEscape={!isSwitchingAccount}
      >
        <Stack>
          {expiredStudent && (
            <Alert role="alert">
              {locale === 'vi'
                ? 'Đăng nhập đã hết hạn. Quét lại thẻ QR để vào tài khoản và bài làm đã lưu.'
                : 'This saved login expired. Scan your QR card again to reopen your account and saved work.'}
            </Alert>
          )}
          {studentSignIn || expiredStudent ? (
            <>
              <StudentAccessForm
                mode={StudentDeviceMode.PERSONAL}
                controller={controller}
                onSuccess={() => {
                  setAdding(false);
                }}
              />
              {!expiredStudent && (
                <Button
                  variant="subtle"
                  disabled={isSwitchingAccount}
                  onClick={() => {
                    setStudentSignIn(false);
                  }}
                >
                  {messages.accountSignInOptions}
                </Button>
              )}
            </>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                {messages.accountSignInDescription}
              </Text>
              {isSigning ? (
                <Group gap="sm" role="status">
                  <Loader size="sm" />
                  <Text size="sm">{messages.accountWaitingGoogle}</Text>
                </Group>
              ) : (
                <Button
                  leftSection={<IconBrandGoogle size={18} />}
                  variant="default"
                  loading={starting}
                  onClick={() => void startGoogleSignIn()}
                >
                  {messages.accountContinueGoogle}
                </Button>
              )}
              {window.tro.controlStudentAccess && (
                <Button
                  leftSection={<IconQrcode size={18} />}
                  variant="default"
                  disabled={starting || isSigning || isSwitchingAccount}
                  onClick={() => {
                    setStudentSignIn(true);
                  }}
                >
                  {messages.accountContinueQr}
                </Button>
              )}
            </>
          )}
          <Button
            variant="subtle"
            disabled={starting || isSwitchingAccount}
            onClick={() => void closeAddAccount()}
          >
            {isSigning ? messages.accountCancelSignIn : messages.accountCancel}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
