import { AccountMenu } from './accounts/AccountMenu.js';
import { useVoiceover } from './voiceover/UseVoiceover.js';
import { useFocusReturn } from '@mantine/hooks';
import { useMicrophoneTests } from './voice/UseMicrophoneTests.js';
import { useMicrophones } from './voice/UseMicrophones.js';
import { MicrophonePicker } from './voice/MicrophonePicker.js';
import { VoiceState } from '#contracts/VoiceInput.js';
import { useVoiceInput } from './voice/UseVoiceInput.js';
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  useModalsStack,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconSchool,
  IconChartBar,
  IconMicrophone,
  IconLayoutSidebar,
  IconLogout,
  IconSettings,
  IconPlayerPlay,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ComputerUsePage } from './ComputerUsePage.js';
import { PermissionsOnboardingPage } from './PermissionsOnboardingPage.js';
import { SettingsDialog } from './SettingsDialog.js';
import { useComputerUse } from './UseComputerUse.js';
import { useLocale } from './localization/UseLocale.js';
import { useDesktopPermissions } from './UseDesktopPermissions.js';
import { useCursorCompanion } from './UseCursorCompanion.js';
import { DesktopWindowAppearance } from '../DesktopAppearance.js';
import { TroIcon } from './TroIcon.js';
import { AppUpdateButton } from './updates/AppUpdateButton.js';
import { ClassroomPage } from './classroom/ClassroomPage.js';
import { GuidedLessonsPage } from './guidedLessons/GuidedLessonsPage.js';
import { AccountRole } from '#contracts/AccountRole.js';

import { DesktopPage } from './navigation/DesktopRoute.js';
import { useDesktopNavigation } from './navigation/UseDesktopNavigation.js';
const DesktopDialog = { SETTINGS: 'settings', MICROPHONE: 'microphone' } as const;

