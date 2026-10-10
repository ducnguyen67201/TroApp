import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  LessonCodeFailureSchema,
  LessonCodeLimits,
  LessonCodeMode,
  LessonCodePreviewGeometrySchema,
  LessonCodeStage,
  LessonCodeWorkerInputSchema,
} from './LessonCodeSandbox.js';
import {
  LessonPresentationIdentitySchema,
  type LessonPresentationIdentity,
} from './LessonRenderProtocol.js';
import { validateLessonSource } from './ValidateLessonSource.js';

let stage: LessonCodeStage = LessonCodeStage.INPUT;

/* The host may crash while this container waits for its output to be copied. */
setTimeout(() => {
  process.exit(124);
}, LessonCodeLimits.DEADLINE_MS + 30_000);

/** This entry point belongs exclusively to the network-disabled generated-code render image. */
async function renderGeneratedLesson(): Promise<void> {
  const inputBytes = await readFile('/render/input/Input.json');
  if (inputBytes.byteLength > 1_048_576) {
    throw new Error('The generated lesson input exceeds the render limit.');
  }
  const raw: unknown = JSON.parse(inputBytes.toString('utf8'));
  const input = LessonCodeWorkerInputSchema.parse(raw);
  const source = await readFile('/render/input/Scene.tsx');
  if (source.byteLength < 1 || source.byteLength > LessonCodeLimits.SOURCE_BYTES) {
    throw new Error('The generated lesson source exceeds the render limit.');
  }
  stage = LessonCodeStage.COMPILE;
  validateLessonSource(source.toString('utf8'));
  const identityRaw: unknown = JSON.parse(
    await readFile('/app/dist/lessonBundle/PresentationIdentity.json', 'utf8'),
  );
  const identity = LessonPresentationIdentitySchema.parse(identityRaw);
  const directory = await mkdtemp('/tmp/tro-generated-lesson-');
  const entryPoint = join(directory, 'Entry.tsx');
  await writeFile(entryPoint, buildTrustedEntry(input.durationInFrames));
  stage = LessonCodeStage.COMPILE;
  const serveUrl = await bundle({
    entryPoint,
    outDir: join(directory, 'bundle'),
    enableCaching: false,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        modules: ['/app/node_modules', 'node_modules'],
      },
    }),
  });
  const inputProps = { projection: input.projection };
  stage = LessonCodeStage.METADATA;
  const composition = await withBrowser(identity, (browser) =>
    selectComposition({
      serveUrl,
      id: 'GeneratedLesson',
      inputProps,
      puppeteerInstance: browser,
      chromeMode: identity.browserMode,
      logLevel: 'error',
    }),
  );
  if (
    composition.width !== 1920 ||
    composition.height !== 1080 ||
    composition.fps !== 30 ||
    composition.durationInFrames !== input.durationInFrames
  ) {
    throw new Error('The generated lesson changed trusted composition metadata.');
  }
  if (input.mode === LessonCodeMode.PREVIEW) {
    for (const frame of input.frames) {
      stage = LessonCodeStage.FRAME;
      let geometry: unknown;
      const rendered = await withBrowser(identity, (browser) =>
        renderStill({
          serveUrl,
          composition,
          inputProps,
          puppeteerInstance: browser,
          chromeMode: identity.browserMode,
          logLevel: 'error',
          frame,
          imageFormat: 'png',
          onBrowserLog: (log) => {
            if (log.text.startsWith('tro.generated.geometry:')) {
              try {
                const parsed: unknown = JSON.parse(
                  log.text.slice('tro.generated.geometry:'.length),
                );
                geometry = parsed;
              } catch {
                geometry = undefined;
              }
            }
          },
        }),
      );
      stage = LessonCodeStage.GEOMETRY;
      const validated = LessonCodePreviewGeometrySchema.parse(geometry);
      if (!rendered.buffer || rendered.buffer.byteLength > LessonCodeLimits.FRAME_BYTES) {
        throw new Error('The generated preview exceeds the render limit.');
      }
      await writeFile(`/render/output/Frame${String(frame)}.png`, rendered.buffer);
      await writeFile(`/render/output/Geometry${String(frame)}.json`, JSON.stringify(validated));
    }
  } else {
    stage = LessonCodeStage.VIDEO;
    await withBrowser(identity, (browser) =>
      renderMedia({
        serveUrl,
        composition,
        inputProps,
        puppeteerInstance: browser,
        chromeMode: identity.browserMode,
        logLevel: 'error',
        outputLocation: '/render/output/Video.mp4',
        codec: 'h264',
        pixelFormat: 'yuv420p',
        muted: true,
        enforceAudioTrack: false,
        concurrency: 1,
        crf: 24,
        x264Preset: 'veryfast',
      }),
    );
  }
}

