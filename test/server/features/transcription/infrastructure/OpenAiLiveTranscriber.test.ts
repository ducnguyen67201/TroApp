import { readSocketText } from '../../../../../src/transport/ReadSocketText.js';
import WebSocket, { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TranscriptionDelay,
  TranscriptionDelaySchema,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';
import { OpenAiLiveTranscriber } from '../../../../../src/server/features/transcription/infrastructure/OpenAiLiveTranscriber.js';

const updateSchema = z.looseObject({
  session: z.looseObject({
    type: z.literal('transcription'),
    audio: z.looseObject({
      input: z.looseObject({
        transcription: z.looseObject({
          model: z.literal('gpt-live-transcribe'),
          languages: z.array(z.string()),
          delay: TranscriptionDelaySchema,
        }),
        turn_detection: z.null(),
      }),
    }),
  }),
});

describe('OpenAI transcription adapter against a local socket', () => {
  it.each(['en', 'vi'] as const)(
    'configures %s and correlates finals with the committed item',
    async (locale) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        throw new Error('No test port.');
      }
      const connected = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
      const events: TranscriptionEvent[] = [];
      const adapter = new OpenAiLiveTranscriber(
        { apiKey: 'synthetic', delay: TranscriptionDelay.LOW },
        () => new WebSocket(`ws://127.0.0.1:${String(address.port)}`),
      );
      const capture = adapter.openTranscription(locale, 'test-user', (event) => {
        events.push(event);
      });
      const socket = await connected;
      const messages: unknown[] = [];
      socket.on('message', (data) => {
        const raw: unknown = JSON.parse(readSocketText(data));
        messages.push(raw);
      });
      try {
        await vi.waitFor(() => {
          expect(messages).toHaveLength(1);
        });
        const update = updateSchema.parse(messages[0]);
        expect(update.session.audio.input.transcription.languages).toEqual([locale]);
        expect(update.session.audio.input.transcription.delay).toBe('low');
        socket.send(JSON.stringify({ type: 'session.updated' }));
        await vi.waitFor(() => {
          expect(events).toContainEqual({ kind: TranscriptionEventKind.READY });
        });
        capture.appendAudio(new Uint8Array(960));
        capture.finishCapture();
        await vi.waitFor(() => {
          expect(messages).toHaveLength(3);
        });
        expect(messages[1]).toMatchObject({ type: 'input_audio_buffer.append' });
        expect(messages[2]).toMatchObject({ type: 'input_audio_buffer.commit' });
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'foreign',
            content_index: 0,
            transcript: 'Wrong turn',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'current',
            content_index: 0,
            transcript: 'Mở Chrome',
          }),
        );
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'current' }));
        await vi.waitFor(() => {
          expect(events.filter((event) => event.kind === TranscriptionEventKind.FINAL)).toEqual([
            { kind: TranscriptionEventKind.FINAL, text: 'Mở Chrome' },
          ]);
        });
      } finally {
        capture.cancelCapture();
        socket.terminate();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    },
  );
});
