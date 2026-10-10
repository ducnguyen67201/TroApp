import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { RenderManifestSchema } from '#contracts/GuidedLessons.js';
import { RemotionLessonRenderer } from '../../../../src/server/features/guidedLessons/infrastructure/RemotionLessonRenderer.js';
import {
  LessonGeometrySchema,
  validateLessonGeometry,
} from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderProtocol.js';
import { buildLessonProjection } from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { createLessonFixture } from './LessonFixture.js';

/** Synthetic evidence is retained outside the repository for manual graphic review after integration runs. */
export const LessonRenderEvidenceDirectory = join(tmpdir(), 'tro-guided-lesson-render-evidence');

function createSilentWave(): Uint8Array<ArrayBuffer> {
  const sampleRate = 24000;
  const dataLength = sampleRate * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string): void => {
    bytes.set(
      Array.from(value, (character) => character.charCodeAt(0)),
      offset,
    );
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataLength, true);
  return bytes;
}

const GeometryEvidenceSchema = z.strictObject({
  sceneId: z.string(),
  phase: z.string(),
  frame: z.number().int(),
  canvas: z.strictObject({ width: z.literal(1920), height: z.literal(1080) }),
  smallestPlayer: z.strictObject({ width: z.literal(640), height: z.literal(360) }),
  measurements: z
    .array(z.strictObject({ frame: z.number().int(), geometry: LessonGeometrySchema }))
    .min(1),
});

it('renders actual trusted pixels and geometry for pending and worked phases using only local silent media', async () => {
  const fixture = createLessonFixture();
  const sourceManifest = fixture.record.manifest;
  if (!sourceManifest) {
    throw new Error('Fixture manifest absent.');
  }
  const wave = createSilentWave();
  const audioDigest = createHash('sha256').update(wave).digest('hex');
  const speechArtifacts = sourceManifest.speechArtifacts.map((descriptor) => ({
    descriptor: {
      ...descriptor,
      audioDigest,
      byteLength: wave.byteLength,
      durationMs: 1000,
      sampleRateHz: 24000,
    },
    bytes: wave,
  }));
  const renderer = new RemotionLessonRenderer(undefined, (event) => {
    console.info('lesson-render-diagnostic', JSON.stringify(event));
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, 150000);
  const rendered = await renderer
    .render(
      {
        revisionId: fixture.record.revisionId,
        input: fixture.input,
        plan: fixture.plan,
        contentHash: sourceManifest.contentHash,
        speechArtifacts,
        adjustments: null,
      },
      controller.signal,
    )
    .finally(() => {
      clearTimeout(deadline);
      controller.abort();
    });
  const manifest = RenderManifestSchema.parse(rendered.manifest);
  expect(manifest.contentHash).toBe(sourceManifest.contentHash);
  expect(manifest.inputPacketHash).toBe(fixture.input.sourcePacketHash);
  expect(manifest.evidence.filter((item) => item.kind === 'frame')).toHaveLength(4);
  expect(manifest.evidence.filter((item) => item.kind === 'geometry')).toHaveLength(4);
  await mkdir(LessonRenderEvidenceDirectory, { recursive: true });
  for (const artifact of rendered.artifacts) {
    expect(createHash('sha256').update(artifact.bytes).digest('hex')).toBe(artifact.digest);
    expect(
      manifest.evidence.some(
        (item) => item.artifactId === artifact.artifactId && item.digest === artifact.digest,
      ),
    ).toBe(true);
    if (artifact.kind === 'frame') {
      expect([...artifact.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const imageHeader = new DataView(
        artifact.bytes.buffer,
        artifact.bytes.byteOffset,
        artifact.bytes.byteLength,
      );
      expect(imageHeader.getUint32(16)).toBe(1920);
      expect(imageHeader.getUint32(20)).toBe(1080);
      await writeFile(
        join(
          LessonRenderEvidenceDirectory,
          `${artifact.sceneId ?? 'scene'}-${artifact.phase ?? 'phase'}.png`,
        ),
        artifact.bytes,
      );
    } else if (artifact.mimeType === 'application/json') {
      const raw: unknown = JSON.parse(new TextDecoder().decode(artifact.bytes));
      const evidence = GeometryEvidenceSchema.parse(raw);
      for (const measurement of evidence.measurements) {
        expect(validateLessonGeometry(measurement.geometry)).toHaveLength(
          measurement.geometry.length,
        );
      }
    }
  }
  const pendingFrame = rendered.artifacts.find(
    (artifact) =>
      artifact.kind === 'frame' && artifact.sceneId === 'predict' && artifact.phase === 'predict',
  );
  const workedFrame = rendered.artifacts.find(
    (artifact) =>
      artifact.kind === 'frame' && artifact.sceneId === 'predict' && artifact.phase === 'worked',
  );
  expect(pendingFrame?.digest).toBeDefined();
  expect(workedFrame?.digest).toBeDefined();
  expect(pendingFrame?.digest).not.toBe(workedFrame?.digest);
  const record = { ...fixture.record, manifest };
  const pending = buildLessonProjection({
    record,
    progress: fixture.progress,
    hashValue: fixture.hashValue,
    sceneId: 'predict',
    teacherPreview: true,
    phase: 'predict',
  });
  const worked = buildLessonProjection({
    record,
    progress: fixture.progress,
    hashValue: fixture.hashValue,
    sceneId: 'predict',
    teacherPreview: true,
    phase: 'worked',
  });
  expect(pending.visibleTraceStates.every((state) => state.stateView === 'before')).toBe(true);
  expect(pending.allowedArtifactIds).not.toContain('audio-worked');
  expect(worked.allowedArtifactIds).toContain('audio-worked');
  await writeFile(
    join(LessonRenderEvidenceDirectory, 'EvidenceIndex.json'),
    JSON.stringify(
      {
        manifest,
        files: rendered.artifacts
          .filter((artifact) => artifact.kind === 'frame')
          .map((artifact) => ({
            file: `${artifact.sceneId ?? 'scene'}-${artifact.phase ?? 'phase'}.png`,
            digest: artifact.digest,
          })),
      },
      null,
      2,
    ),
  );
}, 180000);
