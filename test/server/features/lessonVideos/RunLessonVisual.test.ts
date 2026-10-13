import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  LessonLayout,
  LessonVideoSchema,
  LessonVideoStage,
} from '../../../../src/contracts/LessonVideos.js';
import {
  LessonModelAttemptState,
  LessonModelRole,
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '../../../../src/contracts/LessonVisuals.js';
import {
  LessonVisualResultKind,
  type LessonDiagnostics,
  type LessonVisualProvider,
} from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';
import { RunLessonVisual } from '../../../../src/server/features/lessonVideos/application/RunLessonVisual.js';
import { readLessonView } from '../../../../src/server/features/lessonVideos/application/LessonVideoService.js';
import { createLessonFixture, createLessonPorts } from './LessonVideoFixtures.js';

const source =
  'export default function Scene() { return <svg viewBox="0 0 1176 390"><text x={40} y={80}>True / False</text></svg>; }';
const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cachedTokens: 0,
  requestId: 'visual-fixture',
};
const signal = new AbortController().signal;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createVisualFixture() {
  const lesson = createLessonFixture();
  const screenId = randomUUID();
  lesson.stage = LessonVideoStage.VISUAL;
  lesson.contentStarted = true;
  lesson.screens = [
    {
      id: screenId,
      layout: LessonLayout.EXAMPLE,
      title: 'Boolean values',
      points: ['Only True or False.'],
      narration: 'A Boolean value is either true or false.',
      audioId: null,
      clipId: null,
      silent: true,
      durationSeconds: 8,
      speechAttempts: 1,
      renderAttempts: 0,
      visual: {
        treatment: LessonVisualTreatment.CUSTOM,
        status: LessonVisualStatus.PENDING,
        degradationReason: null,
      },
    },
  ];
  lesson.visuals = [
    {
      screenId,
      brief: {
        position: 0,
        objective: 'Compare two possible Boolean values.',
        description: 'Reveal True and False side by side.',
        priority: 1,
      },
      sourceId: null,
      sourceDigest: null,
      inputDigest: null,
      sourceComplete: false,
      diagnostic: null,
    },
  ];
  const ports = createLessonPorts(lesson);
  const provider = {
    countRequest: vi.fn<LessonVisualProvider['countRequest']>().mockResolvedValue(1000),
    generateVisual: vi.fn<LessonVisualProvider['generateVisual']>().mockResolvedValue({
      kind: LessonVisualResultKind.SOURCE,
      source,
      usage,
    }),
  } satisfies LessonVisualProvider;
  const report = vi.fn<LessonDiagnostics>();
  const createRunner = () =>
    new RunLessonVisual(ports.store, provider, ports.renderer, randomUUID, hash, report);
  return { lesson, screenId, ports, provider, report, createRunner };
}

it('uses baseline for an unsupported worker without consuming or dispatching a model attempt', async () => {
  const fixture = createVisualFixture();
  fixture.ports.renderer.readVisualRuntime.mockResolvedValue(null);
  const lesson = await fixture.createRunner().execute(fixture.lesson, fixture.screenId, 8, signal);
  expect(lesson.screens[0]?.visual).toEqual({
    treatment: LessonVisualTreatment.BASELINE,
    status: LessonVisualStatus.DEGRADED,
    degradationReason: LessonVisualDegradation.UNSUPPORTED,
  });
  expect(lesson.modelAttempts).toHaveLength(0);
  expect(fixture.provider.countRequest).not.toHaveBeenCalled();
  expect(fixture.provider.generateVisual).not.toHaveBeenCalled();
});

it('commits a consumed attempt before dispatch and reuses the saved source after a runner restart', async () => {
  const fixture = createVisualFixture();
  fixture.provider.generateVisual.mockImplementation(() => {
    const dispatched = fixture.ports.readSaved().modelAttempts[0];
    expect(dispatched).toMatchObject({
      state: LessonModelAttemptState.DISPATCHED,
      screenId: fixture.screenId,
      ordinal: 1,
      usageUncertain: true,
    });
    return Promise.resolve({ kind: LessonVisualResultKind.SOURCE, source, usage });
  });
  const generated = await fixture
    .createRunner()
    .execute(fixture.lesson, fixture.screenId, 8, signal);
  expect(generated.visuals[0]).toMatchObject({ sourceComplete: true, sourceDigest: hash(source) });
  expect(generated.visuals[0]?.sourceId).not.toBeNull();
  expect(generated.screens[0]?.visual?.status).toBe(LessonVisualStatus.SOURCE_SAVED);
  const resumed = await fixture
    .createRunner()
    .execute(structuredClone(generated), fixture.screenId, 8, signal);
  expect(resumed.visuals[0]?.sourceId).toBe(generated.visuals[0]?.sourceId);
  expect(fixture.provider.countRequest).toHaveBeenCalledTimes(1);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(1);
  expect(resumed.modelAttempts).toHaveLength(1);
});

