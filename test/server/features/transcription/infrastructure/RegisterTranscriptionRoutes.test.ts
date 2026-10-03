import { readSocketText } from '../../../../../src/transport/ReadSocketText.js';
import { randomUUID, createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  TranscriptionCredentialSchema,
  TranscriptionEventSchema,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';
import type { TranscriptionAllowance } from '../../../../../src/server/features/transcription/ports/TranscriptionAllowance.js';
import type { LiveTranscriber } from '../../../../../src/server/features/transcription/ports/LiveTranscriber.js';
import { registerTranscriptionRoutes } from '../../../../../src/server/features/transcription/infrastructure/RegisterTranscriptionRoutes.js';

const authSecret = 'synthetic-secret-at-least-thirty-two-characters';

async function createHarness() {
  const api = Fastify();
  const readUser = vi
    .fn<(headers: IncomingHttpHeaders) => Promise<string | null>>()
    .mockImplementation((headers) =>
      Promise.resolve(headers.cookie === 'test=session' ? 'user' : null),
    );
  const allowance = {
    releaseUnusedTranscription: vi
      .fn<TranscriptionAllowance['releaseUnusedTranscription']>()
      .mockResolvedValue(),
    reserveTranscription: vi
      .fn<TranscriptionAllowance['reserveTranscription']>()
      .mockResolvedValue(true),
    claimTranscription: vi
      .fn<TranscriptionAllowance['claimTranscription']>()
      .mockResolvedValue(true),
    settleTranscription: vi.fn<TranscriptionAllowance['settleTranscription']>().mockResolvedValue(),
  } satisfies TranscriptionAllowance;
  const provider = {
    openTranscription: vi
      .fn<LiveTranscriber['openTranscription']>()
      .mockImplementation((_locale, _user, emit) => {
        queueMicrotask(() => {
          emit({ kind: TranscriptionEventKind.READY });
        });
        return {
          appendAudio: () => {},
          finishCapture: () => {
            emit({ kind: TranscriptionEventKind.FINAL, text: 'Open Chrome' });
          },
          cancelCapture: () => {},
        };
      }),
  } satisfies LiveTranscriber;
  await registerTranscriptionRoutes(api, readUser, allowance, provider, {
    authSecret,
    available: true,
    dailySeconds: 3600,
  });
  return { api, readUser, allowance, provider };
}

describe('authenticated transcription relay', () => {
  it('rejects unsigned requests, invalid locale, exhaustion, and model-scope credentials', async () => {
    const { api, allowance, provider } = await createHarness();
    try {
      const request = {
        method: 'POST' as const,
        url: '/api/v1/transcription/credential',
        payload: { captureId: randomUUID(), locale: 'vi' },
      };
      expect((await api.inject(request)).statusCode).toBe(401);
      const invalid = await api.inject({
        ...request,
        headers: { cookie: 'test=session' },
        payload: { ...request.payload, locale: 'de' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(allowance.reserveTranscription).not.toHaveBeenCalled();
      allowance.reserveTranscription.mockResolvedValue(false);
      expect(
        (await api.inject({ ...request, headers: { cookie: 'test=session' } })).statusCode,
      ).toBe(429);
      const key = createHash('sha256').update(`tro-model-gateway-v1:${authSecret}`).digest();
      const token = await new SignJWT({ scope: 'model' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('tro-api')
        .setAudience('tro-model')
        .setSubject('user')
        .setExpirationTime('1m')
        .sign(key);
      await expect(
        api.injectWS('/api/v1/transcription/stream', {
          headers: { cookie: 'test=session', authorization: `Bearer ${token}` },
        }),
      ).rejects.toThrow();
      expect(provider.openTranscription).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

  it('passes the validated locale and ordered audio through the authenticated socket', async () => {
    const { api, allowance, provider } = await createHarness();
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/transcription/credential',
        headers: { cookie: 'test=session' },
        payload: { captureId: randomUUID(), locale: 'vi' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      const raw: unknown = response.json();
      const credential = TranscriptionCredentialSchema.parse(raw);
      const events: TranscriptionEvent[] = [];
      const socket = await api.injectWS(
        '/api/v1/transcription/stream',
        { headers: { cookie: 'test=session', authorization: `Bearer ${credential.token}` } },
        {
          onInit: (client) => {
            client.on('message', (data) => {
              const event: unknown = JSON.parse(readSocketText(data));
              events.push(TranscriptionEventSchema.parse(event));
            });
          },
        },
      );
      await vi.waitFor(() => {
        expect(events).toContainEqual({ kind: TranscriptionEventKind.READY });
      });
      for (let sequence = 0; sequence < 6; sequence += 1) {
        socket.send(
          JSON.stringify({ kind: 'audio', sequence, audio: Buffer.alloc(960).toString('base64') }),
        );
      }
      socket.send(JSON.stringify({ kind: 'finish', lastSequence: 5 }));
      await vi.waitFor(() => {
        expect(events).toContainEqual({ kind: TranscriptionEventKind.FINAL, text: 'Open Chrome' });
      });
      expect(provider.openTranscription).toHaveBeenCalledWith('vi', 'user', expect.any(Function));
      expect(allowance.settleTranscription).toHaveBeenCalledTimes(1);
      socket.terminate();
    } finally {
      await api.close();
    }
  });
});

it('requires account ownership to cancel an unused credential', async () => {
  const { api, allowance } = await createHarness();
  const captureId = randomUUID();
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/transcription/cancel',
      payload: { captureId },
    };
    expect((await api.inject(request)).statusCode).toBe(401);
    expect(allowance.releaseUnusedTranscription).not.toHaveBeenCalled();
    expect((await api.inject({ ...request, headers: { cookie: 'test=session' } })).statusCode).toBe(
      204,
    );
    expect(allowance.releaseUnusedTranscription).toHaveBeenCalledExactlyOnceWith(captureId, 'user');
  } finally {
    await api.close();
  }
});