export function App(): ReactElement {
  const { messages, locale } = useLocale();
  const navigation = useDesktopNavigation();
  const page = navigation.route.page;
  const signedInUserId = useRef<string | null>(null);
  const [accountRole, setAccountRole] = useState<AccountRole | null>(null);
  const classroomLabel = locale === 'vi' ? 'Lớp học' : 'Classroom';
  const roleLabel =
    accountRole === AccountRole.TEACHER
      ? messages.accountTeacher
      : accountRole === AccountRole.STUDENT
        ? messages.accountStudent
        : '…';
  const dialogs = useModalsStack([DesktopDialog.SETTINGS, DesktopDialog.MICROPHONE]);
  const { close: closeDialog } = dialogs;
  /* Modal.Stack changes trapFocus when the top dialog changes. Restore the
     captured opener after that transition instead of coupling it to the trap. */
  const returnSettingsFocus = useFocusReturn({
    opened: dialogs.state.settings,
    shouldReturnFocus: false,
  });
  const returnMicrophoneFocus = useFocusReturn({
    opened: dialogs.state.microphone,
    shouldReturnFocus: false,
  });
  const controller = useComputerUse();
  const { user } = controller;
  const accountTransition =
    controller.isSigning || controller.isSwitchingAccount || controller.isSigningOut;
  const activeUserId = accountTransition ? null : (user?.id ?? null);
  const voiceover = useVoiceover(activeUserId);
  useEffect(() => {
    if (signedInUserId.current && signedInUserId.current !== user?.id) {
      navigation.openWorkspace();
    }
    signedInUserId.current = user?.id ?? null;
    setAccountRole(null);
  }, [user?.id, navigation.openWorkspace]);
  const microphones = useMicrophones(Boolean(user));
  const voice = useVoiceInput(
    activeUserId,
    controller.receiveVoiceEvent,
    controller.taskMode,
    microphones,
  );

  const microphoneTests = useMicrophoneTests(Boolean(user) && !accountTransition, microphones);
  const canTestMicrophone =
    Boolean(user) &&
    !accountTransition &&
    !controller.isSending &&
    !voice.isStarting &&
    (voice.status.state === VoiceState.IDLE || voice.status.state === VoiceState.DISABLED);

  useEffect(() => {
    if (!dialogs.state.microphone) {
      microphoneTests.cancelTest();
    }
  }, [dialogs.state.microphone, microphoneTests.cancelTest]);

  useEffect(() => {
    if (!user || accountTransition) {
      closeDialog(DesktopDialog.MICROPHONE);
      closeDialog(DesktopDialog.SETTINGS);
      return;
    }
    if (voice.status.state === VoiceState.IDLE) {
      void microphones.refreshMicrophones();
    }
  }, [user, accountTransition, voice.status.state, microphones.refreshMicrophones, closeDialog]);
  const permissions = useDesktopPermissions(user?.id ?? null);
  const companionMessage = useCursorCompanion(
    activeUserId,
    permissions.status?.kind === 'ready' && !accountTransition,
  );
  const previousPermissionKind = useRef(permissions.status?.kind);

  useEffect(() => {
    if (permissions.status?.kind === 'ready' && previousPermissionKind.current !== 'ready') {
      closeDialog(DesktopDialog.SETTINGS);
    }
    previousPermissionKind.current = permissions.status?.kind;
  }, [permissions.status?.kind, closeDialog]);

  return (
    <>
      <Modal.Stack>
        <SettingsDialog
          {...dialogs.register(DesktopDialog.SETTINGS)}
          onExitTransitionEnd={() => {
            if (!dialogs.state.microphone) {
              returnSettingsFocus();
            }
          }}
          user={user}
          microphones={microphones}
          voiceStatus={voice.status}
          voiceover={voiceover}
          onChooseMicrophone={() => {
            dialogs.open(DesktopDialog.MICROPHONE);
          }}
        />
        <MicrophonePicker
          stackId={DesktopDialog.MICROPHONE}
          onExitTransitionEnd={returnMicrophoneFocus}
          opened={dialogs.state.microphone && Boolean(user)}
          onClose={() => {
            microphoneTests.cancelTest();
            closeDialog(DesktopDialog.MICROPHONE);
          }}
          tests={microphoneTests}
          canTest={canTestMicrophone}
          microphones={microphones}
          isEnabled={Boolean(user) && !accountTransition}
          hasVoiceError={voice.error}
          retryVoice={() => voice.retryVoice()}
          isRetryingVoice={voice.isStarting}
        />
      </Modal.Stack>
      <AppShell
        header={{ height: DesktopWindowAppearance.TITLE_BAR_HEIGHT }}
        navbar={{
          width: 96,
          breakpoint: 0,
          collapsed: { desktop: !user, mobile: !user },
        }}
        padding={0}
        className="desktop-shell"
        data-compact={Boolean(user) || undefined}
        data-signed-out={!user || undefined}
        data-page={page}
      >
        <AppShell.Header className="window-titlebar" withBorder={false} aria-hidden="true" />
        {user && (
          <AppShell.Navbar className="desktop-sidebar" withBorder={false}>
            <Group gap={10} className="brand">
              <TroIcon size={32} />
              <Stack gap={3}>
                <Text fw={650} size="xl">
                  Tro
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  aria-label={locale === 'vi' ? 'Vai trò tài khoản' : 'Account role'}
                >
                  {roleLabel}
                </Badge>
              </Stack>
            </Group>
            <nav aria-label={messages.navigation} className="sidebar-navigation">
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={
                  (!dialogs.state.settings && page === DesktopPage.WORKSPACE) || undefined
                }
                aria-current={page === DesktopPage.WORKSPACE ? 'page' : undefined}
                onClick={() => {
                  closeDialog(DesktopDialog.SETTINGS);
                  navigation.openWorkspace();
                }}
              >
                <IconLayoutSidebar size={19} stroke={1.6} />
                <span>{messages.workspace}</span>
              </UnstyledButton>
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={
                  (!dialogs.state.settings && page === DesktopPage.CLASSROOM) || undefined
                }
                aria-current={page === DesktopPage.CLASSROOM ? 'page' : undefined}
                onClick={() => {
                  closeDialog(DesktopDialog.SETTINGS);
                  navigation.openClassroom();
                }}
              >
                <IconSchool size={19} stroke={1.6} />
                <span>{classroomLabel}</span>
              </UnstyledButton>
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={
                  (!dialogs.state.settings && page === DesktopPage.INSIGHTS) || undefined
                }
                aria-current={page === DesktopPage.INSIGHTS ? 'page' : undefined}
                onClick={() => {
                  closeDialog(DesktopDialog.SETTINGS);
                  navigation.openClassroom(true);
                }}
              >
                <IconChartBar size={19} stroke={1.6} />
                <span>{locale === 'vi' ? 'Tiến độ học tập' : 'Insights'}</span>
              </UnstyledButton>
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={
                  (!dialogs.state.settings && page === DesktopPage.GUIDED_LESSONS) || undefined
                }
                aria-current={page === DesktopPage.GUIDED_LESSONS ? 'page' : undefined}
                onClick={() => {
                  closeDialog(DesktopDialog.SETTINGS);
                  navigation.openGuidedLessons();
                }}
              >
                <IconPlayerPlay size={19} stroke={1.6} />
                <span>{messages.guidedLessonsNavigation}</span>
              </UnstyledButton>
            </nav>
            <div className="sidebar-bottom">
              <AppUpdateButton
                isBusy={
                  controller.isSending ||
                  controller.isResetting ||
                  controller.isSigning ||
                  controller.isSigningOut ||
                  controller.isSwitchingAccount ||
                  voice.isStarting ||
                  (voice.status.state !== VoiceState.IDLE &&
                    voice.status.state !== VoiceState.DISABLED) ||
                  microphoneTests.activeDeviceId !== null
                }
              />
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={dialogs.state.microphone || undefined}
                aria-haspopup="dialog"
                aria-expanded={dialogs.state.microphone}
                onClick={() => {
                  dialogs.open(DesktopDialog.MICROPHONE);
                }}
              >
                <IconMicrophone size={19} stroke={1.6} />
                <span>{messages.microphone}</span>
              </UnstyledButton>
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={dialogs.state.settings || undefined}
                aria-haspopup="dialog"
                aria-expanded={dialogs.state.settings}
                onClick={() => {
                  dialogs.open(DesktopDialog.SETTINGS);
                }}
              >
                <IconSettings size={19} stroke={1.6} />
                <span>{messages.settings}</span>
              </UnstyledButton>
              <section className="sidebar-account" aria-label={messages.yourAccount}>
                <AccountMenu
                  controller={controller}
                  roleLabel={roleLabel}
                  disabled={
                    accountTransition ||
                    controller.isSending ||
                    controller.isResetting ||
                    voice.isStarting ||
                    microphoneTests.activeDeviceId !== null
                  }
                />
                <Button
                  variant="subtle"
                  fullWidth
                  justify="flex-start"
                  leftSection={<IconLogout size={16} />}
                  loading={controller.isSigningOut}
                  disabled={
                    accountTransition ||
                    controller.isSending ||
                    controller.isResetting ||
                    voice.isStarting ||
                    microphoneTests.activeDeviceId !== null
                  }
                  onClick={() => void controller.signOut()}
                  className="logout-button"
                >
                  {messages.signOut}
                </Button>
              </section>
            </div>
          </AppShell.Navbar>
        )}
        <AppShell.Main className="desktop-main">
          {controller.isSwitchingAccount && (
            <div className="account-transition-status" role="status">
              <Loader size="sm" />
              <Text size="sm">{messages.accountSwitching}</Text>
            </div>
          )}
          <div className="main-panel" inert={accountTransition && Boolean(user)}>
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
              <div
                className="workspace-content"
                hidden={page !== DesktopPage.WORKSPACE && Boolean(user)}
              >
                {user && permissions.status?.kind !== 'ready' ? (
                  <PermissionsOnboardingPage controller={permissions} />
                ) : (
                  <ComputerUsePage
                    controller={controller}
                    signInActions={
                      <Stack gap="sm" align="center" className="sign-in-controls">
                        {controller.savedAccounts &&
                          controller.savedAccounts.accounts.length > 0 && (
                            <AccountMenu
                              controller={controller}
                              roleLabel={roleLabel}
                              disabled={accountTransition}
                            />
                          )}
                        {controller.isSigning && window.tro.cancelAccountSignIn && (
                          <Button
                            variant="subtle"
                            onClick={() => void controller.cancelAccountSignIn()}
                          >
                            {messages.accountCancelSignIn}
                          </Button>
                        )}
                        <Group gap="sm" justify="center">
                          <AppUpdateButton isBusy={accountTransition} />
                          <Button
                            variant="subtle"
                            leftSection={<IconSettings size={16} />}
                            disabled={accountTransition}
                            aria-haspopup="dialog"
                            aria-expanded={dialogs.state.settings}
                            onClick={() => {
                              dialogs.open(DesktopDialog.SETTINGS);
                            }}
                          >
                            {messages.settings}
                          </Button>
                        </Group>
                      </Stack>
                    }
                  />
                )}
              </div>
              {user && !accountTransition && (
                <ClassroomPage
                  key={user.id}
                  userId={user.id}
                  userName={user.name}
                  navigation={navigation}
                  onOpenWorkspace={(message) => {
                    if (message && controller.preparePracticeHelp) {
                      void controller.preparePracticeHelp(message).then((ready) => {
                        if (ready) {
                          navigation.openWorkspace();
                        }
                      });
                    } else {
                      navigation.openWorkspace();
                    }
                  }}
                  active={page === DesktopPage.CLASSROOM || page === DesktopPage.INSIGHTS}
                  onRoleChange={setAccountRole}
                />
              )}
              {user && !accountTransition && page === DesktopPage.GUIDED_LESSONS && (
                <GuidedLessonsPage
                  key={user.id}
                  userId={user.id}
                  initialClassId={navigation.route.classId}
                  onChooseClass={navigation.openGuidedLessons}
                  onRoleChange={setAccountRole}
                />
              )}
            </div>
          </div>
        </AppShell.Main>
      </AppShell>
    </>
  );
}
