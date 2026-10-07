import {
  Avatar,
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
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState, type ReactElement } from 'react';
import { AccountRole } from '#contracts/AccountRole.js';
import type { ComputerUseController } from '../UseComputerUse.js';
import { useLocale } from '../localization/UseLocale.js';

interface AccountMenuProps {
  controller: ComputerUseController;
  roleLabel: string;
  disabled: boolean;
}

/** Shows metadata only; session selection and browser authentication stay in main. */
export function AccountMenu({ controller, roleLabel, disabled }: AccountMenuProps): ReactElement {
  const { messages } = useLocale();
  const [opened, setOpened] = useState(false);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const { user, savedAccounts, isSigning, isSwitchingAccount } = controller;

  useEffect(() => {
    if (!isSigning && !starting) {
      setAdding(false);
    }
  }, [user?.id, isSigning, starting]);

  function openAddAccount(): void {
    setOpened(false);
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
                  <Text size="xs" c="dimmed" truncate title={user.email}>
                    {user.email}
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
                    <Text size="xs" c="dimmed" truncate title={account.user.email}>
                      {account.user.email}
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
            <UnstyledButton
              className="account-menu-action"
              disabled={disabled}
              onClick={openAddAccount}
            >
              <IconPlus size={17} />
              <span>{messages.addAccount}</span>
            </UnstyledButton>
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
                <span>{messages.signOutCurrentAccount}</span>
              </UnstyledButton>
            )}
          </div>
          <Text size="xs" c="dimmed" mt="sm">
            {messages.accountStorageHint}
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
      >
        <Stack>
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
