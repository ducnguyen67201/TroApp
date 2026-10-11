import { expect, it } from 'vitest';
import { buildLessonProjection } from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { createLessonFixture } from './LessonFixture.js';
import { createSourceLessonFixture } from './SourceLessonFixture.js';

it('carries the explicitly selected language even when the source and scene titles use another language', () => {
  const fixture = createSourceLessonFixture();
  const input = { ...fixture.input, language: 'vi' as const };
  const plan = { ...fixture.plan, language: 'vi' as const };
  const projection = buildLessonProjection({
    ...fixture,
    record: { ...fixture.record, input, plan },
  });
  expect(projection.language).toBe('vi');
  expect(projection.sceneTitle).toBe('Read the first idea');
});

it('projects only the held before state and pending audio until an authorized reveal', () => {
  const { record, progress, hashValue, held } = createLessonFixture();
  const projection = buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' });
  expect(projection.phase).toBe('predict');
  expect(projection.language).toBe(record.input.language);
  expect(projection.lessonPhases).toEqual(['watch', 'predict', 'worked', 'reflect']);
  expect(projection.visibleTraceStates).toHaveLength(1);
  expect(projection.visibleTraceStates[0]).toEqual({
    eventId: held.eventId,
    lineId: held.lineId,
    operation: held.operation,
    stateView: 'before',
    values: held.before,
    output: null,
  });
  expect(projection.allowedArtifactIds).toEqual(['audio-question']);
  expect(projection.narrationCues[0]?.startFrame).toBe(0);
  expect(JSON.stringify(projection)).not.toContain('The running total is now two.');
  expect(JSON.stringify(projection)).not.toContain('answerRef');
  expect(JSON.stringify(projection)).not.toContain('workedExplanation');
});

it('blocks later scene requests and explicit phase bypasses while a checkpoint is pending', () => {
  const { record, progress, hashValue } = createLessonFixture();
  expect(() => buildLessonProjection({ record, progress, hashValue, sceneId: 'continue' })).toThrow(
    'previous checkpoint',
  );
  expect(() =>
    buildLessonProjection({ record, progress, hashValue, sceneId: 'predict', phase: 'worked' }),
  ).toThrow('still pending');
  expect(() =>
    buildLessonProjection({ record, progress, hashValue, sceneId: 'predict', phase: 'watch' }),
  ).toThrow('still pending');
});

it('reveals only worked-phase audio and marks supported completion separately from independent success', () => {
  const { record, progress, hashValue } = createLessonFixture();
  progress.revealed.push('checkpoint-1');
  const supported = buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' });
  expect(supported.phase).toBe('worked');
  expect(supported.allowedArtifactIds).toEqual(['audio-worked']);
  expect(supported.checkpoint?.state).toBe('assisted');
  expect(supported.visibleTraceStates.some((state) => state.stateView === 'after')).toBe(true);
  progress.independent.push('checkpoint-1');
  expect(
    buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' }).checkpoint?.state,
  ).toBe('independent');
  expect(buildLessonProjection({ record, progress, hashValue, sceneId: 'continue' }).phase).toBe(
    'watch',
  );
});

it('allows teacher evidence for either pending or worked presentation without a student release', () => {
  const { record, progress, hashValue } = createLessonFixture();
  record.releaseId = null;
  expect(() => buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' })).toThrow(
    'available release',
  );
  const pending = buildLessonProjection({
    record,
    progress,
    hashValue,
    sceneId: 'predict',
    teacherPreview: true,
    phase: 'predict',
  });
  expect(pending.visibleTraceStates.every((state) => state.stateView === 'before')).toBe(true);
  const worked = buildLessonProjection({
    record,
    progress,
    hashValue,
    sceneId: 'predict',
    teacherPreview: true,
    phase: 'worked',
  });
  expect(worked.allowedArtifactIds).toEqual(['audio-worked']);
  expect(worked.releaseId).toBe('preview-revision-1');
});

it('holds the before state for approved update delay and rebases phase cues to zero', () => {
  const { record, progress, hashValue, held } = createLessonFixture();
  progress.revealed.push('checkpoint-1');
  record.adjustments = {
    contentHash: record.contentHash ?? '',
    baseRenderManifestHash: hashValue(record.manifest),
    scenes: [
      {
        sceneId: 'predict',
        layoutVariant: 'wideCode',
        captionPlacement: 'reservedSide',
        beatAdjustments: [{ beatId: 'worked', additionalHoldMs: 0, updateDelayMs: 500 }],
      },
    ],
    addressedIssueIds: ['timing-1'],
  };
  if (!record.manifest) {
    throw new Error('Fixture manifest absent.');
  }
  record.manifest.adjustmentsHash = hashValue(record.adjustments);
  const projection = buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' });
  expect(projection.presentation.layoutVariant).toBe('wideCode');
  expect(projection.visualCues.slice(0, 2)).toEqual([
    { eventId: held.eventId, stateView: 'before', startFrame: 0, endFrame: 15 },
    { eventId: held.eventId, stateView: 'after', startFrame: 15, endFrame: 30 },
  ]);
});

