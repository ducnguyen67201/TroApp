import { useEffect, useRef, useState } from 'react';
import {
  VoiceState,
  VoiceShortcut,
  type VoiceEvent,
  type VoiceStatus,
  type VoiceAudioFrame,
} from '#contracts/VoiceInput.js';
import { useLocale } from '../localization/UseLocale.js';
import { VoiceAudioCapture } from './VoiceAudioCapture.js';

export interface VoiceInputView {
  status: VoiceStatus;
  preview: string;
  error: boolean;
  isStarting: boolean;
  retryVoice(): Promise<void>;
  pressVoice(): void;
  releaseVoice(): void;
  cancelVoice(): void;
}

interface CaptureQueue {
  id: string;
  audio: VoiceAudioCapture;
  ready: boolean;
  readySignal: Promise<void>;
  resolveReady: () => void;
  queue: VoiceAudioFrame[];
  nextSequence: number;
  draining: Promise<void>;
  pumping: boolean;
}

/** App-level subscription reads the existing locale hook at each preparation.
 * The capture snapshot and audio queue survive page navigation, not account changes. */
export function useVoiceInput(
  userId: string | null,
  receiveTaskEvent: (event: VoiceEvent) => void,
): VoiceInputView {
  const { locale } = useLocale();
  const latest = useRef({ locale, receiveTaskEvent });
  latest.current = { locale, receiveTaskEvent };
  const capture = useRef<CaptureQueue | null>(null);
  const generation = useRef(0);
  const [status, setStatus] = useState<VoiceStatus>({
    state: VoiceState.DISABLED,
    shortcut: VoiceShortcut.COMMAND_CONTROL,
    globalShortcutAvailable: false,
  });
  const [preview, setPreview] = useState('');
  const [error, setError] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    let active = true;
    const currentGeneration = ++generation.current;
    setIsStarting(Boolean(userId));
    setError(false);
    setPreview('');

    function isSubscribed(): boolean {
      return active;
    }

    function cancelAudio(): void {
      capture.current?.audio.dispose();
      capture.current?.resolveReady();
      capture.current = null;
    }

    function failCapture(): void {
      if (!active) {
        return;
      }
      cancelAudio();
      setError(true);
      void window.tro.controlVoiceInput({ kind: 'cancel' });
    }

    function drainFrames(current: CaptureQueue): void {
      if (current.pumping || !current.ready) {
        return;
      }
      current.pumping = true;
      current.draining = (async () => {
        while (capture.current === current && current.ready && current.queue.length > 0) {
          const frame = current.queue.shift();
          if (!frame) {
            return;
          }
          const reply = await window.tro.appendVoiceAudio(frame);
          if (reply.kind !== 'ok') {
            throw new Error('Voice is unavailable.');
          }
        }
      })()
        .catch(() => {
          if (capture.current === current) {
            failCapture();
          }
        })
        .finally(() => {
          current.pumping = false;
          if (capture.current === current && current.queue.length > 0) {
            drainFrames(current);
          }
        });
    }

    const unsubscribe = window.tro.subscribeVoiceInput((event) => {
      if (!active) {
        return;
      }
      latest.current.receiveTaskEvent(event);
      switch (event.kind) {
        case 'status':
          setStatus(event.status);
          break;
        case 'prepare': {
          cancelAudio();
          setError(false);
          setPreview('');
          const audio = new VoiceAudioCapture(
            (pcm) => {
              const current = capture.current;
              if (!current || current.id !== event.captureId) {
                return;
              }
              // Five seconds bounds cold-start audio; normal transport has one IPC in flight.
              if (current.queue.length >= 250) {
                failCapture();
                return;
              }
              current.queue.push({
                captureId: current.id,
                sequence: current.nextSequence,
                pcm: new Uint8Array(pcm),
              });
              current.nextSequence += 1;
              drainFrames(current);
            },
            () => {
              if (capture.current?.id === event.captureId) {
                failCapture();
              }
            },
          );
          let resolveReady: () => void = () => {};
          const readySignal = new Promise<void>((resolve) => {
            resolveReady = resolve;
          });
          const current: CaptureQueue = {
            id: event.captureId,
            audio,
            ready: false,
            readySignal,
            resolveReady,
            queue: [],
            nextSequence: 0,
            draining: Promise.resolve(),
            pumping: false,
          };
          capture.current = current;
          void audio.startCapture().catch(() => {
            if (capture.current === current) {
              failCapture();
            }
          });
          // Snapshot locale now. A change during this capture affects only the next capture.
          void window.tro
            .controlVoiceInput({
              kind: 'prepare',
              captureId: event.captureId,
              locale: latest.current.locale,
            })
            .then((reply) => {
              if (reply.kind !== 'ok' && capture.current === current) {
                failCapture();
              }
            });
          break;
        }
        case 'record': {
          const current = capture.current;
          if (current?.id === event.captureId) {
            current.ready = true;
            current.resolveReady();
            drainFrames(current);
          }
          break;
        }
        case 'release': {
          const current = capture.current;
          if (current?.id !== event.captureId) {
            break;
          }
          void (async () => {
            await current.audio.flushCapture();
            await current.readySignal;
            if (capture.current !== current) {
              return;
            }
            drainFrames(current);
            while (current.pumping || current.queue.length > 0) {
              await current.draining;
            }
            if (capture.current !== current) {
              return;
            }
            capture.current = null;
            const reply = await window.tro.controlVoiceInput({
              kind: 'finish',
              captureId: current.id,
              lastSequence: current.nextSequence - 1,
            });
            if (reply.kind !== 'ok' && isSubscribed()) {
              failCapture();
            }
          })().catch(() => {
            if (capture.current === current) {
              failCapture();
            }
          });
          break;
        }
        case 'cancel':
          if (capture.current?.id === event.captureId) {
            cancelAudio();
          }
          setPreview('');
          break;
        case 'preview':
          setPreview(event.text);
          break;
        case 'submitted':
          setPreview('');
          break;
        case 'failed':
          cancelAudio();
          setPreview('');
          setError(true);
          break;
      }
    });
    void window.tro
      .controlVoiceInput({ kind: 'status' })
      .then((reply) => {
        if (!active) {
          return;
        }
        if (reply.kind === 'ok') {
          setStatus(
            userId
              ? reply.status
              : {
                  ...reply.status,
                  state: VoiceState.DISABLED,
                  globalShortcutAvailable: false,
                },
          );
          if (userId && reply.status.state === VoiceState.DISABLED) {
            void startVoice(reply.status.shortcut, currentGeneration);
            return;
          }
        } else if (userId) {
          setError(true);
        }
        setIsStarting(false);
      })
      .catch(() => {
        if (active) {
          setError(Boolean(userId));
          setIsStarting(false);
        }
      });

    function cancelOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        cancelAudio();
        void window.tro.controlVoiceInput({ kind: 'cancel' });
      }
    }

    window.addEventListener('keydown', cancelOnEscape);
    return () => {
      active = false;
      generation.current += 1;
      unsubscribe();
      window.removeEventListener('keydown', cancelOnEscape);
      cancelAudio();
      void window.tro.controlVoiceInput({ kind: 'disable' });
    };
  }, [userId]);

  async function startVoice(shortcut: VoiceShortcut, currentGeneration: number): Promise<void> {
    setError(false);
    setIsStarting(true);
    try {
      const reply = await window.tro.controlVoiceInput({ kind: 'enable', shortcut });
      if (currentGeneration !== generation.current) {
        return;
      }
      if (reply.kind === 'ok') {
        setStatus(reply.status);
      } else {
        setError(true);
      }
    } catch {
      if (currentGeneration === generation.current) {
        setError(true);
      }
    } finally {
      if (currentGeneration === generation.current) {
        setIsStarting(false);
      }
    }
  }

  async function retryVoice(): Promise<void> {
    if (
      userId &&
      !isStarting &&
      (status.state === VoiceState.IDLE || status.state === VoiceState.DISABLED)
    ) {
      await startVoice(status.shortcut, generation.current);
    }
  }

  function pressVoice(): void {
    setError(false);
    void window.tro.controlVoiceInput({ kind: 'press' }).then((reply) => {
      if (reply.kind !== 'ok') {
        setError(true);
      }
    });
  }

  function releaseVoice(): void {
    void window.tro.controlVoiceInput({ kind: 'release' });
  }

  function cancelVoice(): void {
    capture.current?.audio.dispose();
    capture.current?.resolveReady();
    capture.current = null;
    void window.tro.controlVoiceInput({ kind: 'cancel' });
  }

  return {
    status,
    preview,
    error,
    isStarting,
    retryVoice,
    pressVoice,
    releaseVoice,
    cancelVoice,
  };
}
