import { VoiceState } from '#contracts/VoiceInput.js';
import { Group, Stack, Text } from '@mantine/core';
import { IconMicrophone } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { useLocale } from '../localization/UseLocale.js';
import type { VoiceInputView } from './UseVoiceInput.js';
import { VoiceShortcutLabel } from './VoiceShortcutLabel.js';

export type ConversationVoiceView = Pick<
  VoiceInputView,
  'status' | 'preview' | 'error' | 'isStarting'
>;

interface ConversationVoiceStatusProps {
  voice: ConversationVoiceView;
  isBusy: boolean;
}

/** Presents the app-owned voice state without subscribing, capturing audio or sending commands. */
export function ConversationVoiceStatus({
  voice,
  isBusy,
}: ConversationVoiceStatusProps): ReactElement {
  const { messages } = useLocale();
  const { state, shortcut, globalShortcutAvailable } = voice.status;
  const labels = {
    [VoiceState.DISABLED]: messages.conversationVoiceUnavailable,
    [VoiceState.IDLE]: isBusy ? messages.conversationWorking : messages.conversationVoiceReady,
    [VoiceState.PREPARING]: messages.conversationVoicePreparing,
    [VoiceState.RECORDING]: messages.conversationVoiceListening,
    [VoiceState.FINALIZING]: messages.conversationVoiceFinalizing,
    [VoiceState.RUNNING]: messages.conversationWorking,
  };
  const isCapturing = state === VoiceState.PREPARING || state === VoiceState.RECORDING;
  const canShowPreview =
    !voice.error && !voice.isStarting && (isCapturing || state === VoiceState.FINALIZING);
  const isAvailable = state !== VoiceState.DISABLED && globalShortcutAvailable;
  const hint = isCapturing
    ? messages.conversationVoiceRelease
    : state === VoiceState.FINALIZING
      ? messages.conversationVoiceStopped
      : state === VoiceState.IDLE && isAvailable && !isBusy
        ? messages.conversationVoiceHold(VoiceShortcutLabel[shortcut])
        : null;

  return (
    <Stack
      gap="sm"
      className="conversation-voice"
      data-state={state}
      data-error={voice.error || undefined}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconMicrophone size={19} aria-hidden="true" />
        <div role="status" aria-live="polite">
          <Text size="sm" fw={600}>
            {voice.error
              ? messages.conversationVoiceError
              : voice.isStarting
                ? messages.conversationVoicePreparing
                : !isAvailable && state === VoiceState.IDLE && !isBusy
                  ? messages.conversationVoiceUnavailable
                  : labels[state]}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            {voice.error
              ? messages.conversationVoiceCheck
              : voice.isStarting
                ? messages.conversationVoicePreparingHint
                : !isAvailable &&
                    (state === VoiceState.DISABLED || state === VoiceState.IDLE) &&
                    !isBusy
                  ? messages.settingsShortcutUnavailable
                  : hint}
          </Text>
        </div>
      </Group>
      {canShowPreview && voice.preview && (
        <div className="conversation-transcript">
          <Text size="xs" c="dimmed" mb={4}>
            {messages.conversationVoicePreview}
          </Text>
          <Text size="sm" className="message-text">
            {voice.preview}
          </Text>
        </div>
      )}
    </Stack>
  );
}
