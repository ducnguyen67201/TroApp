import { AdminOrganizationSwitcher } from './team/AdminOrganizationSwitcher.js';
import { LessonVideosPage } from './lessonVideos/LessonVideosPage.js';
import { AnalyticsScreen } from '#contracts/Analytics.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import { useAnalytics } from './analytics/UseAnalytics.js';
import { OnboardingStep } from '#contracts/OnboardingValues.js';
import { useOnboarding } from './onboarding/UseOnboarding.js';
import { OnboardingFlow, type OnboardingAnchors } from './onboarding/OnboardingFlow.js';
import { WhatsNewDialog } from './updates/WhatsNewDialog.js';
import { useWhatsNew } from './updates/UseWhatsNew.js';
import { whatsNewMessages } from './updates/WhatsNewMessages.js';
import { AccountMenu } from './accounts/AccountMenu.js';
import { StudentSignInButton } from './accounts/StudentAccessForm.js';
import { useVoiceover } from './voiceover/UseVoiceover.js';
import { useFocusReturn } from '@mantine/hooks';
import { useMicrophoneTests } from './voice/UseMicrophoneTests.js';
import { useMicrophonePreview } from './voice/UseMicrophonePreview.js';
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
  IconMessageCircleStar,
  IconSchool,
  IconChartBar,
  IconMicrophone,
  IconMessageCircle,
  IconSettings,
  IconPaw,
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
import { OrganizationBrand } from './team/OrganizationBrand.js';
import { AppUpdateButton } from './updates/AppUpdateButton.js';
import { useAppUpdate } from './updates/UseAppUpdate.js';
import { ClassroomPage } from './classroom/ClassroomPage.js';
import { useOrganizationSetup } from './team/UseOrganizationSetup.js';
import { OrganizationSetupDialog } from './team/OrganizationSetupDialog.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldPage } from './petWorld/PetWorldPage.js';

import { DesktopPage } from './navigation/DesktopRoute.js';
import { useDesktopNavigation } from './navigation/UseDesktopNavigation.js';

const analyticsScreens = {
  [DesktopPage.WORKSPACE]: AnalyticsScreen.WORKSPACE,
  [DesktopPage.CLASSROOM]: AnalyticsScreen.CLASSROOM,
  [DesktopPage.INSIGHTS]: AnalyticsScreen.INSIGHTS,
  [DesktopPage.LESSON_VIDEOS]: AnalyticsScreen.LESSON_VIDEOS,
  [DesktopPage.PET_WORLD]: AnalyticsScreen.PET_WORLD,
} satisfies Record<(typeof DesktopPage)[keyof typeof DesktopPage], AnalyticsScreen>;

const DesktopDialog = {
  SETTINGS: 'settings',
  MICROPHONE: 'microphone',
  WHATS_NEW: 'whats-new',
} as const;

