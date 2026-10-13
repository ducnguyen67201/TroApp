import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  LessonLayout,
  LessonVideoStatus,
  LessonCommand,
} from '../../../../src/contracts/LessonVideos.js';
import {
  LessonVisualStatus,
  LessonVisualTreatment,
} from '../../../../src/contracts/LessonVisuals.js';
import {
  LessonRenderCodeError,
  LessonVisualResultKind,
  type LessonVisualProvider,
} from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';
import { RunLessonVideoStage } from '../../../../src/server/features/lessonVideos/application/RunLessonVideoStage.js';
import { RunLessonVisual } from '../../../../src/server/features/lessonVideos/application/RunLessonVisual.js';
import { LessonVideoService } from '../../../../src/server/features/lessonVideos/application/LessonVideoService.js';
import { createLessonFixture, createLessonPorts } from './LessonVideoFixtures.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const signal = new AbortController().signal;

function createVisualStageFixture() {
  const lesson = createLessonFixture();
  const ports = createLessonPorts(lesson);
  ports.content.generate.mockResolvedValue({
    content: {
      title: 'Counting',
      screens: Array.from({ length: 3 }, () => ({
        layout: LessonLayout.EXAMPLE,
        title: 'Count even digits',
        points: ['2, 4 and 6 are even.'],
        narration: 'There are three even digits: two, four and six.',
      })),
    },
    briefs: [
      {
        position: 0,
        priority: 1,
        objective: 'Count choices',
        description: 'Reveal the three even digits.',
      },
    ],
    usage: { inputTokens: 1000, outputTokens: 500, cachedTokens: 0, requestId: 'content' },
  });
  const provider = {
    countRequest: vi.fn<LessonVisualProvider['countRequest']>().mockResolvedValue(300),
    generateVisual: vi.fn<LessonVisualProvider['generateVisual']>().mockResolvedValue({
      kind: LessonVisualResultKind.SOURCE,
      source: 'export default function Scene() { return <svg />; }',
      usage: { inputTokens: 300, outputTokens: 100, cachedTokens: 0, requestId: 'visual' },
    }),
  } satisfies LessonVisualProvider;
  const visuals = new RunLessonVisual(
    ports.store,
    provider,
    ports.renderer,
    randomUUID,
    hash,
    vi.fn(),
  );
  const stages = new RunLessonVideoStage(
    ports.store,
    ports.content,
    ports.speech,
    ports.renderer,
    randomUUID,
    vi.fn(),
    hash,
    visuals,
  );
  return { lesson, ports, provider, stages };
}

it('finishes a standard video after two failed custom executions without an AI repair loop', async () => {
  const fixture = createVisualStageFixture();
  let lesson = fixture.lesson;
  fixture.ports.renderer.render.mockImplementation((request) => {
    if (request.kind === 'clip' && request.visual) {
      return Promise.reject(new LessonRenderCodeError('Unsupported SVG attribute.'));
    }
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  });
  for (let step = 0; step < 25 && lesson.status === LessonVideoStatus.RUNNING; step += 1) {
    lesson = await fixture.stages.execute(lesson, signal);
  }
  expect(lesson.status).toBe(LessonVideoStatus.READY);
  expect(lesson.screens[0]?.visual).toMatchObject({
    treatment: LessonVisualTreatment.BASELINE,
    status: LessonVisualStatus.DEGRADED,
  });
  expect(lesson.screens[0]?.renderAttempts).toBe(3);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(2);
  expect(fixture.provider.generateVisual.mock.calls[1]?.[0]).toMatchObject({
    diagnostic: 'Unsupported SVG attribute.',
  });
  expect(fixture.provider.generateVisual.mock.calls[1]?.[0].source).toContain('export default');
  expect(fixture.ports.content.generate).toHaveBeenCalledTimes(1);
  expect(lesson.modelAttempts).toHaveLength(3);
  expect(lesson.inputTokens).toBe(1600);
  expect(lesson.videoId).not.toBeNull();
});

it('continues a worker outage using saved source and speech without spending another model slot', async () => {
  const fixture = createVisualStageFixture();
  let lesson = fixture.lesson;
  fixture.ports.renderer.render.mockRejectedValueOnce(new Error('worker disconnected'));
  for (let step = 0; step < 8 && lesson.status === LessonVideoStatus.RUNNING; step += 1) {
    lesson = await fixture.stages.execute(lesson, signal);
  }
  expect(lesson.status).toBe(LessonVideoStatus.STOPPED);
  expect(lesson.screens[0]?.visual?.status).toBe(LessonVisualStatus.SOURCE_SAVED);
  const sourceId = lesson.visuals[0]?.sourceId;
  const service = new LessonVideoService(
    fixture.ports.store,
    {
      authorize: () => Promise.resolve(),
      read: () => Promise.resolve(lesson.sources),
      list: () => Promise.resolve([]),
    },
    fixture.ports.content,
    fixture.ports.renderer,
    lesson.settings,
    randomUUID,
    hash,
  );
  await service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  lesson = { ...fixture.ports.readSaved(), status: LessonVideoStatus.RUNNING };
  for (let step = 0; step < 12 && lesson.status === LessonVideoStatus.RUNNING; step += 1) {
    lesson = await fixture.stages.execute(lesson, signal);
  }
  expect(lesson.status).toBe(LessonVideoStatus.READY);
  expect(lesson.visuals[0]?.sourceId).toBe(sourceId);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(1);
  expect(fixture.ports.content.generate).toHaveBeenCalledTimes(1);
  expect(fixture.ports.speech.synthesize).toHaveBeenCalledTimes(3);
});

it('keeps the final cumulative recovery slot for baseline instead of another custom execution', async () => {
  const fixture = createVisualStageFixture();
  let lesson = fixture.lesson;
  for (let operation = 0; operation < 3; operation += 1) {
    lesson = await fixture.stages.execute(lesson, signal);
  }
  lesson = await fixture.ports.store.saveStageResult({
    ...lesson,
    renderRecoveries: 1,
    screens: lesson.screens.map((screen, index) =>
      index === 0 ? { ...screen, renderAttempts: 5 } : screen,
    ),
  });
  lesson = await fixture.stages.execute(lesson, signal);
  expect(lesson.screens[0]?.visual?.status).toBe(LessonVisualStatus.DEGRADED);
  expect(fixture.ports.renderer.render).not.toHaveBeenCalled();
  lesson = await fixture.stages.execute(lesson, signal);
  expect(lesson.screens[0]?.renderAttempts).toBe(6);
  expect(fixture.ports.renderer.render.mock.calls[0]?.[3]).toBe(1);
  expect(fixture.ports.renderer.render.mock.calls[0]?.[0]).not.toHaveProperty('visual');
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(1);
});
