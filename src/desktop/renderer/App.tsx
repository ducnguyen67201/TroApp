import {
  Alert,
  AppShell,
  Avatar,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArrowRight,
  IconLayoutSidebar,
  IconLogout,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ComputerUsePage } from './ComputerUsePage.js';
import { PermissionsOnboardingPage } from './PermissionsOnboardingPage.js';
import { SettingsPage } from './SettingsPage.js';
import { useComputerUse } from './UseComputerUse.js';
import { useLocale } from './localization/UseLocale.js';
import { useDesktopPermissions } from './UseDesktopPermissions.js';

const DesktopPage = { WORKSPACE: 'workspace', SETTINGS: 'settings' } as const;

type DesktopPage = (typeof DesktopPage)[keyof typeof DesktopPage];

export function App(): ReactElement {
  const { messages } = useLocale();
  const [page, setPage] = useState<DesktopPage>(DesktopPage.WORKSPACE);
  const controller = useComputerUse();
  const { user } = controller;
  const permissions = useDesktopPermissions(user?.id ?? null);
  const previousPermissionKind = useRef(permissions.status?.kind);

  useEffect(() => {
    if (permissions.status?.kind === 'ready' && previousPermissionKind.current !== 'ready') {
      setPage(DesktopPage.WORKSPACE);
    }
    previousPermissionKind.current = permissions.status?.kind;
  }, [permissions.status?.kind]);

  return (
    <AppShell navbar={{ width: 232, breakpoint: 0 }} padding={0} className="desktop-shell">
      <AppShell.Navbar className="desktop-sidebar" withBorder={false}>
        <Group gap={10} className="brand">
          <span className="brand-mark">
            <IconSparkles size={22} stroke={1.5} />
          </span>
          <Text fw={650} size="xl">
            Tro
          </Text>
        </Group>
        <nav aria-label={messages.navigation} className="sidebar-navigation">
          <UnstyledButton
            className="sidebar-link"
            data-active={page === DesktopPage.WORKSPACE || undefined}
            aria-current={page === DesktopPage.WORKSPACE ? 'page' : undefined}
            onClick={() => {
              setPage(DesktopPage.WORKSPACE);
            }}
          >
            <IconLayoutSidebar size={19} stroke={1.6} />
            <span>{messages.workspace}</span>
          </UnstyledButton>
        </nav>
        <div className="sidebar-bottom">
          <UnstyledButton
            className="sidebar-link"
            data-active={page === DesktopPage.SETTINGS || undefined}
            aria-current={page === DesktopPage.SETTINGS ? 'page' : undefined}
            onClick={() => {
              setPage(DesktopPage.SETTINGS);
            }}
          >
            <IconSettings size={19} stroke={1.6} />
            <span>{messages.settings}</span>
          </UnstyledButton>
          <section className="sidebar-account" aria-label={messages.yourAccount}>
            {controller.isLoading ? (
              <Group gap="sm">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  {messages.checkingSignIn}
                </Text>
              </Group>
            ) : user ? (
              <>
                <Group gap={10} wrap="nowrap">
                  <Avatar size={34} radius="xl" color="charcoal" variant="light">
                    {user.name.trim().slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Stack gap={3} className="account-details">
                    <Text size="sm" fw={500} truncate title={user.name}>
                      {user.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate title={user.email}>
                      {user.email}
                    </Text>
                  </Stack>
                </Group>
                <Button
                  variant="subtle"
                  fullWidth
                  justify="flex-start"
                  leftSection={<IconLogout size={16} />}
                  loading={controller.isSigningOut}
                  disabled={controller.isSending || controller.isResetting}
                  onClick={() => void controller.signOut()}
                  className="logout-button"
                >
                  {messages.signOut}
                </Button>
              </>
            ) : (
              <>
                <Text size="sm" fw={500}>
                  {messages.ownWorkspace}
                </Text>
                <Text size="xs" c="dimmed" mt={5} mb="sm">
                  {messages.signInInvitation}
                </Text>
                <Button
                  fullWidth
                  variant="default"
                  rightSection={<IconArrowRight size={15} />}
                  loading={controller.isSigning}
                  onClick={() => void controller.signInWithGoogle()}
                >
                  {messages.signIn}
                </Button>
              </>
            )}
          </section>
        </div>
      </AppShell.Navbar>
      <AppShell.Main className="desktop-main">
        <div className="main-panel">
          <header className="panel-header">
            <Text size="sm" c="dimmed">
              {page === DesktopPage.WORKSPACE ? messages.workspace : messages.settings}
            </Text>
            <span className="desktop-label">
              <span className="accent-dot" />
              {messages.yourDesktop}
            </span>
          </header>
          <div className="panel-content">
            {controller.message && (
              <Alert
                role="alert"
                title={messages.attention}
                color="charcoal"
                variant="light"
                mb="lg"
              >
                {controller.message}
              </Alert>
            )}
            {page === DesktopPage.SETTINGS ? (
              <SettingsPage user={user} />
            ) : user && permissions.status?.kind !== 'ready' ? (
              <PermissionsOnboardingPage controller={permissions} />
            ) : (
              <ComputerUsePage controller={controller} />
            )}
          </div>
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
