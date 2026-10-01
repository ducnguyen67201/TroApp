import { readSocketText } from '../../../../transport/ReadSocketText.js';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  AudioFormat,
  type TranscriptionDelay,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { LiveTranscriber, LiveTranscription } from '../ports/LiveTranscriber.js';

const envelopeSchema = z.looseObject({ type: z.string() });
const committedSchema = z.looseObject({ item_id: z.string().min(1) });
const deltaSchema = z.looseObject({
  item_id: z.string().min(1),
  content_index: z.literal(0),
  delta: z.string().max(8000),
});
const completedSchema = z.looseObject({
  item_id: z.string().min(1),
  content_index: z.literal(0),
  transcript: z.string().max(8000),
});

export interface OpenAiTranscriptionSettings {
  apiKey: string;
  delay: TranscriptionDelay;
}

/** Only this adapter knows OpenAI's protocol. One connection and committed
 * item per capture; final text is correlated before it can leave the adapter. */
export class OpenAiLiveTranscriber implements LiveTranscriber {
  constructor(
    private readonly settings: OpenAiTranscriptionSettings,
    private readonly connect: (userId: string) => WebSocket = (userId) =>
      new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'OpenAI-Safety-Identifier': createHash('sha256').update(userId).digest('hex'),
        },
        maxPayload: 64_000,
        handshakeTimeout: 10_000,
      }),
  ) {}

  openTranscription(
    locale: DesktopLocale,
    userId: string,
    emit: (event: TranscriptionEvent) => void,
  ): LiveTranscription {
    const socket = this.connect(userId);
    let ready = false;
    let finished = false;
    let closed = false;
    let committedItem: string | null = null;
    const completions = new Map<string, string>();
    let preview = '';

    function closeCapture(): void {
      if (closed) {
        return;
      }
      closed = true;
      socket.close();
    }

    function failCapture(): void {
      if (!closed) {
        emit({ kind: TranscriptionEventKind.FAILED });
        closeCapture();
      }
    }

    function emitFinal(): void {
      if (!closed && finished && committedItem && completions.has(committedItem)) {
        emit({ kind: TranscriptionEventKind.FINAL, text: completions.get(committedItem) ?? '' });
        closeCapture();
      }
    }

    socket.on('open', () => {
      if (closed) {
        socket.close();
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: AudioFormat.SAMPLE_RATE },
                transcription: {
                  model: 'gpt-live-transcribe',
                  languages: [locale],
                  delay: this.settings.delay,
                },
                turn_detection: null,
              },
            },
          },
        }),
      );
    });
    socket.on('message', (data, binary) => {
      if (closed) {
        return;
      }
      try {
        if (binary) {
          failCapture();
          return;
        }
        const raw: unknown = JSON.parse(readSocketText(data));
        const envelope = envelopeSchema.parse(raw);
        switch (envelope.type) {
          case 'session.updated':
            if (!ready) {
              ready = true;
              emit({ kind: TranscriptionEventKind.READY });
            }
            break;
          case 'input_audio_buffer.committed':
            committedItem = committedSchema.parse(raw).item_id;
            emitFinal();
            break;
          case 'conversation.item.input_audio_transcription.delta': {
            const delta = deltaSchema.parse(raw);
            preview = (preview + delta.delta).slice(0, 8000);
            emit({ kind: TranscriptionEventKind.PREVIEW, text: preview });
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            const final = completedSchema.parse(raw);
            if (completions.size >= 4) {
              failCapture();
              return;
            }
            completions.set(final.item_id, final.transcript);
            emitFinal();
            break;
          }
          case 'error':
          case 'conversation.item.input_audio_transcription.failed':
            failCapture();
            break;
        }
      } catch {
        failCapture();
      }
    });
    socket.on('error', failCapture);
    socket.on('close', failCapture);

    return {
      appendAudio(pcm) {
        if (closed || !ready || finished || socket.bufferedAmount > AudioFormat.QUEUE_BYTES) {
          throw new Error('Transcription is unavailable.');
        }
        socket.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(pcm).toString('base64'),
          }),
        );
      },
      finishCapture() {
        if (closed || !ready || finished) {
          throw new Error('Transcription is unavailable.');
        }
        finished = true;
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      },
      cancelCapture: closeCapture,
    };
  }
}
