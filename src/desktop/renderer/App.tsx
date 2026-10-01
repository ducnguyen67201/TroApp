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
import { useState, type ReactElement } from 'react';
import { ComputerUsePage } from './ComputerUsePage.js';
import { SettingsPage } from './SettingsPage.js';
import { useComputerUse } from './UseComputerUse.js';

const DesktopPage = { WORKSPACE: 'workspace', SETTINGS: 'settings' } as const;

type DesktopPage = (typeof DesktopPage)[keyof typeof DesktopPage];

export function App(): ReactElement {
  const [page, setPage] = useState<DesktopPage>(DesktopPage.WORKSPACE);
  const controller = useComputerUse();
  const { user } = controller;

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
        <nav aria-label="Main navigation" className="sidebar-navigation">
          <UnstyledButton
            className="sidebar-link"
            data-active={page === DesktopPage.WORKSPACE || undefined}
            aria-current={page === DesktopPage.WORKSPACE ? 'page' : undefined}
            onClick={() => {
              setPage(DesktopPage.WORKSPACE);
            }}
          >
            <IconLayoutSidebar size={19} stroke={1.6} />
            <span>Workspace</span>
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
            <span>Settings</span>
          </UnstyledButton>
          <section className="sidebar-account" aria-label="Your account">
            {controller.isLoading ? (
              <Group gap="sm">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Checking sign-in…
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
                  Sign out
                </Button>
              </>
            ) : (
              <>
                <Text size="sm" fw={500}>
                  Your own little workspace
                </Text>
                <Text size="xs" c="dimmed" mt={5} mb="sm">
                  Sign in to make it yours.
                </Text>
                <Button
                  fullWidth
                  variant="default"
                  rightSection={<IconArrowRight size={15} />}
                  loading={controller.isSigning}
                  onClick={() => void controller.signInWithGoogle()}
                >
                  Sign in
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
              {page === DesktopPage.WORKSPACE ? 'Workspace' : 'Settings'}
            </Text>
            <span className="desktop-label">
              <span className="accent-dot" />
              YOUR DESKTOP
            </span>
          </header>
          <div className="panel-content">
            {controller.message && (
              <Alert
                role="alert"
                title="Something needs attention"
                color="charcoal"
                variant="light"
                mb="lg"
              >
                {controller.message}
              </Alert>
            )}
            {page === DesktopPage.WORKSPACE ? (
              <ComputerUsePage controller={controller} />
            ) : (
              <SettingsPage user={user} />
            )}
          </div>
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
