import { readSocketText } from '../../../../transport/ReadSocketText.js';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import {
  AudioFormat,
  TranscriptionCommandSchema,
  TranscriptionCancelSchema,
  TranscriptionRequestSchema,
} from '#contracts/Transcription.js';
import { DesktopLocaleSchema } from '#contracts/DesktopLocale.js';
import type { TranscriptionAllowance } from '../ports/TranscriptionAllowance.js';
import type { LiveTranscriber } from '../ports/LiveTranscriber.js';
import { TranscriptionSession } from '../application/TranscriptionSession.js';

export interface TranscriptionRouteSettings {
  authSecret: string;
  dailySeconds: number;
  available: boolean;
}

const claimsSchema = z.looseObject({
  sub: z.string().min(1),
  jti: z.uuid(),
  locale: DesktopLocaleSchema,
  scope: z.literal('transcription'),
});

/** Separate signing key, scope and audience from model credentials. No bearer
 * token enters a URL or logs. Cookie auth is required again at socket admission. */
export async function registerTranscriptionRoutes(
  api: FastifyInstance,
  readUser: (headers: IncomingHttpHeaders) => Promise<string | null>,
  allowance: TranscriptionAllowance,
  provider: LiveTranscriber,
  settings: TranscriptionRouteSettings,
): Promise<void> {
  await api.register(websocket, { options: { maxPayload: 2048 } });
  const key = createHash('sha256').update(`tro-transcription-v1:${settings.authSecret}`).digest();
  const credentials = new WeakMap<object, z.infer<typeof claimsSchema>>();

  api.post('/api/v1/transcription/credential', { bodyLimit: 512 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const userId = await readUser(request.headers);
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in required.' });
    }
    if (!settings.available) {
      return reply.code(503).send({ error: 'Voice is unavailable.' });
    }
    const parsed = TranscriptionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid capture.' });
    }
    const expiresAt = new Date(Date.now() + 120_000);
    const reserved = await allowance.reserveTranscription({
      captureId: parsed.data.captureId,
      userId,
      expiresAt,
      maximumSamples: AudioFormat.MAX_SECONDS * AudioFormat.SAMPLE_RATE,
      dailySamples: settings.dailySeconds * AudioFormat.SAMPLE_RATE,
    });
    if (!reserved) {
      return reply.code(429).send({ error: 'Voice allowance or active capture limit reached.' });
    }
    const token = await new SignJWT({ scope: 'transcription', locale: parsed.data.locale })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('tro-api')
      .setAudience('tro-transcription')
      .setSubject(userId)
      .setJti(parsed.data.captureId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(key);
    return { token, expiresAt: expiresAt.toISOString() };
  });

  api.post('/api/v1/transcription/cancel', { bodyLimit: 128 }, async (request, reply) => {
    const userId = await readUser(request.headers);
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in required.' });
    }
    const parsed = TranscriptionCancelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid capture.' });
    }
    await allowance.releaseUnusedTranscription(parsed.data.captureId, userId);
    return reply.code(204).send();
  });

  api.get(
    '/api/v1/transcription/stream',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        try {
          const userId = await readUser(request.headers);
          const authorization = request.headers.authorization;
          if (!settings.available || !userId || !authorization?.startsWith('Bearer ')) {
            return await reply.code(401).send({ error: 'Sign in required.' });
          }
          const verified = await jwtVerify(authorization.slice(7), key, {
            algorithms: ['HS256'],
            issuer: 'tro-api',
            audience: 'tro-transcription',
          });
          const claims = claimsSchema.parse(verified.payload);
          if (claims.sub !== userId) {
            return await reply.code(401).send({ error: 'Invalid credential.' });
          }
          credentials.set(request, claims);
        } catch {
          return await reply.code(401).send({ error: 'Invalid credential.' });
        }
      },
    },
    (socket, request) => {
      const claims = credentials.get(request);
      if (!claims) {
        socket.close();
        return;
      }
      const capture = new TranscriptionSession(
        claims.jti,
        claims.sub,
        claims.locale,
        allowance,
        provider,
        (event) => {
          if (
            socket.readyState === socket.OPEN &&
            socket.bufferedAmount <= AudioFormat.QUEUE_BYTES
          ) {
            socket.send(JSON.stringify(event));
          } else {
            socket.close();
          }
        },
        () => {
          socket.close();
        },
      );
      socket.on('message', (data, binary) => {
        try {
          if (binary) {
            capture.failCapture();
            return;
          }
          const raw: unknown = JSON.parse(readSocketText(data));
          const parsed = TranscriptionCommandSchema.safeParse(raw);
          if (!parsed.success) {
            capture.failCapture();
            return;
          }
          capture.receiveCommand(parsed.data);
        } catch {
          capture.failCapture();
        }
      });
      socket.on('error', () => {
        capture.cancelCapture();
      });
      socket.on('close', () => {
        capture.cancelCapture();
      });
      void capture.openTranscription();
    },
  );
}
