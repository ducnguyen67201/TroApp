import { readSocketText } from '../../../transport/ReadSocketText.js';
import WebSocket from 'ws';
import {
  AudioFormat,
  TranscriptionEventSchema,
  type TranscriptionCommand,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';

export interface TranscriptionConnection {
  sendCommand(command: TranscriptionCommand): void;
  close(): void;
}

/** The credential and cookie stay in main. Backpressure aborts instead of
 * dropping audio or accumulating an unbounded queue. */
export function openTranscriptionConnection(
  apiBaseUrl: string,
  token: string,
  cookie: string,
  emit: (event: TranscriptionEvent) => void,
): TranscriptionConnection {
  const url = new URL(`${apiBaseUrl}/api/v1/transcription/stream`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, cookie },
    maxPayload: 64_000,
    handshakeTimeout: 10_000,
  });
  let closed = false;

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    socket.close();
  }

  function fail(): void {
    if (!closed) {
      emit({ kind: TranscriptionEventKind.FAILED });
      close();
    }
  }

  socket.on('message', (data, binary) => {
    if (closed) {
      return;
    }
    try {
      if (binary) {
        fail();
        return;
      }
      const raw: unknown = JSON.parse(readSocketText(data));
      const event = TranscriptionEventSchema.parse(raw);
      emit(event);
    } catch {
      fail();
    }
  });
  socket.on('error', fail);
  socket.on('close', fail);

  return {
    sendCommand(command) {
      if (
        closed ||
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > AudioFormat.QUEUE_BYTES
      ) {
        throw new Error('Voice stream is unavailable.');
      }
      socket.send(JSON.stringify(command));
    },
    close,
  };
}
