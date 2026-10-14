import type { OnboardingView } from './onboarding/UseOnboarding.js';
import { AnalyticsPreferenceFailure, type AnalyticsView } from './analytics/UseAnalytics.js';
import { analyticsMessages } from './analytics/AnalyticsMessages.js';
import { onboardingMessages } from './onboarding/OnboardingMessages.js';
import { PetGallery } from './pets/PetGallery.js';
import { TeamPanel } from './team/TeamPanel.js';
import { teamMessages } from './team/TeamMessages.js';
import { petMessages } from './pets/PetMessages.js';
import { Badge, Button, Modal, NativeSelect, Switch, Tabs, Text, Title } from '@mantine/core';
import type { VoiceoverView } from './voiceover/UseVoiceover.js';
import { VoiceoverState } from '#contracts/Voiceover.js';
import { IconPaw, IconSettings, IconUserCircle, IconUsers } from '@tabler/icons-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { VoiceShortcut, type VoiceStatus } from '#contracts/VoiceInput.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import { desktopLocales } from './localization/Locale.js';
import { useLocale } from './localization/UseLocale.js';
import { defaultMicrophoneId } from './voice/Microphones.js';
import type { MicrophoneView } from './voice/UseMicrophones.js';

const SettingsSection = {
  GENERAL: 'general',
  ACCOUNT: 'account',
  PETS: 'pets',
  TEAM: 'team',
} as const;

const shortcutLabels = {
  [VoiceShortcut.COMMAND_CONTROL]: 'Command + Control',
  [VoiceShortcut.CONTROL_ALT]: 'Control + Left Alt',
  [VoiceShortcut.CONTROL_SHIFT]: 'Control + Shift',
} satisfies Record<VoiceShortcut, string>;

interface SettingsDialogProps {
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd: () => void;
  stackId: string;
  user: AuthUser | null;
  microphones: MicrophoneView;
  voiceStatus: VoiceStatus;
  voiceover?: VoiceoverView;
  onChooseMicrophone: () => void;
  onboarding?: OnboardingView;
  analytics?: AnalyticsView;
  onTeamChanged?: () => void;
  onCreateOrganization?: (() => void) | undefined;
  teamOrganizationId?: string | null;
}

interface SettingsRowProps {
  label: string;
  description: ReactNode;
  children?: ReactNode;
}