export function App(): ReactElement {
  const { messages, locale } = useLocale();
  const update = useAppUpdate();
  const whatsNew = useWhatsNew();
  const releaseMessages = whatsNewMessages[locale];
  const hasAutoOpenedWhatsNew = useRef(false);
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
  const dialogs = useModalsStack([
    DesktopDialog.SETTINGS,
    DesktopDialog.MICROPHONE,
    DesktopDialog.WHATS_NEW,
  ]);
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
  const returnWhatsNewFocus = useFocusReturn({
    opened: dialogs.state['whats-new'],
    shouldReturnFocus: false,
  });
  const controller = useComputerUse();
  const { user } = controller;
  const accountTransition =
    controller.isSigning || controller.isSwitchingAccount || controller.isSigningOut;
  const activeUserId = accountTransition ? null : (user?.id ?? null);
  const [teamRevision, setTeamRevision] = useState(0);
  const [logoOrganizationId, setLogoOrganizationId] = useState<string | null>(null);
  const organizationSetup = useOrganizationSetup(user?.learner ? null : activeUserId);
  const [isSwitchingOrganization, setSwitchingOrganization] = useState(false);
  const organizationScopeKey = `${activeUserId ?? 'signed-out'}:${organizationSetup.adminOrganizationId ?? 'personal'}`;
  const workspaceUserId =
    organizationSetup.isBlocking || isSwitchingOrganization ? null : activeUserId;

  async function selectAdminOrganization(organizationId: string | null): Promise<void> {
    setSwitchingOrganization(true);
    closeDialog(DesktopDialog.SETTINGS);
    try {
      if (await organizationSetup.selectAdminOrganization(organizationId)) {
        setLogoOrganizationId(null);
        setAccountRole(null);
        setTeamRevision((revision) => revision + 1);
        navigation.openClassroom();
      }
    } finally {
      setSwitchingOrganization(false);
    }
  }

  const analytics = useAnalytics(
    controller.isLoading || accountTransition
      ? null
      : user
        ? analyticsScreens[page]
        : AnalyticsScreen.SIGN_IN,
  );
  const voiceUserId = user?.learner ? null : workspaceUserId;
  const voiceover = useVoiceover(voiceUserId);
  const onboarding = useOnboarding(workspaceUserId);
  const workspaceAnchor = useRef<HTMLButtonElement>(null);
  const classesAnchor = useRef<HTMLButtonElement>(null);
  const insightsAnchor = useRef<HTMLButtonElement>(null);
  // The retained tour points to the rebuilt teacher lesson workspace.
  const lessonsAnchor = useRef<HTMLButtonElement>(null);
  const microphoneAnchor = useRef<HTMLButtonElement>(null);
  const settingsAnchor = useRef<HTMLButtonElement>(null);
  const onboardingAnchors: OnboardingAnchors = {
    [OnboardingStep.WORKSPACE]: workspaceAnchor,
    [OnboardingStep.CLASSES]: classesAnchor,
    [OnboardingStep.INSIGHTS]: insightsAnchor,
    [OnboardingStep.GUIDED_LESSONS]: lessonsAnchor,
    [OnboardingStep.MICROPHONE]: microphoneAnchor,
    [OnboardingStep.PETS]: settingsAnchor,
  };
  useEffect(() => {
    if (signedInUserId.current && signedInUserId.current !== user?.id) {
      navigation.openWorkspace();
    }
    signedInUserId.current = user?.id ?? null;
    setAccountRole(null);
  }, [user?.id, navigation.openWorkspace]);
  const microphones = useMicrophones(Boolean(user));
  const voice = useVoiceInput(
    voiceUserId,
    controller.receiveVoiceEvent,
    controller.taskMode,
    microphones,
  );

  const microphoneTests = useMicrophoneTests(Boolean(user) && !accountTransition, microphones);
  const canTestMicrophone =
    !organizationSetup.isBlocking &&
    Boolean(user) &&
    !accountTransition &&
    !controller.isSending &&
    !voice.isStarting &&
    (voice.status.state === VoiceState.IDLE || voice.status.state === VoiceState.DISABLED);
  const microphonePreview = useMicrophonePreview(
    dialogs.state.microphone && canTestMicrophone && microphoneTests.activeDeviceId === null,
    microphones,
  );
  const canStartMicrophoneCapture = useRef(false);
  const microphoneCaptureGeneration = useRef(0);
  canStartMicrophoneCapture.current = dialogs.state.microphone && canTestMicrophone;

  async function startMicrophoneTest(deviceId: string): Promise<void> {
    const generation = ++microphoneCaptureGeneration.current;
    await microphonePreview.stopPreview();
    if (!canStartMicrophoneCapture.current || generation !== microphoneCaptureGeneration.current) {
      return;
    }
    await microphoneTests.startTest(deviceId);
  }

  async function pausePreviewAndRetryVoice(): Promise<void> {
    const generation = ++microphoneCaptureGeneration.current;
    await microphonePreview.stopPreview();
    if (!canStartMicrophoneCapture.current || generation !== microphoneCaptureGeneration.current) {
      return;
    }
    await voice.retryVoice();
  }

  useEffect(() => {
    if (!dialogs.state.microphone || !canTestMicrophone) {
      microphoneCaptureGeneration.current += 1;
    }
    if (!dialogs.state.microphone) {
      microphoneTests.cancelTest();
    }
  }, [dialogs.state.microphone, canTestMicrophone, microphoneTests.cancelTest]);

  useEffect(() => {
    if (!user || accountTransition || organizationSetup.isBlocking) {
      closeDialog(DesktopDialog.MICROPHONE);
      closeDialog(DesktopDialog.SETTINGS);
      closeDialog(DesktopDialog.WHATS_NEW);
      return;
    }
    if (voice.status.state === VoiceState.IDLE) {
      void microphones.refreshMicrophones();
    }
  }, [
    user,
    accountTransition,
    organizationSetup.isBlocking,
    voice.status.state,
    microphones.refreshMicrophones,
    closeDialog,
  ]);
  const permissions = useDesktopPermissions(user?.id ?? null);
  const companionMessage = useCursorCompanion(
    workspaceUserId,
    permissions.status?.kind === 'ready' && !accountTransition,
  );
  const previousPermissionKind = useRef(permissions.status?.kind);

  useEffect(() => {
    /* The first permission read can finish after the user opens Settings.
     * Close it only when recovering from a known permission problem. */
    const hadPermissionProblem =
      previousPermissionKind.current === DesktopPermissionState.NEEDS_PERMISSION ||
      previousPermissionKind.current === DesktopPermissionState.UNKNOWN;
    if (permissions.status?.kind === DesktopPermissionState.READY && hadPermissionProblem) {
      closeDialog(DesktopDialog.SETTINGS);
    }
    previousPermissionKind.current = permissions.status?.kind;
  }, [permissions.status?.kind, closeDialog]);

  useEffect(() => {
    const canShowTour =
      !organizationSetup.isBlocking &&
      Boolean(activeUserId) &&
      permissions.status?.kind === 'ready' &&
      !controller.isSending &&
      !controller.isResetting &&
      !voice.isStarting &&
      (voice.status.state === VoiceState.IDLE || voice.status.state === VoiceState.DISABLED) &&
      microphoneTests.activeDeviceId === null &&
      !dialogs.state.settings &&
      !dialogs.state.microphone &&
      !dialogs.state['whats-new'];
    if (whatsNew.shouldAutoShow && canShowTour && !hasAutoOpenedWhatsNew.current) {
      hasAutoOpenedWhatsNew.current = true;
      dialogs.open(DesktopDialog.WHATS_NEW);
    }
  }, [
    activeUserId,
    organizationSetup.isBlocking,
    permissions.status?.kind,
    controller.isSending,
    controller.isResetting,
    voice.isStarting,
    voice.status.state,
    microphoneTests.activeDeviceId,
    dialogs,
    whatsNew.shouldAutoShow,
  ]);

  return (
    <>
      <OrganizationSetupDialog
        key={`organization-setup:${activeUserId ?? 'signed-out'}`}
        view={organizationSetup}
        onSignOut={controller.signOut}
      />
      <Modal.Stack>
        <WhatsNewDialog
          {...dialogs.register(DesktopDialog.WHATS_NEW)}
          onExitTransitionEnd={returnWhatsNewFocus}
          onPresented={whatsNew.markSeen}
          release={whatsNew.release}
          didFailToSave={whatsNew.didFailToSave}
        />
        <SettingsDialog
          key={organizationScopeKey}
          {...dialogs.register(DesktopDialog.SETTINGS)}
          onExitTransitionEnd={() => {
            if (!dialogs.state.microphone) {
              returnSettingsFocus();
            }
          }}
          user={accountTransition ? null : user}
          onCreateOrganization={() => {
            closeDialog(DesktopDialog.SETTINGS);
            organizationSetup.openChoice();
          }}
          teamOrganizationId={organizationSetup.adminOrganizationId ?? logoOrganizationId}
          onTeamChanged={() => {
            setAccountRole(null);
            setTeamRevision((revision) => revision + 1);
            void organizationSetup.refresh();
          }}
          onboarding={onboarding}
          analytics={analytics}
          update={update}
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
            microphoneCaptureGeneration.current += 1;
            canStartMicrophoneCapture.current = false;
            void microphonePreview.stopPreview();
            microphoneTests.cancelTest();
            closeDialog(DesktopDialog.MICROPHONE);
          }}
          tests={{ ...microphoneTests, startTest: startMicrophoneTest }}
          preview={microphonePreview}
          canTest={canTestMicrophone}
          microphones={microphones}
          isEnabled={Boolean(user) && !accountTransition}
          hasVoiceError={voice.error}
          retryVoice={pausePreviewAndRetryVoice}
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
          <AppShell.Navbar
            className="desktop-sidebar"
            withBorder={false}
            inert={organizationSetup.isBlocking}
          >
            <Group gap={10} className="brand">
              <OrganizationBrand
                accountId={user.id}
                administeredOrganizationId={organizationSetup.adminOrganizationId}
                organizations={accountTransition ? [] : organizationSetup.organizations}
                onEditLogo={(organizationId) => {
                  setLogoOrganizationId(organizationId);
                  dialogs.open(DesktopDialog.SETTINGS);
                }}
              />
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
                ref={workspaceAnchor}
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
                <IconMessageCircle size={19} stroke={1.6} />
                <span>{messages.workspace}</span>
              </UnstyledButton>
              <UnstyledButton
                ref={classesAnchor}
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
                ref={insightsAnchor}
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
              {accountRole === AccountRole.TEACHER && (
                <UnstyledButton
                  ref={lessonsAnchor}
                  className="sidebar-link"
                  disabled={accountTransition}
                  data-active={page === DesktopPage.LESSON_VIDEOS || undefined}
                  aria-current={page === DesktopPage.LESSON_VIDEOS ? 'page' : undefined}
                  onClick={() => {
                    window.location.hash = '#/lesson-videos';
                  }}
                >
                  <IconPlayerPlay size={19} stroke={1.6} />
                  <span>
                    {locale === 'vi' ? 'Video bài giảng (Thử nghiệm)' : 'Lesson videos (Beta)'}
                  </span>
                </UnstyledButton>
              )}
              <UnstyledButton
                className="sidebar-link"
                disabled={accountTransition}
                data-active={
                  (!dialogs.state.settings && page === DesktopPage.PET_WORLD) || undefined
                }
                aria-current={page === DesktopPage.PET_WORLD ? 'page' : undefined}
                onClick={() => {
                  closeDialog(DesktopDialog.SETTINGS);
                  navigation.openPetWorld();
                }}
              >
                <IconPaw size={19} stroke={1.6} />
                <span>{locale === 'vi' ? 'Thế giới thú cưng' : 'Pet world'}</span>
              </UnstyledButton>
            </nav>
            <div className="sidebar-bottom">
              <AppUpdateButton
                update={update}
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
                ref={microphoneAnchor}
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
                className="sidebar-link sidebar-whats-new"
                aria-label={releaseMessages.title}
                disabled={accountTransition}
                data-active={dialogs.state['whats-new'] || undefined}
                aria-haspopup="dialog"
                aria-expanded={dialogs.state['whats-new']}
                onClick={() => {
                  dialogs.open(DesktopDialog.WHATS_NEW);
                }}
              >
                <IconMessageCircleStar size={19} stroke={1.6} />
                <span>{releaseMessages.title}</span>
                {whatsNew.hasUnseenRelease && (
                  <span
                    className="whats-new-unseen-dot"
                    role="img"
                    aria-label={releaseMessages.unseen}
                  />
                )}
              </UnstyledButton>
              <UnstyledButton
                ref={settingsAnchor}
                className="sidebar-link"
                disabled={accountTransition}
                data-active={dialogs.state.settings || undefined}
                aria-haspopup="dialog"
                aria-expanded={dialogs.state.settings}
                onClick={() => {
                  setLogoOrganizationId(null);
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
          <div
            className="main-panel"
            inert={
              (accountTransition && Boolean(user)) ||
              organizationSetup.isBlocking ||
              isSwitchingOrganization
            }
          >
            {organizationSetup.isAdmin && (
              <AdminOrganizationSwitcher
                view={organizationSetup}
                disabled={
                  accountTransition ||
                  isSwitchingOrganization ||
                  controller.isSending ||
                  controller.isResetting
                }
                onSelect={selectAdminOrganization}
              />
            )}
            <div className="panel-content" hidden={isSwitchingOrganization}>
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
                    voice={voiceUserId ? voice : null}
                    signInActions={
                      <Stack gap="sm" align="center" className="sign-in-controls">
                        {window.tro.controlStudentAccess && (
                          <StudentSignInButton controller={controller} />
                        )}
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
                          <AppUpdateButton update={update} isBusy={accountTransition} />
                          <Button
                            variant="subtle"
                            leftSection={<IconMessageCircleStar size={16} />}
                            disabled={accountTransition}
                            aria-haspopup="dialog"
                            aria-expanded={dialogs.state['whats-new']}
                            onClick={() => {
                              dialogs.open(DesktopDialog.WHATS_NEW);
                            }}
                          >
                            {releaseMessages.title}
                          </Button>
                          <Button
                            variant="subtle"
                            leftSection={<IconSettings size={16} />}
                            disabled={accountTransition}
                            aria-haspopup="dialog"
                            aria-expanded={dialogs.state.settings}
                            onClick={() => {
                              setLogoOrganizationId(null);
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
              {user && !accountTransition && !organizationSetup.isBlocking && (
                <ClassroomPage
                  key={organizationScopeKey}
                  refreshRevision={teamRevision}
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
              {user &&
                !accountTransition &&
                !organizationSetup.isBlocking &&
                page === DesktopPage.LESSON_VIDEOS && (
                  <LessonVideosPage key={organizationScopeKey} locale={locale} />
                )}
              {user &&
                !accountTransition &&
                !organizationSetup.isBlocking &&
                page === DesktopPage.PET_WORLD && (
                  <PetWorldPage
                    key={organizationScopeKey}
                    userId={user.id}
                    userName={user.name}
                    initialClassId={navigation.route.classId}
                    onChooseClass={navigation.openPetWorld}
                    onRoleChange={setAccountRole}
                  />
                )}
            </div>
          </div>
        </AppShell.Main>
      </AppShell>
      <OnboardingFlow
        key={`onboarding:${activeUserId ?? 'signed-out'}`}
        view={onboarding}
        anchors={onboardingAnchors}
        role={accountRole}
        canPresent={
          !organizationSetup.isBlocking &&
          Boolean(activeUserId) &&
          !dialogs.state.settings &&
          !dialogs.state.microphone &&
          !dialogs.state['whats-new'] &&
          !whatsNew.shouldAutoShow &&
          !controller.isSending &&
          !controller.isResetting &&
          !voice.isStarting &&
          (voice.status.state === VoiceState.IDLE || voice.status.state === VoiceState.DISABLED) &&
          microphoneTests.activeDeviceId === null &&
          (page !== DesktopPage.WORKSPACE || permissions.status?.kind === 'ready')
        }
      />
    </>
  );
}
