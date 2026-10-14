import { Alert, Group, Text } from '@mantine/core';
import { IconMicrophone } from '@tabler/icons-react';
import { useId, type ReactElement } from 'react';
import { useLocale } from '../localization/UseLocale.js';
import { defaultMicrophoneId } from './Microphones.js';
import { MicrophoneTestPhase } from './MicrophoneMeasurements.js';
import type { MicrophoneView } from './UseMicrophones.js';
import type { MicrophoneTestsView } from './UseMicrophoneTests.js';
import type { MicrophonePreviewView } from './UseMicrophonePreview.js';

interface MicrophoneInputLevelProps {
  microphones: MicrophoneView;
  tests: MicrophoneTestsView;
  preview: MicrophonePreviewView;
  canPreview: boolean;
}

const inputLevelSegments = Array.from({ length: 24 }, (_, index) => index);
const minimumDisplayDb = -60;

/** The bar follows the current local preview or comparison without retaining audio. */
export function MicrophoneInputLevel({
  microphones,
  tests,
  preview,
  canPreview,
}: MicrophoneInputLevelProps): ReactElement {
  const { messages } = useLocale();
  const titleId = useId();
  const isTesting = tests.activeDeviceId !== null;
  const activeDeviceId = tests.activeDeviceId ?? preview.activeDeviceId;
  const deviceId = activeDeviceId ?? microphones.selectedDeviceId;
  const deviceIndex = microphones.microphones.findIndex(
    (microphone) => microphone.deviceId === deviceId,
  );
  const microphone = microphones.microphones[deviceIndex];
  const deviceName =
    deviceId === defaultMicrophoneId
      ? messages.microphoneAuto
      : microphone?.label ||
        (deviceIndex < 0
          ? messages.microphoneUnnamed
          : `${messages.microphoneUnnamed} ${String(deviceIndex + 1)}`);
  const isStarting = isTesting ? tests.phase === MicrophoneTestPhase.OPENING : preview.isStarting;
  const status = isStarting
    ? messages.microphoneTestOpening
    : activeDeviceId !== null
      ? messages.microphoneInputListening
      : messages.microphoneInputIdle;
  const inputLevelDb = isTesting
    ? tests.inputLevelDb
    : preview.activeDeviceId !== null
      ? preview.inputLevelDb
      : null;
  const inputLevelPercent =
    inputLevelDb === null
      ? 0
      : Math.round(
          ((Math.max(minimumDisplayDb, inputLevelDb) - minimumDisplayDb) / -minimumDisplayDb) * 100,
        );

  return (
    <section className="microphone-input-level" aria-labelledby={titleId}>
      <Group justify="space-between" gap="xs">
        <Group gap={8} wrap="nowrap">
          <IconMicrophone size={16} aria-hidden="true" />
          <Text size="sm" fw={600} id={titleId}>
            {messages.microphoneInputLevel}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" role="status" className="microphone-input-status">
          {status}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" className="microphone-input-device">
        {deviceName}
      </Text>
      <div
        className="microphone-input-meter"
        role="meter"
        aria-label={messages.microphoneInputLevel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={inputLevelPercent}
        aria-valuetext={
          inputLevelDb === null
            ? status
            : messages.microphoneInputLevelValue(Math.round(inputLevelDb))
        }
      >
        {inputLevelSegments.map((segment) => (
          <span
            key={segment}
            aria-hidden="true"
            data-lit={inputLevelPercent > (segment / inputLevelSegments.length) * 100}
          />
        ))}
      </div>
      <div className="microphone-input-scale" aria-hidden="true">
        <span>{messages.microphoneInputQuiet}</span>
        <span>{messages.microphoneInputLoud}</span>
      </div>
      {preview.hasError && !isTesting ? (
        <Alert role="alert" color="charcoal">
          {messages.microphoneInputError}
        </Alert>
      ) : (
        <Text size="xs" c="dimmed">
          {canPreview ? messages.microphoneInputHint : messages.microphoneInputPaused}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {messages.microphoneInputPrivacy}
      </Text>
    </section>
  );
}
