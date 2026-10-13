import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { GaxiosError } from 'gaxios';
import {
  lessonRenderVersion,
  lessonVisualRuntimeVersion,
  type LessonRenderRequest,
} from '../../../../src/contracts/LessonRenderProtocol.js';
import { LessonLayout } from '../../../../src/contracts/LessonVideos.js';
import { LessonRenderCodeError } from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';
import { HttpLessonRenderer } from '../../../../src/server/features/lessonVideos/infrastructure/HttpLessonRenderer.js';

let server: Server | null = null;

afterEach(async () => {
  const active = server;
  server = null;
  if (active) {
    await new Promise<void>((resolve, reject) => {
      active.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});

const request: LessonRenderRequest = {
  kind: 'clip',
  version: lessonRenderVersion,
  screen: {
    layout: LessonLayout.EXAMPLE,
    title: 'Example',
    points: ['A point'],
    narration: 'Explanation',
  },
  audio: null,
  durationSeconds: 1,
};

async function createRenderer(
  readResponse: () => { status: number; body: unknown },
): Promise<HttpLessonRenderer> {
  server = createServer((_request, reply) => {
    const response = readResponse();
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response.body));
  });
  const active = server;
  await new Promise<void>((resolve, reject) => {
    active.once('error', reject);
    active.listen(0, '127.0.0.1', resolve);
  });
  const address = active.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not listen.');
  }
  return new HttpLessonRenderer(
    `http://127.0.0.1:${String(address.port)}`,
    'fixture-renderer-secret',
  );
}

it('negotiates the known isolated runtime and preserves old worker compatibility', async () => {
  const responses: unknown[] = [
    { version: lessonRenderVersion, buildId: 'old' },
    {
      version: lessonRenderVersion,
      buildId: 'new',
      visualRuntimeVersion: lessonVisualRuntimeVersion,
    },
    { version: lessonRenderVersion, buildId: 'new' },
  ];
  const renderer = await createRenderer(() => ({ status: 200, body: responses.shift() }));
  expect(await renderer.readVisualRuntime()).toBeNull();
  expect(await renderer.readVisualRuntime()).toBe(lessonVisualRuntimeVersion);
  expect(await renderer.readBuildId()).toBe('new');
});

it('converts validated worker code failures without transport retry', async () => {
  let dispatches = 0;
  const renderer = await createRenderer(() => {
    dispatches += 1;
    return {
      status: 422,
      body: {
        kind: 'code-error',
        code: 'compile',
        diagnostic: 'Export a default Scene component.',
      },
    };
  });
  await expect(
    renderer.render(request, 1000, new AbortController().signal, 2),
  ).rejects.toBeInstanceOf(LessonRenderCodeError);
  expect(dispatches).toBe(1);
});

it('preserves infrastructure responses instead of asking AI to rewrite', async () => {
  const renderer = await createRenderer(() => ({
    status: 503,
    body: { kind: 'unavailable', code: 'busy' },
  }));
  await expect(
    renderer.render(request, 1000, new AbortController().signal, 1),
  ).rejects.toBeInstanceOf(GaxiosError);
});

it('preserves malformed code failures instead of treating unknown output as a repair diagnostic', async () => {
  const renderer = await createRenderer(() => ({
    status: 422,
    body: { kind: 'code-error', code: 'unknown', diagnostic: 'invalid' },
  }));
  await expect(
    renderer.render(request, 1000, new AbortController().signal, 1),
  ).rejects.toBeInstanceOf(GaxiosError);
});