it('fails closed on stale render identities or missing exact narration media', () => {
  const fixture = createLessonFixture();
  const manifest = fixture.record.manifest;
  if (!manifest) {
    throw new Error('Fixture manifest absent.');
  }
  manifest.contentHash = 'a'.repeat(64);
  expect(() => buildLessonProjection(fixture)).toThrow('pinned revision');
  const fresh = createLessonFixture();
  if (!fresh.record.manifest) {
    throw new Error('Fixture manifest absent.');
  }
  fresh.record.manifest.cues = fresh.record.manifest.cues.filter(
    (cue) => cue.beatId !== 'question',
  );
  expect(() => buildLessonProjection({ ...fresh, sceneId: 'predict' })).toThrow(
    'exactly one playback cue',
  );
});

it('restores a bounded server cursor and reflects on the final authorized state', () => {
  const { record, progress, hashValue } = createLessonFixture();
  progress.frame = 17;
  expect(buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' }).frame).toBe(17);
  progress.frame = 9000;
  expect(buildLessonProjection({ record, progress, hashValue, sceneId: 'predict' }).frame).toBe(29);
  progress.revealed.push('checkpoint-1');
  const reflection = buildLessonProjection({
    record,
    progress,
    hashValue,
    sceneId: 'continue',
    phase: 'reflect',
  });
  expect(reflection.visibleTraceStates).toHaveLength(1);
  expect(reflection.visibleTraceStates[0]?.stateView).toBe('after');
  expect(reflection.visibleTraceStates[0]?.output).toBe(12);
});

it('allows only the approved video for the current scene and phase', () => {
  const fixture = createLessonFixture();
  const manifest = fixture.record.manifest;
  if (!manifest) {
    throw new Error('Fixture manifest absent.');
  }
  const evidence = (artifactId: string, phase: 'predict' | 'worked') => ({
    evidenceId: `evidence-${artifactId}`,
    artifactId,
    kind: 'clip' as const,
    digest: 'a'.repeat(64),
    sceneId: 'predict',
    phase,
    frame: null,
  });
  manifest.evidence.push(evidence('pending-video', 'predict'), evidence('worked-video', 'worked'));
  const pending = buildLessonProjection({ ...fixture, sceneId: 'predict' });
  expect(pending.videoArtifactId).toBe('pending-video');
  expect(pending.allowedArtifactIds).toContain('pending-video');
  expect(pending.allowedArtifactIds).not.toContain('worked-video');
  fixture.progress.revealed.push('checkpoint-1');
  const worked = buildLessonProjection({ ...fixture, sceneId: 'predict' });
  expect(worked.videoArtifactId).toBe('worked-video');
  expect(worked.allowedArtifactIds).not.toContain('pending-video');
  manifest.evidence.push(evidence('ambiguous-worked-video', 'worked'));
  expect(() => buildLessonProjection({ ...fixture, sceneId: 'predict' })).toThrow(
    'one exact approved video',
  );
});

it('projects exact approved source points and speech without inventing program state or figure access', () => {
  const fixture = createSourceLessonFixture();
  for (const scene of fixture.plan.scenes) {
    if (scene.kind !== 'sourceExplanation') {
      throw new Error('The source fixture must contain only source explanations.');
    }
    const projection = buildLessonProjection({ ...fixture, sceneId: scene.sceneId });
    expect(projection.phase).toBe('watch');
    expect(projection.lessonPhases).toEqual(['watch', 'reflect']);
    expect(projection.language).toBe(fixture.input.language);
    expect(projection.presentation).toEqual({
      kind: 'sourceExplanation',
      templateVersion: scene.templateVersion,
      layoutVariant: scene.layoutVariant,
      points: scene.params.points,
    });
    expect(projection.visibleTraceStates).toEqual([]);
    expect(projection.visualCues).toEqual([]);
    expect(projection.checkpoint).toBeNull();
    expect(projection.narrationCues.map((cue) => cue.text)).toEqual(
      scene.narration.map((beat) => beat.text),
    );
    expect(projection.allowedArtifactIds).toEqual(
      scene.narration.map((beat) => `audio-${beat.beatId}`),
    );
    expect(projection.presentation).not.toHaveProperty('figure');
    expect(projection.presentation).not.toHaveProperty('codeBlock');
  }
});

it('supports a source-only reflection without speech or checkpoint and rejects worked-phase invention', () => {
  const fixture = createSourceLessonFixture();
  const scene = fixture.plan.scenes.at(-1);
  if (!scene) {
    throw new Error('The source fixture needs a final scene.');
  }
  const reflection = buildLessonProjection({
    ...fixture,
    sceneId: scene.sceneId,
    phase: 'reflect',
  });
  expect(reflection.phase).toBe('reflect');
  expect(reflection.presentation.kind).toBe('sourceExplanation');
  expect(reflection.narrationCues).toEqual([]);
  expect(reflection.allowedArtifactIds).toEqual([]);
  expect(reflection.visibleTraceStates).toEqual([]);
  expect(() =>
    buildLessonProjection({ ...fixture, sceneId: scene.sceneId, phase: 'worked' }),
  ).toThrow('requires a checkpoint');
});