function SettingsRow({ label, description, children }: SettingsRowProps): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Text size="sm" c="dimmed" mt={4}>
          {description}
        </Text>
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** Local preferences in a stacked dialog; the workspace and voice hooks stay mounted. */
export function SettingsDialog({
  opened,
  onClose,
  onExitTransitionEnd,
  stackId,
  user,
  microphones,
  voiceStatus,
  voiceover,
  onChooseMicrophone,
  onboarding,
  analytics,
  onTeamChanged,
  onCreateOrganization,
  teamOrganizationId,
}: SettingsDialogProps): ReactElement {
  const { locale, messages, changeLocale, isLocaleSaved } = useLocale();
  const languageDescriptionId = useId();
  const analyticsDescriptionId = useId();
  const analyticsCopy = analyticsMessages[locale];
  const onboardingCopy = onboardingMessages[locale];
  const selectedMicrophone = microphones.microphones.find(
    (microphone) => microphone.deviceId === microphones.selectedDeviceId,
  );
  const microphoneLabel =
    microphones.selectedDeviceId === defaultMicrophoneId
      ? microphones.defaultLabel
        ? `${messages.microphoneAuto} · ${microphones.defaultLabel}`
        : messages.microphoneAuto
      : selectedMicrophone?.label || messages.microphoneUnnamed;
  const isSuggested =
    selectedMicrophone !== undefined &&
    microphones.selectedDeviceId === microphones.recommendedDeviceId;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      returnFocus={false}
      onExitTransitionEnd={onExitTransitionEnd}
      stackId={stackId}
      title={messages.settings}
      closeButtonProps={{ 'aria-label': messages.settingsClose }}
      centered
      size={920}
      padding={0}
      radius="lg"
      classNames={{
        content: 'settings-dialog',
        header: 'settings-dialog-header',
        body: 'settings-dialog-body',
      }}
    >
      <Tabs
        key={teamOrganizationId ?? SettingsSection.GENERAL}
        defaultValue={
          teamOrganizationId && user && !user.learner
            ? SettingsSection.TEAM
            : SettingsSection.GENERAL
        }
        orientation="vertical"
        variant="pills"
        keepMounted={false}
        classNames={{
          root: 'settings-layout',
          list: 'settings-navigation',
          tab: 'settings-tab',
          tabSection: 'settings-tab-icon',
          tabLabel: 'settings-tab-label',
          panel: 'settings-panel',
        }}
      >
        <Tabs.List aria-label={messages.settingsNavigation}>
          <div className="settings-navigation-group" role="presentation">
            <Text component="div" className="settings-navigation-heading" aria-hidden="true">
              {messages.settingsPreferences}
            </Text>
            <Tabs.Tab
              value={SettingsSection.GENERAL}
              leftSection={<IconSettings size={18} stroke={1.7} aria-hidden="true" />}
            >
              {messages.settingsGeneral}
            </Tabs.Tab>
            <Tabs.Tab
              value={SettingsSection.PETS}
              leftSection={<IconPaw size={18} stroke={1.7} aria-hidden="true" />}
            >
              {petMessages[locale].pets}
            </Tabs.Tab>
          </div>
          <div className="settings-navigation-group" role="presentation">
            <Text component="div" className="settings-navigation-heading" aria-hidden="true">
              {messages.account}
            </Text>
            <Tabs.Tab
              value={SettingsSection.ACCOUNT}
              leftSection={<IconUserCircle size={18} stroke={1.7} aria-hidden="true" />}
            >
              {messages.account}
            </Tabs.Tab>
            {user && !user.learner && (
              <Tabs.Tab
                value={SettingsSection.TEAM}
                leftSection={<IconUsers size={18} stroke={1.7} aria-hidden="true" />}
              >
                {teamMessages[locale].title}
              </Tabs.Tab>
            )}
          </div>
        </Tabs.List>
        <Tabs.Panel value={SettingsSection.GENERAL}>
          <Title order={3}>{messages.settingsGeneral}</Title>
          <div className="settings-rows">
            <SettingsRow
              label={messages.settingsShortcut}
              description={
                user && !voiceStatus.globalShortcutAvailable
                  ? messages.settingsShortcutUnavailable
                  : messages.settingsShortcutHint
              }
            >
              {user ? (
                <kbd className="settings-shortcut">{shortcutLabels[voiceStatus.shortcut]}</kbd>
              ) : (
                <Text size="sm" c="dimmed">
                  {messages.signIn}
                </Text>
              )}
            </SettingsRow>
            <SettingsRow
              label={messages.microphone}
              description={
                user ? (
                  <span className="settings-microphone-summary">
                    <span>{microphoneLabel}</span>
                    {microphones.isSelectedUnavailable && (
                      <span>{messages.settingsMicrophoneUnavailable}</span>
                    )}
                    {isSuggested && (
                      <Badge component="span" size="xs" variant="light">
                        {microphones.hasCustomRanking
                          ? messages.microphonePreferred
                          : messages.microphoneSuggested}
                      </Badge>
                    )}
                  </span>
                ) : (
                  messages.microphoneSignInHint
                )
              }
            >
              <Button variant="default" onClick={onChooseMicrophone} disabled={!user}>
                {messages.microphoneChange}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={messages.language}
              description={<span id={languageDescriptionId}>{messages.languageDescription}</span>}
            >
              <NativeSelect
                aria-label={messages.language}
                aria-describedby={languageDescriptionId}
                value={locale}
                onChange={(event) => {
                  changeLocale(event.currentTarget.value);
                }}
                data={Object.entries(desktopLocales).map(([value, entry]) => ({
                  value,
                  label: entry.label,
                }))}
              />
            </SettingsRow>
            {voiceover && (
              <SettingsRow
                label={messages.voiceover}
                description={
                  voiceover.status.state === VoiceoverState.UNAVAILABLE
                    ? messages.voiceoverUnavailable
                    : messages.voiceoverDescription
                }
              >
                <Switch
                  aria-label={messages.voiceover}
                  checked={voiceover.enabled}
                  onChange={(event) => {
                    voiceover.changeEnabled(event.currentTarget.checked);
                  }}
                />
                <Button
                  variant="default"
                  onClick={() => {
                    voiceover.stopSpeaking();
                  }}
                  disabled={
                    voiceover.status.state !== VoiceoverState.PREPARING &&
                    voiceover.status.state !== VoiceoverState.SPEAKING
                  }
                >
                  {messages.voiceoverStop}
                </Button>
              </SettingsRow>
            )}
            {analytics && (
              <SettingsRow
                label={analyticsCopy.title}
                description={
                  <span id={analyticsDescriptionId}>
                    {analyticsCopy.description} {analyticsCopy.scope}
                    {analytics.status?.configured === false && ` ${analyticsCopy.unavailable}`}
                  </span>
                }
              >
                <Switch
                  aria-label={analyticsCopy.title}
                  aria-describedby={analyticsDescriptionId}
                  checked={analytics.status?.enabled ?? false}
                  disabled={
                    !analytics.status?.configured || analytics.isLoading || analytics.isSaving
                  }
                  onChange={(event) => {
                    void analytics.changeEnabled(event.currentTarget.checked);
                  }}
                />
              </SettingsRow>
            )}
            {(analytics?.isLoading || analytics?.isSaving) && (
              <Text size="sm" c="dimmed" role="status">
                {analytics.isSaving ? analyticsCopy.saving : analyticsCopy.loading}
              </Text>
            )}
            {analytics?.failure && (
              <div role="alert">
                <Text size="sm">
                  {analytics.failure === AnalyticsPreferenceFailure.LOAD
                    ? analyticsCopy.loadFailed
                    : analyticsCopy.saveFailed}
                </Text>
                <Button
                  variant="subtle"
                  disabled={analytics.isLoading || analytics.isSaving}
                  onClick={() => {
                    void analytics.retry();
                  }}
                >
                  {analyticsCopy.retry}
                </Button>
              </div>
            )}
            {onboarding && (
              <SettingsRow
                label={onboardingCopy.settingsTitle}
                description={user ? onboardingCopy.settingsDescription : onboardingCopy.unavailable}
              >
                <Button
                  variant="default"
                  loading={onboarding.isSaving}
                  disabled={
                    !user || !onboarding.isAvailable || !onboarding.progress || onboarding.isLoading
                  }
                  onClick={() => {
                    void onboarding.restart().then((didRestart) => {
                      if (didRestart) {
                        onClose();
                      }
                    });
                  }}
                >
                  {onboardingCopy.restart}
                </Button>
              </SettingsRow>
            )}
            {onboarding?.hasError && (
              <div role="alert">
                <Text size="sm">{onboardingCopy.error}</Text>
                <Button
                  variant="subtle"
                  loading={onboarding.isLoading}
                  disabled={onboarding.isSaving}
                  onClick={() => {
                    void onboarding.refresh();
                  }}
                >
                  {onboardingCopy.retry}
                </Button>
              </div>
            )}
            <SettingsRow label={messages.appearance} description={messages.appearanceDescription}>
              <Text size="sm">{messages.light}</Text>
            </SettingsRow>
          </div>
          {!isLocaleSaved && (
            <Text size="sm" role="status" mt="md">
              {messages.languageStorageWarning}
            </Text>
          )}
        </Tabs.Panel>
        <Tabs.Panel value={SettingsSection.PETS}>
          <PetGallery accountId={user?.id ?? null} />
        </Tabs.Panel>
        {user && !user.learner && (
          <Tabs.Panel value={SettingsSection.TEAM}>
            <TeamPanel
              key={user.id}
              accountId={user.id}
              onChanged={onTeamChanged}
              onCreateOrganization={onCreateOrganization}
              initialOrganizationId={teamOrganizationId ?? undefined}
            />
          </Tabs.Panel>
        )}
        <Tabs.Panel value={SettingsSection.ACCOUNT}>
          <Title order={3}>{messages.account}</Title>
          <div className="settings-rows">
            {user ? (
              <>
                <SettingsRow label={messages.name} description={user.name} />
                <SettingsRow
                  label={user.learner ? 'Student ID' : messages.email}
                  description={
                    <span className="account-email">{user.learner?.externalId ?? user.email}</span>
                  }
                />
                <Text size="sm" c="dimmed" className="settings-account-hint">
                  {messages.signOutHint}
                </Text>
              </>
            ) : (
              <Text size="sm" c="dimmed" className="settings-account-hint">
                {messages.accountSignInHint}
              </Text>
            )}
          </div>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
