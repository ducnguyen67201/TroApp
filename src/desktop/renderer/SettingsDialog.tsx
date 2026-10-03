import { Badge, Button, Modal, NativeSelect, Switch, Tabs, Text, Title } from '@mantine/core';
import type { VoiceoverView } from './voiceover/UseVoiceover.js';
import { VoiceoverState } from '#contracts/Voiceover.js';
import { IconSettings, IconUser } from '@tabler/icons-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { VoiceShortcut, type VoiceStatus } from '#contracts/VoiceInput.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import { desktopLocales } from './localization/Locale.js';
import { useLocale } from './localization/UseLocale.js';
import { defaultMicrophoneId } from './voice/Microphones.js';
import type { MicrophoneView } from './voice/UseMicrophones.js';

const SettingsSection = { GENERAL: 'general', ACCOUNT: 'account' } as const;

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
}: SettingsDialogProps): ReactElement {
  const { locale, messages, changeLocale, isLocaleSaved } = useLocale();
  const languageDescriptionId = useId();
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
        defaultValue={SettingsSection.GENERAL}
        orientation="vertical"
        variant="pills"
        keepMounted={false}
        classNames={{
          root: 'settings-layout',
          list: 'settings-navigation',
          tab: 'settings-tab',
          panel: 'settings-panel',
        }}
      >
        <Tabs.List aria-label={messages.settingsNavigation}>
          <Tabs.Tab
            value={SettingsSection.GENERAL}
            leftSection={<IconSettings size={18} stroke={1.6} />}
          >
            {messages.settingsGeneral}
          </Tabs.Tab>
          <Tabs.Tab
            value={SettingsSection.ACCOUNT}
            leftSection={<IconUser size={18} stroke={1.6} />}
          >
            {messages.account}
          </Tabs.Tab>
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
                  variant="subtle"
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
        <Tabs.Panel value={SettingsSection.ACCOUNT}>
          <Title order={3}>{messages.account}</Title>
          <div className="settings-rows">
            {user ? (
              <>
                <SettingsRow label={messages.name} description={user.name} />
                <SettingsRow
                  label={messages.email}
                  description={<span className="account-email">{user.email}</span>}
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
