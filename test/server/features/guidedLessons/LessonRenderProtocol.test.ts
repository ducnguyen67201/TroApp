import { expect, it } from 'vitest';
import {
  LessonRenderInputSchema,
  LessonRenderMessageSchema,
  validateLessonGeometry,
} from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderProtocol.js';
import { createLessonFixture, hashText } from './LessonFixture.js';

const Box = {
  fontPx: 48,
  x: 60,
  y: 60,
  width: 800,
  height: 100,
  scrollWidth: 800,
  clientWidth: 800,
  scrollHeight: 100,
  clientHeight: 100,
};

it('accepts readable contained essential content at the qualified minimum size', () => {
  expect(validateLessonGeometry([Box])).toEqual([Box]);
});

it.each([
  { fontPx: 47.9 },
  { x: -2 },
  { y: -2 },
  { x: 1200, width: 800 },
  { y: 1000, height: 100 },
  { scrollWidth: 803 },
  { scrollHeight: 103 },
  { clippedWidth: 3 },
  { clippedHeight: 3 },
])('rejects essential clipping, overflow, or small text', (change) => {
  expect(() => validateLessonGeometry([{ ...Box, ...change }])).toThrow('clipped or below');
});

it('rejects missing, malformed, and unbounded geometry evidence', () => {
  expect(() => validateLessonGeometry([])).toThrow();
  expect(() => validateLessonGeometry([{ ...Box, fontPx: NaN }])).toThrow();
  expect(() => validateLessonGeometry(Array.from({ length: 101 }, () => Box))).toThrow();
  expect(() => validateLessonGeometry([{ ...Box, html: '<script>' }])).toThrow();
  expect(() => validateLessonGeometry([{ ...Box, clippedWidth: -1 }])).toThrow();
  expect(() =>
    validateLessonGeometry([{ ...Box, clippedHeight: Number.POSITIVE_INFINITY }]),
  ).toThrow();
});

it('preserves older measurements and accepts ancestor clipping only within the existing tolerance', () => {
  expect(validateLessonGeometry([Box])).toEqual([Box]);
  const geometry = [{ ...Box, clippedWidth: 2, clippedHeight: 2 }];
  expect(validateLessonGeometry(geometry)).toEqual(geometry);
});

it('accepts only typed bounded render inputs rather than arbitrary script or remote URLs', () => {
  const fixture = createLessonFixture();
  const manifest = fixture.record.manifest;
  if (!manifest) {
    throw new Error('Fixture manifest absent.');
  }
  const request = {
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
  expect(LessonRenderInputSchema.safeParse(request).success).toBe(true);
  expect(
    LessonRenderInputSchema.safeParse({ ...request, code: 'require("child_process")' }).success,
  ).toBe(false);
  expect(
    LessonRenderInputSchema.safeParse({
      ...request,
      speechArtifacts: [{ descriptor: manifest.speechArtifacts[0], bytes: 'base64' }],
    }).success,
  ).toBe(false);
  const message = {
    bundlePath: '/trusted/bundle',
    identity: {
      compositionBundleHash: hashText('composition'),
      fontBundleHash: hashText('fonts'),
      rendererVersion: '1.0.0',
      browserPath: '/trusted/chromium',
      browserMode: 'chrome-for-testing',
    },
    request,
  };
  expect(LessonRenderMessageSchema.safeParse(message).success).toBe(true);
  expect(
    LessonRenderMessageSchema.safeParse({ ...message, remoteUrl: 'https://attacker.invalid' })
      .success,
  ).toBe(false);
});
