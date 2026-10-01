import { Button, Group, Paper, Text } from '@mantine/core';
import { useRef, type ReactElement } from 'react';
import { VoiceShortcut, VoiceState } from '#contracts/VoiceInput.js';
import { useLocale } from '../localization/UseLocale.js';
import type { VoiceInputView } from './UseVoiceInput.js';

/** A pointer or keyboard hold uses the same main-side capture lifecycle. */
export function VoiceInputPanel({
  voice,
  isBusy,
}: {
  voice: VoiceInputView;
  isBusy: boolean;
}): ReactElement {
  const { messages } = useLocale();
  const pointerHeld = useRef(false);
  const unavailable = voice.status.state === VoiceState.DISABLED;
  const shortcutLabel =
    voice.status.shortcut === VoiceShortcut.COMMAND_CONTROL
      ? 'Command + Control'
      : voice.status.shortcut === VoiceShortcut.CONTROL_ALT
        ? 'Control + Left Alt'
        : 'Control + Shift';
  const recording =
    voice.status.state === VoiceState.RECORDING || voice.status.state === VoiceState.PREPARING;
  const label = voice.isStarting
    ? messages.voiceStarting
    : unavailable
      ? messages.voiceUnavailable
      : voice.status.state === VoiceState.PREPARING
        ? messages.voicePreparing
        : voice.status.state === VoiceState.RECORDING
          ? messages.voiceRecording
          : voice.status.state === VoiceState.FINALIZING
            ? messages.voiceFinalizing
            : voice.status.state === VoiceState.RUNNING
              ? messages.working
              : messages.voiceReady;
  return (
    <Paper withBorder p="md" mb="md">
      <Group justify="space-between">
        <div>
          <Text role="status" size="sm">
            {label}
          </Text>
          <Text size="xs" c="dimmed">
            {shortcutLabel}
          </Text>
        </div>
        <Group>
          <Button
            variant="default"
            disabled={unavailable || voice.isStarting || (isBusy && !recording)}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              event.preventDefault();
              pointerHeld.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              voice.pressVoice();
            }}
            onPointerUp={() => {
              pointerHeld.current = false;
              voice.releaseVoice();
            }}
            onPointerCancel={() => {
              voice.cancelVoice();
            }}
            onLostPointerCapture={() => {
              if (pointerHeld.current) {
                pointerHeld.current = false;
                voice.cancelVoice();
              }
            }}
            onKeyDown={(event) => {
              if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                event.preventDefault();
                voice.pressVoice();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                voice.releaseVoice();
              }
            }}
            onBlur={() => {
              if (recording) {
                voice.cancelVoice();
              }
            }}
          >
            {messages.voiceTalk}
          </Button>
          {(recording || voice.status.state === VoiceState.FINALIZING) && (
            <Button
              variant="subtle"
              onClick={() => {
                voice.cancelVoice();
              }}
            >
              {messages.voiceCancel}
            </Button>
          )}
        </Group>
      </Group>
      <Text mt="sm" size="xs" c="dimmed">
        {messages.voiceDisclosure}
      </Text>
      {!voice.isStarting && !voice.status.globalShortcutAvailable && !unavailable && (
        <Text mt="sm" size="sm">
          {messages.voiceShortcutUnavailable}
        </Text>
      )}
      {!voice.isStarting && (unavailable || !voice.status.globalShortcutAvailable) && (
        <Button
          variant="subtle"
          mt="sm"
          disabled={isBusy || recording || voice.status.state === VoiceState.FINALIZING}
          onClick={() => {
            void voice.retryVoice();
          }}
        >
          {messages.voiceCheckAgain}
        </Button>
      )}
      {voice.preview && (
        <Text mt="sm" size="sm">
          {voice.preview}
        </Text>
      )}
      {voice.error && (
        <Text role="alert" mt="sm" size="sm">
          {messages.voiceError}
        </Text>
      )}
    </Paper>
  );
}
