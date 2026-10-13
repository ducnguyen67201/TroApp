import { describe, expect, it } from 'vitest';
import {
  LessonRenderRequestSchema,
  LessonRendererHealthSchema,
  lessonRenderVersion,
  lessonVisualRuntimeVersion,
} from '../../src/contracts/LessonRenderProtocol.js';
import {
  compileLessonVisual,
  LessonVisualCodeError,
} from '../../src/lessonRenderer/CompileLessonVisual.js';
import { renderLessonVisualFrames } from '../../src/lessonRenderer/RenderLessonVisualFrames.js';
import { validateLessonVisualFrames } from '../../src/lessonRenderer/ValidateLessonVisualFrames.js';
import { lessonVisualFixtures, lessonVisualScreen } from './LessonVisualFixtures.js';

describe('isolated lesson visuals', () => {
  it.each(Object.entries(lessonVisualFixtures))(
    'produces bounded inert frames for %s',
    async (_subject, source) => {
      const frames = await renderLessonVisualFrames(
        { source, runtimeVersion: lessonVisualRuntimeVersion },
        lessonVisualScreen,
        1,
        new AbortController().signal,
      );
      expect(frames).toHaveLength(30);
      expect(frames[0]).not.toEqual(frames[29]);
      expect(frames[0]?.tag).toBe('svg');
    },
    30000,
  );

  it('does not expose Node, network, environment or the host function constructor', async () => {
    const source = `export default function Scene() {return <text x={20} y={20} fontSize={20}>{[typeof process, typeof fetch, typeof require('react').createElement.constructor('return typeof process')()].join('/')}</text>;}`;
    expect(() => compileLessonVisual(source)).toThrow('Dynamic module loading');
    const frames = await renderLessonVisualFrames(
      {
        source: `export default function Scene() {return <text x={20} y={20} fontSize={20}>{[typeof process,typeof fetch,Function('return typeof process')()].join('/')}</text>;}`,
        runtimeVersion: lessonVisualRuntimeVersion,
      },
      lessonVisualScreen,
      1,
      new AbortController().signal,
    );
    expect(frames[0]?.children).toEqual(['undefined/undefined/undefined']);
  }, 30000);

  it('preserves Vietnamese labels through bounded child byte streams', async () => {
    const frames = await renderLessonVisualFrames(
      {
        source:
          'export default function Scene() {return <text fontSize={24}>Biểu thức Boolean có giá trị đúng hoặc sai.</text>}',
        runtimeVersion: lessonVisualRuntimeVersion,
      },
      lessonVisualScreen,
      1,
      new AbortController().signal,
    );
    expect(frames[0]?.children).toEqual(['Biểu thức Boolean có giá trị đúng hoặc sai.']);
  }, 30000);

  it('rejects external imports, dynamic imports and syntax errors as code failures', () => {
    for (const source of [
      "import fs from 'node:fs'; export default () => null",
      "export default () => import('https://example.com')",
      'export default function Scene( {',
    ]) {
      expect(() => compileLessonVisual(source)).toThrow(LessonVisualCodeError);
    }
  });

  it.each([
    { tag: 'foreignObject', attributes: {}, children: [] },
    { tag: 'svg', attributes: { onLoad: 'fetch("https://example.com")' }, children: [] },
    { tag: 'path', attributes: { fill: 'url(https://example.com/asset.svg)' }, children: [] },
    {
      tag: 'text',
      attributes: { dangerouslySetInnerHTML: { __html: '<script />' } },
      children: [],
    },
  ])('rejects active or external SVG output %#', (node) => {
    expect(() => validateLessonVisualFrames([node], 1)).toThrow(LessonVisualCodeError);
  });

  it('bounds recursion before recursive schema parsing', () => {
    let node: unknown = { tag: 'g', attributes: {}, children: [] };
    for (let depth = 0; depth < 100; depth += 1) {
      node = { tag: 'g', attributes: {}, children: [node] };
    }
    expect(() => validateLessonVisualFrames([node], 1)).toThrow('depth or node limit');
  });

  it('terminates an infinite guest loop within the fixed execution boundary', async () => {
    await expect(
      renderLessonVisualFrames(
        {
          source: 'export default function Scene() { while(true) {} }',
          runtimeVersion: lessonVisualRuntimeVersion,
        },
        lessonVisualScreen,
        1,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LessonVisualCodeError);
  }, 30000);

  it('caps guest linear memory independently of QuickJS allocation accounting', async () => {
    await expect(
      renderLessonVisualFrames(
        {
          source:
            'export default function Scene() { const buffers=[]; for(let index=0; index<100; index+=1) buffers.push(new Uint8Array(7*1024*1024)); return <g/>; }',
          runtimeVersion: lessonVisualRuntimeVersion,
        },
        lessonVisualScreen,
        1,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LessonVisualCodeError);
  }, 30000);

  it('does not turn cancellation into a successful degraded frame', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      renderLessonVisualFrames(
        { source: lessonVisualFixtures.counting, runtimeVersion: lessonVisualRuntimeVersion },
        lessonVisualScreen,
        1,
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
  });

  it('preserves old baseline requests and only negotiates the known custom runtime', () => {
    expect(
      LessonRenderRequestSchema.safeParse({
        kind: 'clip',
        version: lessonRenderVersion,
        screen: lessonVisualScreen,
        durationSeconds: 1,
        audio: null,
      }).success,
    ).toBe(true);
    expect(
      LessonRendererHealthSchema.safeParse({
        version: lessonRenderVersion,
        buildId: 'older-worker',
      }).success,
    ).toBe(true);
    expect(
      LessonRendererHealthSchema.safeParse({
        version: lessonRenderVersion,
        buildId: 'worker',
        visualRuntimeVersion: 'unsupported',
      }).success,
    ).toBe(false);
  });
});
