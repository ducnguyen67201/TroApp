import { expect, it } from 'vitest';
import { buildLessonTimeline } from '../../../../src/server/features/guidedLessons/infrastructure/BuildLessonTimeline.js';
import type { LessonRenderer } from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { hashLessonValue } from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { createLessonFixture, hashText } from './LessonFixture.js';

function createTimelineRequest(): Parameters<LessonRenderer['render']>[0] {
  const fixture = createLessonFixture();
  const manifest = fixture.record.manifest;
  if (!manifest) {
    throw new Error('Fixture manifest absent.');
  }
  return {
    revisionId: fixture.record.revisionId,
    input: fixture.input,
    plan: fixture.plan,
    contentHash: manifest.contentHash,
    adjustments: null,
    speechArtifacts: manifest.speechArtifacts.map((descriptor) => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3, 4]),
    })),
  };
}

const Identity = {
  rendererVersion: '1.0.0',
  compositionBundleHash: hashText('composition'),
  fontBundleHash: hashText('fonts'),
};

it('uses measured sample durations and rounds cumulative audio and hold time upward', () => {
  const request = createTimelineRequest();
  const first = request.speechArtifacts[0];
  const scene = request.plan.scenes[0];
  if (!first || !scene) {
    throw new Error('Fixture first beat absent.');
  }
  first.descriptor.durationMs = 34;
  request.adjustments = {
    contentHash: request.contentHash,
    baseRenderManifestHash: hashText('base-manifest'),
    scenes: [
      {
        sceneId: scene.sceneId,
        layoutVariant: scene.layoutVariant,
        captionPlacement: 'reservedBottom',
        beatAdjustments: [
          { beatId: first.descriptor.beatId, additionalHoldMs: 101, updateDelayMs: 0 },
        ],
      },
    ],
    addressedIssueIds: ['hold-1'],
  };
  const manifest = buildLessonTimeline(request, Identity);
  expect(manifest.cues[0]?.startFrame).toBe(0);
  expect(manifest.cues[0]?.endFrame).toBe(5);
  expect(manifest.cues[1]?.startFrame).toBe(5);
  expect(manifest.adjustmentsHash).toBe(hashLessonValue(request.adjustments));
  expect(manifest.inputPacketHash).toBe(request.input.sourcePacketHash);
  expect(manifest.compositionBundleHash).toBe(Identity.compositionBundleHash);
});

it('places pending and worked narration in separate explicitly labeled phases', () => {
  const request = createTimelineRequest();
  const checkpoint = request.plan.checkpoints[0];
  if (!checkpoint) {
    throw new Error('Fixture checkpoint absent.');
  }
  checkpoint.phase = 'try';
  const manifest = buildLessonTimeline(request, Identity);
  expect(manifest.cues.find((cue) => cue.beatId === 'question')?.phase).toBe('try');
  expect(manifest.cues.find((cue) => cue.beatId === 'worked')?.phase).toBe('worked');
  expect(
    manifest.cues.every(
      (cue, index) => cue.startFrame === (manifest.cues[index - 1]?.endFrame ?? 0),
    ),
  ).toBe(true);
});

it('requires exact approved content identity for every narration artifact', () => {
  const request = createTimelineRequest();
  const first = request.speechArtifacts[0];
  if (!first) {
    throw new Error('Fixture first speech absent.');
  }
  first.descriptor.contentHash = hashText('stale-content');
  expect(() => buildLessonTimeline(request, Identity)).toThrow('approved lesson');
  request.speechArtifacts = [];
  expect(() => buildLessonTimeline(request, Identity)).toThrow('approved lesson');
});

it('accepts exactly five measured minutes and rejects an additional rounded frame', () => {
  const request = createTimelineRequest();
  expect(request.speechArtifacts).toHaveLength(10);
  for (const artifact of request.speechArtifacts) {
    artifact.descriptor.durationMs = 30000;
  }
  expect(buildLessonTimeline(request, Identity).cues.at(-1)?.endFrame).toBe(9000);
  const first = request.speechArtifacts[0];
  if (!first) {
    throw new Error('Fixture first speech absent.');
  }
  first.descriptor.durationMs = 30001;
  expect(() => buildLessonTimeline(request, Identity)).toThrow('five minutes');
});

it('does not accumulate quantization drift across short measured beats', () => {
  const request = createTimelineRequest();
  for (const artifact of request.speechArtifacts) {
    artifact.descriptor.durationMs = 34;
  }
  const timeline = buildLessonTimeline(request, Identity);
  expect(timeline.cues.at(-1)?.endFrame).toBe(Math.ceil((10 * 34 * 30) / 1000));
});
