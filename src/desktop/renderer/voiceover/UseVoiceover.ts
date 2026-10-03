import { useEffect, useState } from 'react';
import { VoiceoverState, type VoiceoverStatus } from '#contracts/Voiceover.js';
import { useLocale } from '../localization/UseLocale.js';
import { VoiceoverPlayback } from './VoiceoverPlayback.js';

export interface VoiceoverView {
  enabled: boolean;
  status: VoiceoverStatus;
  changeEnabled(enabled: boolean): void;
  stopSpeaking(): void;
}

const preferenceKey = 'tro.desktop.voiceover';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(preferenceKey) !== 'false';
  } catch {
    return true;
  }
}

/** One app-level playback subscriber; rerenders never generate speech. */
export function useVoiceover(userId: string | null): VoiceoverView {
  const [enabled, setEnabled] = useState(readEnabled);
  const [status, setStatus] = useState<VoiceoverStatus>({ state: VoiceoverState.IDLE });
  const { locale } = useLocale();
  useEffect(() => {
    if (!userId || !window.tro.subscribeVoiceover || !window.tro.acknowledgeVoiceover) {
      return;
    }
    const playback = new VoiceoverPlayback();
    let active = true;
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.repeat) {
        void window.tro.cancelGuidance?.();
      }
    };
    window.addEventListener('keydown', cancelOnEscape);
    const unsubscribe = window.tro.subscribeVoiceover((event) => {
      if ('state' in event) {
        setStatus(event);
        return;
      }
      void playback
        .receiveCommand(event)
        .catch(async () => {
          await playback.stop().catch(() => {});
          return false;
        })
        .then((accepted) => {
          if (active) {
            void window.tro.acknowledgeVoiceover?.({
              utteranceId: event.utteranceId,
              sequence: event.sequence,
              accepted,
            });
          }
        });
    });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('keydown', cancelOnEscape);
      void playback.stop().catch(() => {});
    };
  }, [userId]);
  useEffect(() => {
    void window.tro.setVoiceoverEnabled?.(Boolean(userId) && enabled, locale);
    void window.tro.stopSpeaking?.();
  }, [enabled, userId, locale]);

  return {
    enabled,
    status,
    changeEnabled(value) {
      setEnabled(value);
      try {
        localStorage.setItem(preferenceKey, String(value));
      } catch {
        /* Session preference still applies. */
      }
    },
    stopSpeaking() {
      void window.tro.stopSpeaking?.();
    },
  };
}
