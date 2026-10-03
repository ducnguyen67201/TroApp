import { Readable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { VoiceoverLimits, VoiceoverRequestSchema } from '#contracts/Voiceover.js';
import type { SpeechProvider, VoiceoverAllowance } from './VoiceoverPorts.js';

/** Auth and atomic allowance precede paid dispatch. HTTP disconnect aborts upstream. */
export function registerVoiceoverRoutes(
  api: FastifyInstance,
  readUser: (headers: IncomingHttpHeaders) => Promise<string | null>,
  allowance: VoiceoverAllowance,
  provider: SpeechProvider,
): void {
  api.post('/api/v1/voiceover/stream', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const userId = await readUser(request.headers);
    if (!userId) {
      return reply.code(401).send({ error: 'Sign in required.' });
    }
    const parsed = VoiceoverRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid speech request.' });
    }
    if (!provider.isAvailable()) {
      return reply.code(503).send({ error: 'Speech is unavailable.' });
    }
    const speech = parsed.data;
    if (
      !(await allowance.reserveVoiceover(userId, speech.utteranceId, speech.message.text.length))
    ) {
      return reply
        .code(429)
        .send({ error: 'Speech allowance, active stream or duplicate request limit reached.' });
    }
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort();
    }, VoiceoverLimits.MAX_DURATION_MS);
    const disconnect = (): void => {
      abort.abort();
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    if (request.raw.socket.destroyed || reply.raw.destroyed) {
      abort.abort();
    }
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      request.raw.removeListener('aborted', disconnect);
      reply.raw.removeListener('close', disconnect);
      await allowance.finishVoiceover(userId, speech.utteranceId);
    };
    const startedAt = performance.now();
    try {
      abort.signal.throwIfAborted();
      const upstream = await provider.streamSpeech(speech, abort.signal);
      const reader = upstream.getReader();

      async function* readAudio(): AsyncGenerator<Uint8Array> {
        let bytes = 0;
        try {
          for (;;) {
            abort.signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            bytes += chunk.value.length;
            if (bytes > VoiceoverLimits.MAX_BYTES) {
              throw new Error('Speech response too large.');
            }
            yield chunk.value;
          }
          if (bytes === 0 || bytes % 2 !== 0) {
            throw new Error('Invalid speech audio.');
          }
        } finally {
          abort.abort();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          await finish();
        }
      }

      const stream = Readable.from(readAudio());
      stream.once('error', () => {
        api.log.warn(
          {
            utteranceId: speech.utteranceId,
            stage: 'stream',
            elapsedMs: performance.now() - startedAt,
          },
          'voiceover.failed',
        );
      });
      reply.header('X-Tro-Audio-Format', 'pcm_s16le_24000_mono');
      return await reply.type('application/octet-stream').send(stream);
    } catch {
      abort.abort();
      await finish();
      api.log.warn(
        {
          utteranceId: speech.utteranceId,
          stage: 'generation',
          elapsedMs: performance.now() - startedAt,
        },
        'voiceover.failed',
      );
      return reply.code(502).send({ error: 'Speech generation failed.' });
    }
  });
}