it('settles an interrupted saved dispatch without replaying it, then uses only the remaining slot', async () => {
  const fixture = createVisualFixture();
  const interrupted = await fixture.ports.store.beginModelAttempt(fixture.lesson, {
    id: randomUUID(),
    role: LessonModelRole.VISUAL,
    screenId: fixture.screenId,
    ordinal: 1,
    requestDigest: hash('interrupted request'),
    inputTokenLimit: 1000,
    outputTokenLimit: fixture.lesson.settings.visual.outputTokens,
    state: LessonModelAttemptState.DISPATCHED,
    usage: null,
    usageUncertain: true,
  });
  const recovered = await fixture.createRunner().execute(interrupted, fixture.screenId, 8, signal);
  expect(fixture.provider.generateVisual).not.toHaveBeenCalled();
  expect(recovered.modelAttempts[0]).toMatchObject({
    ordinal: 1,
    state: LessonModelAttemptState.UNAVAILABLE,
    usageUncertain: true,
  });
  const generated = await fixture.createRunner().execute(recovered, fixture.screenId, 8, signal);
  expect(generated.modelAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(1);
  expect(generated.usageUncertain).toBe(true);
});

it('saves incomplete source without making it executable, then shares the second slot with a focused repair', async () => {
  const fixture = createVisualFixture();
  const partialSource = 'export default function Scene() { return <svg>';
  fixture.provider.generateVisual.mockResolvedValueOnce({
    kind: LessonVisualResultKind.INCOMPLETE,
    source: partialSource,
    usage,
  });
  const incomplete = await fixture
    .createRunner()
    .execute(fixture.lesson, fixture.screenId, 8, signal);
  expect(incomplete.visuals[0]?.sourceComplete).toBe(false);
  expect(incomplete.modelAttempts[0]?.state).toBe(LessonModelAttemptState.INCOMPLETE);
  const repaired = await fixture.createRunner().execute(incomplete, fixture.screenId, 8, signal);
  expect(fixture.provider.generateVisual.mock.calls[1]?.[0]).toMatchObject({
    source: partialSource,
  });
  expect(repaired.visuals[0]?.sourceComplete).toBe(true);
  expect(repaired.modelAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(2);
});

it('degrades after the shared two attempts and never replenishes them on repeated execution', async () => {
  const fixture = createVisualFixture();
  fixture.provider.generateVisual.mockResolvedValue({
    kind: LessonVisualResultKind.INCOMPLETE,
    usage,
  });
  let lesson = fixture.lesson;
  for (let operation = 0; operation < 4; operation += 1) {
    lesson = await fixture.createRunner().execute(lesson, fixture.screenId, 8, signal);
  }
  expect(lesson.modelAttempts).toHaveLength(2);
  expect(fixture.provider.generateVisual).toHaveBeenCalledTimes(2);
  expect(lesson.screens[0]?.visual).toMatchObject({
    treatment: LessonVisualTreatment.BASELINE,
    status: LessonVisualStatus.DEGRADED,
  });
});

it('degrades oversized counted input before a paid dispatch', async () => {
  const fixture = createVisualFixture();
  fixture.provider.countRequest.mockResolvedValue(fixture.lesson.settings.visual.inputTokens + 1);
  const lesson = await fixture.createRunner().execute(fixture.lesson, fixture.screenId, 8, signal);
  expect(lesson.screens[0]?.visual?.degradationReason).toBe(LessonVisualDegradation.INPUT_LIMIT);
  expect(lesson.modelAttempts).toHaveLength(0);
  expect(fixture.provider.generateVisual).not.toHaveBeenCalled();
});

it('propagates cancellation with the dispatched attempt still consumed and usage uncertain', async () => {
  const fixture = createVisualFixture();
  const controller = new AbortController();
  const cancelled = new Error('Cancelled by teacher');
  fixture.provider.generateVisual.mockImplementation(() => {
    controller.abort(cancelled);
    return Promise.reject(cancelled);
  });
  await expect(
    fixture.createRunner().execute(fixture.lesson, fixture.screenId, 8, controller.signal),
  ).rejects.toThrow('Cancelled by teacher');
  expect(fixture.ports.readSaved().modelAttempts).toHaveLength(1);
  expect(fixture.ports.readSaved().modelAttempts[0]?.usageUncertain).toBe(true);
  expect(fixture.ports.readSaved().screens[0]?.visual?.status).not.toBe(
    LessonVisualStatus.DEGRADED,
  );
});

it('keeps generated source references and individual paid-attempt records out of public lesson JSON', async () => {
  const fixture = createVisualFixture();
  const lesson = await fixture.createRunner().execute(fixture.lesson, fixture.screenId, 8, signal);
  const json = JSON.stringify(LessonVideoSchema.parse(readLessonView(lesson)));
  expect(json).not.toContain('sourceId');
  expect(json).not.toContain('modelAttempts');
  expect(json).not.toContain(source);
  expect(json).toContain('source_saved');
});
