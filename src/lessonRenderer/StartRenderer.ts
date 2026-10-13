import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LessonRenderRequestSchema,
  lessonRenderVersion,
  lessonVisualRuntimeVersion,
} from '../contracts/LessonRenderProtocol.js';
import { LessonLimits } from '../contracts/LessonVideos.js';
import { readRendererEnv } from './Env.js';
import { renderLessonClip } from './RenderLessonClip.js';
import { combineLessonClips } from './CombineLessonClips.js';
import { renderLessonVisualFrames } from './RenderLessonVisualFrames.js';
import { LessonVisualCodeError } from './CompileLessonVisual.js';

async function startRenderer(): Promise<void> {
  const environment = readRendererEnv(process.env);
  const app = Fastify({
    bodyLimit: Math.ceil((LessonLimits.VIDEO_BYTES * 4) / 3) + 32768,
    requestTimeout: 190000,
    logger: false,
  });
  const buildId = (
    await readFile(join(environment.LESSON_RENDER_BUNDLE, 'BuildId.txt'), 'utf8')
  ).trim();
  let busy = false;
  const shutdown = new AbortController();
  app.addHook('onRequest', async (request, reply) => {
    const token = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${environment.LESSON_RENDER_SECRET}`);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.get('/health', () =>
    Promise.resolve({
      version: lessonRenderVersion,
      buildId,
      visualRuntimeVersion: lessonVisualRuntimeVersion,
    }),
  );
  app.post('/render', async (request, reply) => {
    const parsed = LessonRenderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: 'invalid' });
    }
    if (busy) {
      return await reply.code(503).send({ kind: 'unavailable', code: 'busy' });
    }
    busy = true;
    let directory: string | null = null;
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(180000)]);
    try {
      directory = await mkdtemp(join(tmpdir(), 'tro-lesson-'));
      const input = parsed.data;
      const output = join(directory, 'Video.mp4');
      if (input.kind === 'clip') {
        if (input.audio && Buffer.byteLength(input.audio, 'base64') > LessonLimits.SCREEN_BYTES) {
          return await reply.code(413).send({ error: 'audio-too-large' });
        }
        const visualFrames = input.visual
          ? await renderLessonVisualFrames(
              input.visual,
              input.screen,
              input.durationSeconds,
              signal,
            )
          : undefined;
        await renderLessonClip(
          resolve(environment.LESSON_RENDER_BUNDLE),
          output,
          {
            screen: input.screen,
            durationSeconds: input.durationSeconds,
            audioUrl: input.audio ? `data:audio/wav;base64,${input.audio}` : null,
            ...(visualFrames ? { visualFrames } : {}),
          },
          signal,
          environment.CHROME_PATH,
        );
      } else {
        for (const [index, clip] of input.clips.entries()) {
          await writeFile(join(directory, `Clip${String(index)}.mp4`), Buffer.from(clip, 'base64'));
        }
        await combineLessonClips(directory, input.clips.length, output, signal);
      }
      const ceiling = input.kind === 'clip' ? LessonLimits.SCREEN_BYTES : LessonLimits.VIDEO_BYTES;
      if ((await stat(output)).size > ceiling) {
        return await reply.code(413).send({ error: 'video-too-large' });
      }
      return { video: (await readFile(output)).toString('base64') };
    } catch (error) {
      if (error instanceof LessonVisualCodeError) {
        return await reply.code(422).send(error.failure);
      }
      return await reply.code(500).send({ kind: 'unavailable', code: 'render-failed' });
    } finally {
      busy = false;
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await app.listen({ host: environment.HOST, port: environment.PORT });
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      shutdown.abort();
      void app.close();
    });
  }
  console.info('Lesson renderer listening.');
}

void startRenderer().catch(() => {
  console.error('Lesson renderer could not start. Check configuration and bundle.');
  process.exitCode = 1;
});
