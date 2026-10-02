import { MicrophoneTools } from './MicrophoneTools.js';
import type { MicrophoneTestsView } from './UseMicrophoneTests.js';
import { Alert, Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useId, useState, type ReactElement } from 'react';
import { useLocale } from '../localization/UseLocale.js';
import { classifyMicrophone, defaultMicrophoneId, MicrophoneKind } from './Microphones.js';
import type { MicrophoneView } from './UseMicrophones.js';

interface MicrophonePickerProps {
  opened: boolean;
  tests: MicrophoneTestsView;
  canTest: boolean;
  onClose: () => void;
  microphones: MicrophoneView;
  isEnabled: boolean;
  hasVoiceError: boolean;
  isRetryingVoice: boolean;
  retryVoice: () => Promise<void>;
}

interface MicrophoneOptionProps {
  deviceId: string;
  title: string;
  description: string;
  detail?: string;
  warning?: string;
  isSelected: boolean;
  suggestion?: string;
  selectMicrophone: (deviceId: string) => void;
}

/** Keep the radio's name short while exposing routing hints as its description. */
function MicrophoneOption({
  deviceId,
  title,
  description,
  detail,
  warning,
  isSelected,
  suggestion,
  selectMicrophone,
}: MicrophoneOptionProps): ReactElement {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <label className="microphone-option" data-selected={isSelected}>
      <input
        type="radio"
        name="tro-microphone"
        value={deviceId}
        checked={isSelected}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onChange={() => {
          selectMicrophone(deviceId);
        }}
      />
      <span className="microphone-option-copy">
        <span className="microphone-option-heading">
          <Text component="span" size="sm" fw={600} id={titleId}>
            {title}
          </Text>
          {suggestion && (
            <Badge component="span" variant="light" size="sm">
              {suggestion}
            </Badge>
          )}
        </span>
        <span className="microphone-option-copy" id={descriptionId}>
          {detail && (
            <Text component="span" size="sm">
              {detail}
            </Text>
          )}
          <Text component="span" size="xs" c="dimmed">
            {description}
          </Text>
          {warning && (
            <Text component="span" size="xs" c="dimmed">
              {warning}
            </Text>
          )}
        </span>
      </span>
    </label>
  );
}

/** Opening the dialog enumerates only. Tests require an explicit button press. */
export function MicrophonePicker({
  opened,
  tests,
  canTest,
  onClose,
  microphones,
  isEnabled,
  hasVoiceError,
  isRetryingVoice,
  retryVoice,
}: MicrophonePickerProps): ReactElement {
  const { messages } = useLocale();
  const [isEditingRanking, setIsEditingRanking] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const descriptions = {
    [MicrophoneKind.WIRED]: messages.microphoneWiredHint,
    [MicrophoneKind.BUILT_IN]: messages.microphoneBuiltInHint,
    [MicrophoneKind.BLUETOOTH]: messages.microphoneBluetoothHint,
    [MicrophoneKind.VIRTUAL]: messages.microphoneVirtualHint,
    [MicrophoneKind.UNKNOWN]: messages.microphoneUnknownHint,
  } satisfies Record<MicrophoneKind, string>;
  const defaultKind = classifyMicrophone(microphones.defaultLabel);
  const defaultWarning =
    defaultKind === MicrophoneKind.BLUETOOTH || defaultKind === MicrophoneKind.VIRTUAL
      ? descriptions[defaultKind]
      : '';
  const needsMicrophonePermission =
    isEnabled &&
    microphones.hasLoaded &&
    !microphones.hasError &&
    (microphones.microphones.length === 0 ||
      microphones.microphones.some((microphone) => !microphone.label));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={messages.microphone}
      size={isComparing ? 'lg' : 'md'}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {messages.microphoneDescription}
        </Text>
        {!isEnabled && <Text size="sm">{messages.microphoneSignInHint}</Text>}
        {microphones.hasError && (
          <Alert role="alert" color="charcoal">
            {messages.microphoneListError}
          </Alert>
        )}
        {hasVoiceError && (
          <Alert role="alert" color="charcoal">
            <Stack gap="sm">
              <Text size="sm">{messages.microphoneVoiceError}</Text>
              <Button
                variant="default"
                disabled={!isEnabled || tests.activeDeviceId !== null}
                loading={isRetryingVoice}
                onClick={() => void retryVoice()}
              >
                {messages.microphoneRetryVoice}
              </Button>
            </Stack>
          </Alert>
        )}
        {microphones.isSelectedUnavailable && (
          <Alert role="alert" color="charcoal">
            {messages.microphoneUnavailable}
          </Alert>
        )}
        <fieldset
          className="microphone-options"
          disabled={!isEnabled || tests.activeDeviceId !== null}
        >
          <legend className="microphone-legend">
            {microphones.hasLoaded
              ? messages.microphoneInputCount(microphones.microphones.length)
              : messages.microphoneChoose}
          </legend>
          <MicrophoneOption
            deviceId={defaultMicrophoneId}
            title={messages.microphoneAuto}
            detail={microphones.defaultLabel}
            description={messages.microphoneAutoHint}
            warning={defaultWarning}
            isSelected={microphones.selectedDeviceId === defaultMicrophoneId}
            selectMicrophone={microphones.selectMicrophone}
          />
          {microphones.microphones.map((microphone, index) => (
            <MicrophoneOption
              key={microphone.deviceId}
              deviceId={microphone.deviceId}
              title={microphone.label || `${messages.microphoneUnnamed} ${String(index + 1)}`}
              description={descriptions[microphone.kind]}
              isSelected={microphones.selectedDeviceId === microphone.deviceId}
              suggestion={
                microphone.deviceId === microphones.recommendedDeviceId
                  ? microphones.hasCustomRanking
                    ? messages.microphonePreferred
                    : messages.microphoneSuggested
                  : ''
              }
              selectMicrophone={microphones.selectMicrophone}
            />
          ))}
        </fieldset>
        {needsMicrophonePermission && (
          <Text size="sm" c="dimmed">
            {messages.microphonePermissionHint}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {microphones.hasCustomRanking
            ? messages.microphoneRankingHint
            : messages.microphoneRecommendationHint}
        </Text>
        <Text size="xs" c="dimmed">
          {messages.microphoneNextHoldHint}
        </Text>
        {!microphones.isSaved && (
          <Text size="sm" role="status">
            {messages.microphoneStorageWarning}
          </Text>
        )}
        <Group>
          <Button
            variant="subtle"
            disabled={!isEnabled || tests.activeDeviceId !== null}
            aria-expanded={isEditingRanking}
            onClick={() => {
              setIsEditingRanking(!isEditingRanking);
            }}
          >
            {messages.microphoneEditRanking}
          </Button>
          <Button
            variant="subtle"
            disabled={!isEnabled}
            aria-expanded={isComparing}
            onClick={() => {
              tests.cancelTest();
              setIsComparing(!isComparing);
            }}
          >
            {messages.microphoneCompare}
          </Button>
        </Group>
        <MicrophoneTools
          microphones={microphones}
          tests={tests}
          canTest={canTest}
          isEditingRanking={isEditingRanking}
          isComparing={isComparing}
        />
        <Group justify="space-between">
          <Button
            variant="default"
            disabled={!isEnabled}
            loading={microphones.isLoading}
            onClick={() => void microphones.refreshMicrophones()}
          >
            {messages.microphoneRefresh}
          </Button>
          <Button onClick={onClose}>{messages.microphoneDone}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
