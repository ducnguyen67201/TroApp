import { useMicrophoneTests } from './voice/UseMicrophoneTests.js';
import { useMicrophones } from './voice/UseMicrophones.js';
import { MicrophonePicker } from './voice/MicrophonePicker.js';
import { VoiceState } from '#contracts/VoiceInput.js';
import { useVoiceInput } from './voice/UseVoiceInput.js';
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
  IconMicrophone,
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
import { useCursorCompanion } from './UseCursorCompanion.js';

const DesktopPage = { WORKSPACE: 'workspace', SETTINGS: 'settings' } as const;

type DesktopPage = (typeof DesktopPage)[keyof typeof DesktopPage];

export function App(): ReactElement {
  const { messages } = useLocale();
  const [page, setPage] = useState<DesktopPage>(DesktopPage.WORKSPACE);
  const controller = useComputerUse();
  const { user } = controller;
  const [isMicrophonePickerOpen, setIsMicrophonePickerOpen] = useState(false);
  const microphones = useMicrophones(Boolean(user));
  const voice = useVoiceInput(
    user?.id ?? null,
    controller.receiveVoiceEvent,
    controller.taskMode,
    microphones,
  );

  const microphoneTests = useMicrophoneTests(
    Boolean(user) && !controller.isSigningOut,
    microphones,
  );
  const canTestMicrophone =
    Boolean(user) &&
    !controller.isSigningOut &&
    !controller.isSending &&
    !voice.isStarting &&
    (voice.status.state === VoiceState.IDLE || voice.status.state === VoiceState.DISABLED);

  useEffect(() => {
    if (!isMicrophonePickerOpen) {
      microphoneTests.cancelTest();
    }
  }, [isMicrophonePickerOpen, microphoneTests.cancelTest]);

  useEffect(() => {
    if (!user) {
      setIsMicrophonePickerOpen(false);
      return;
    }
    if (voice.status.state === VoiceState.IDLE) {
      void microphones.refreshMicrophones();
    }
  }, [user, voice.status.state, microphones.refreshMicrophones]);
  const permissions = useDesktopPermissions(user?.id ?? null);
  const companionMessage = useCursorCompanion(
    user?.id ?? null,
    permissions.status?.kind === 'ready' && !controller.isSigningOut,
  );
  const previousPermissionKind = useRef(permissions.status?.kind);

  useEffect(() => {
    if (permissions.status?.kind === 'ready' && previousPermissionKind.current !== 'ready') {
      setPage(DesktopPage.WORKSPACE);
    }
    previousPermissionKind.current = permissions.status?.kind;
  }, [permissions.status?.kind]);

  return (
    <>
      <MicrophonePicker
        opened={isMicrophonePickerOpen && Boolean(user)}
        onClose={() => {
          microphoneTests.cancelTest();
          setIsMicrophonePickerOpen(false);
        }}
        tests={microphoneTests}
        canTest={canTestMicrophone}
        microphones={microphones}
        isEnabled={Boolean(user)}
        hasVoiceError={voice.error}
        retryVoice={() => voice.retryVoice()}
        isRetryingVoice={voice.isStarting}
      />
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
              <Group gap="md">
                {user && (
                  <Button
                    variant="subtle"
                    leftSection={<IconMicrophone size={16} />}
                    onClick={() => {
                      setIsMicrophonePickerOpen(true);
                    }}
                  >
                    {messages.microphone}
                  </Button>
                )}
                <span className="desktop-label">
                  <span className="accent-dot" />
                  {messages.yourDesktop}
                </span>
              </Group>
            </header>
            <div className="panel-content">
              {(controller.message || companionMessage) && (
                <Alert
                  role="alert"
                  title={messages.attention}
                  color="charcoal"
                  variant="light"
                  mb="lg"
                >
                  {controller.message || companionMessage}
                </Alert>
              )}
              {user && voice.error && (
                <Alert role="alert" color="charcoal" mb="lg">
                  {messages.microphoneVoiceError}
                </Alert>
              )}
              {page === DesktopPage.SETTINGS ? (
                <SettingsPage
                  user={user}
                  onChooseMicrophone={() => {
                    setIsMicrophonePickerOpen(true);
                  }}
                />
              ) : user && permissions.status?.kind !== 'ready' ? (
                <PermissionsOnboardingPage controller={permissions} />
              ) : (
                <ComputerUsePage controller={controller} />
              )}
            </div>
          </div>
        </AppShell.Main>
      </AppShell>
    </>
  );
}