async function withBrowser<Result>(
  identity: LessonPresentationIdentity,
  render: (browser: Awaited<ReturnType<typeof openBrowser>>) => Promise<Result>,
): Promise<Result> {
  const browser = await openBrowser('chrome', {
    browserExecutable: resolve('/app', identity.browserPath),
    chromeMode: identity.browserMode,
    logLevel: 'error',
  });
  try {
    return await render(browser);
  } finally {
    await browser.close({ silent: true });
  }
}

/**
 * Source cannot choose entry points, plugins, packages, dimensions, fonts, or output paths.
 * Measurement covers visible text, ancestor overflow and effective font scaling, including
 * unmarked text. Agent-selected data attributes alone cannot prove frame readability.
 * As with image review, this is a quality check rather than a security attestation of content.
 */
function buildTrustedEntry(durationInFrames: number): string {
  return `
import React, {useEffect} from 'react';
import {AbsoluteFill, Composition, registerRoot, useCurrentFrame, useDelayRender} from 'remotion';
import Scene from '/render/input/Scene.tsx';
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
import '@fontsource/noto-sans/vietnamese-400.css';
import '@fontsource/noto-sans/vietnamese-700.css';
import '@fontsource/noto-sans-mono/latin-400.css';
import '@fontsource/noto-sans-mono/latin-700.css';

/* Glyph-range height is not font size. The minimum planar singular value is a
   conservative scale bound for shrinking, skew and 3D foreshortening. Perspective
   needs position-dependent projection, so it cannot certify readable text here. */
function readMinimumPlanarScale(matrix: DOMMatrixReadOnly): number {
  if (matrix.m14 !== 0 || matrix.m24 !== 0 || matrix.m34 !== 0) return 0;
  const squares = matrix.m11 ** 2 + matrix.m12 ** 2 + matrix.m21 ** 2 + matrix.m22 ** 2;
  const determinant = matrix.m11 * matrix.m22 - matrix.m12 * matrix.m21;
  return Math.sqrt(Math.max(0, (squares - Math.sqrt(Math.max(0, squares ** 2 - 4 * determinant ** 2))) / 2));
}

function readScaleNumber(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.abs(number) / (value.endsWith('%') ? 100 : 1) : 0;
}

function readElementScale(style: CSSStyleDeclaration): number {
  if (style.perspective !== 'none') return 0;
  let scale = style.transform === 'none' ? 1 : readMinimumPlanarScale(new DOMMatrixReadOnly(style.transform));
  if (style.scale && style.scale !== 'none') {
    const axes = style.scale.trim().split(/\\s+/);
    scale *= Math.min(readScaleNumber(axes[0] ?? '1'), readScaleNumber(axes[1] ?? axes[0] ?? '1'));
  }
  if (style.rotate && style.rotate !== 'none') {
    const parts = style.rotate.trim().split(/\\s+/);
    const angle = parts[parts.length - 1] ?? '0deg';
    const degrees = Number.parseFloat(angle) * (angle.endsWith('turn') ? 360 : angle.endsWith('grad') ? 0.9 : angle.endsWith('rad') ? 180 / Math.PI : 1);
    const axis = parts.length === 4
      ? [Number(parts[0]), Number(parts[1]), Number(parts[2])]
      : parts[0] === 'x' ? [1, 0, 0] : parts[0] === 'y' ? [0, 1, 0] : [0, 0, 1];
    scale *= readMinimumPlanarScale(new DOMMatrix().rotateAxisAngle(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 1, degrees));
  }
  return scale * readScaleNumber(style.zoom || '1');
}

function MeasuredScene({projection}: {projection: unknown}) {
  const frame = useCurrentFrame();
  const {delayRender, continueRender, cancelRender} = useDelayRender();
  useEffect(() => {
    const handle = delayRender('Load lesson fonts and measure visible text');
    let active = true;
    Promise.all([
      document.fonts.load('48px "Noto Sans"'),
      document.fonts.load('700 48px "Noto Sans"'),
      document.fonts.load('48px "Noto Sans Mono"'),
      document.fonts.load('700 48px "Noto Sans Mono"'),
    ]).then(() => {
      if (!active) return;
      const root = document.getElementById('tro-generated-lesson');
      const geometry: Array<{fontPx:number;x:number;y:number;width:number;height:number;scrollWidth:number;clientWidth:number;scrollHeight:number;clientHeight:number;clippedWidth:number;clippedHeight:number}> = [];
      if (root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        let visited = 0;
        while ((text = walker.nextNode())) {
          visited += 1;
          if (visited > 2000) {
            cancelRender(new Error('Too many generated text nodes.'));
            return;
          }
          if (!text.textContent?.trim()) continue;
          const element = text.parentElement;
          if (!element || element.closest('style,script')) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          let opacity = 1;
          let fontScale = 1;
          for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
            const ancestorStyle = getComputedStyle(ancestor);
            opacity *= Number(ancestorStyle.opacity);
            fontScale *= readElementScale(ancestorStyle);
          }
          if (opacity <= 0.01 + Number.EPSILON) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          const bounds = range.getBoundingClientRect();
          if (bounds.width === 0 || bounds.height === 0) continue;
          let visibleLeft = bounds.left;
          let visibleRight = bounds.right;
          let visibleTop = bounds.top;
          let visibleBottom = bounds.bottom;
          for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
            const ancestorStyle = getComputedStyle(ancestor);
            const clipsX = ['hidden', 'clip', 'scroll', 'auto'].includes(ancestorStyle.overflowX);
            const clipsY = ['hidden', 'clip', 'scroll', 'auto'].includes(ancestorStyle.overflowY);
            if (!clipsX && !clipsY) continue;
            const rectangle = ancestor.getBoundingClientRect();
            const scaleX = ancestor instanceof HTMLElement && ancestor.offsetWidth > 0 ? rectangle.width / ancestor.offsetWidth : 1;
            const scaleY = ancestor instanceof HTMLElement && ancestor.offsetHeight > 0 ? rectangle.height / ancestor.offsetHeight : 1;
            const left = rectangle.left + ancestor.clientLeft * scaleX;
            const top = rectangle.top + ancestor.clientTop * scaleY;
            if (clipsX) {
              visibleLeft = Math.max(visibleLeft, left);
              visibleRight = Math.min(visibleRight, left + ancestor.clientWidth * scaleX);
            }
            if (clipsY) {
              visibleTop = Math.max(visibleTop, top);
              visibleBottom = Math.min(visibleBottom, top + ancestor.clientHeight * scaleY);
            }
          }
          geometry.push({
            fontPx: Number.parseFloat(style.fontSize) * fontScale,
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
            clippedWidth: Math.max(0, bounds.width - Math.max(0, visibleRight - visibleLeft)),
            clippedHeight: Math.max(0, bounds.height - Math.max(0, visibleBottom - visibleTop)),
          });
        }
      }
      console.info('tro.generated.geometry:' + JSON.stringify(geometry));
      continueRender(handle);
    }, () => {
      if (active) cancelRender(new Error('Bundled lesson fonts did not load.'));
    });
    return () => { active = false; continueRender(handle); };
  }, [frame, delayRender, continueRender, cancelRender]);
  return <AbsoluteFill id="tro-generated-lesson" style={{fontFamily:'Noto Sans',fontSize:48,overflow:'hidden'}}><Scene projection={projection}/></AbsoluteFill>;
}

registerRoot(() => <Composition id="GeneratedLesson" component={MeasuredScene} durationInFrames={${String(durationInFrames)}} fps={30} width={1920} height={1080}/>);
`;
}

async function runWorker(): Promise<void> {
  let status = 'ready';
  try {
    await renderGeneratedLesson();
  } catch (error) {
    status = 'failed';
    const failure = LessonCodeFailureSchema.parse({
      stage,
      message: (error instanceof Error ? error.message : 'Isolated lesson rendering failed.').slice(
        0,
        4000,
      ),
    });
    await writeFile('/render/output/Failure.json', JSON.stringify(failure));
  }
  await writeFile('/render/output/Ready.txt', status);
  /* The host copies bounded tmpfs output before removing this credential-free container. */
  await new Promise<never>(() => {
    setInterval(() => {}, 60_000);
  });
}

void runWorker().catch(() => {
  process.exitCode = 1;
});
