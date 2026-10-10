import { expect, it } from 'vitest';
import { readLessonGeometryIssues } from '../../../../src/server/features/guidedLessons/infrastructure/LessonGeometryDiagnostics.js';
import { validateLessonGeometry } from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderProtocol.js';

const Box = {
  fontPx: 64,
  x: 20,
  y: 20,
  width: 800,
  height: 100,
  scrollWidth: 800,
  clientWidth: 800,
  scrollHeight: 100,
  clientHeight: 100,
};

it('locates the exact caption measurement and reports the observed three-pixel vertical overflow', () => {
  const geometry = [Box, { ...Box, y: 800, scrollHeight: 128, clientHeight: 125 }];
  const issues = readLessonGeometryIssues(geometry);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('measurement[1]');
  expect(issues[0]).toContain(
    'vertical overflow: scrollHeight=128 > clientHeight=125 + tolerancePx=2 (overflowPx=3)',
  );
  expect(issues[0]).toContain('fontPx=64, x=20, y=800, width=800, height=100');
  expect(() => validateLessonGeometry(geometry)).toThrow('clipped or below');
});

it('reports failed font, viewport, and horizontal and vertical scroll constraints together', () => {
  const issues = readLessonGeometryIssues([
    {
      ...Box,
      fontPx: 47,
      x: -2,
      y: -2,
      width: 2000,
      height: 1100,
      scrollWidth: 803,
      scrollHeight: 103,
    },
  ]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('fontPx=47 < minimumFontPx=48');
  expect(issues[0]).toContain('left=-2, top=-2, right=1998, bottom=1098');
  expect(issues[0]).toContain('scrollWidth=803 > clientWidth=800 + tolerancePx=2');
  expect(issues[0]).toContain('scrollHeight=103 > clientHeight=100 + tolerancePx=2');
});

it('identifies both overlapping measurement indexes and the overlap dimensions', () => {
  const issues = readLessonGeometryIssues([Box, { ...Box, x: 40, y: 70 }]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('measurement[0] overlaps measurement[1]');
  expect(issues[0]).toContain('overlapWidth=780, overlapHeight=50');
  expect(issues[0]).toContain('both exceed tolerancePx=2');
});

it('rejects ancestor clipping even when the text box fits its own container and the canvas', () => {
  const geometry = [{ ...Box, clippedWidth: 12, clippedHeight: 48 }];
  expect(() => validateLessonGeometry(geometry)).toThrow('clipped or below');
  const issues = readLessonGeometryIssues(geometry);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('measurement[0]');
  expect(issues[0]).toContain('ancestor horizontal clipping: clippedWidth=12 > tolerancePx=2');
  expect(issues[0]).toContain('ancestor vertical clipping: clippedHeight=48 > tolerancePx=2');
  expect(issues[0]).toContain(
    'scrollWidth=800, clientWidth=800, scrollHeight=100, clientHeight=100',
  );
});

it('returns no issues only after the unchanged canonical validator passes', () => {
  const geometry = [{ ...Box, fontPx: 48, scrollWidth: 802, scrollHeight: 102 }];
  expect(validateLessonGeometry(geometry)).toEqual(geometry);
  expect(readLessonGeometryIssues(geometry)).toEqual([]);
});

it('bounds detailed messages and counts omitted failures without returning untrusted fields', () => {
  const issues = readLessonGeometryIssues(Array.from({ length: 100 }, () => Box));
  expect(issues).toHaveLength(9);
  expect(issues.every((message) => message.length <= 1000)).toBe(true);
  expect(issues.at(-1)).toContain('4942 additional measured layout failures omitted');
  const invalid = readLessonGeometryIssues([{ ...Box, source: 'untrusted source text' }]);
  expect(invalid).toEqual([
    'The preview geometry does not match the required finite numeric measurement schema.',
  ]);
  expect(JSON.stringify(invalid)).not.toContain('untrusted source text');
});
