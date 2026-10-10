import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import {
  LessonPhase,
  type LearnerProjection,
  type RenderManifest,
} from '#contracts/GuidedLessons.js';
import { buildLessonProjection } from '../domain/BuildLessonProjection.js';
import { hashLessonValue } from '../application/BuildLessonInput.js';
import type { LessonMediaArtifact } from '../application/LessonPorts.js';
import { buildLessonTimeline } from './BuildLessonTimeline.js';
import {
  LessonRenderMessageSchema,
  LessonRenderFailureSchema,
  LessonGeometrySchema,
  validateLessonGeometry,
  type LessonPresentationIdentity,
} from './LessonRenderProtocol.js';

let context: {
  stage: 'startup' | 'browser' | 'projection' | 'frame' | 'geometry';
  sceneId: string | null;
  frame: number | null;
  geometry: unknown;
} = { stage: 'startup', sceneId: null, frame: null, geometry: null };

/** The child receives only validated lesson data and media, without provider credentials. */
process.once('message', (raw: unknown) => {
  void renderLesson(raw).then(
    (result) => {
      process.send?.(result, () => {
        process.disconnect();
      });
    },
    () => {
      const geometry = LessonGeometrySchema.safeParse(context.geometry);
      process.send?.(
        LessonRenderFailureSchema.parse({
          ...context,
          kind: 'failed',
          geometry: geometry.success ? geometry.data : null,
        }),
        () => {
          process.disconnect();
        },
      );
    },
  );
});

async function renderLesson(raw: unknown) {
  const { request, identity, bundlePath } = LessonRenderMessageSchema.parse(raw);
  let manifest = buildLessonTimeline(request, {
    compositionBundleHash: identity.compositionBundleHash,
    fontBundleHash: identity.fontBundleHash,
    rendererVersion: identity.rendererVersion,
  });
  const artifacts: LessonMediaArtifact[] = [];
  const record = { ...request, releaseId: 'teacher-preview', manifest };
  const progress = {
    version: 0,
    sceneId: request.plan.scenes[0]?.sceneId ?? '',
    revealed: request.plan.checkpoints.map((checkpoint) => checkpoint.checkpointId),
    attempted: [],
    independent: [],
    hinted: [],
    frame: 0,
  };
  for (const scene of request.plan.scenes) {
    const checkpoint = request.plan.checkpoints.find((item) => item.sceneId === scene.sceneId);
    const phases = checkpoint ? [checkpoint.phase, LessonPhase.WORKED] : [LessonPhase.WATCH];
    for (const phase of phases) {
      context = { stage: 'projection', sceneId: scene.sceneId, frame: null, geometry: null };
      const projection = buildLessonProjection({
        record,
        progress,
        sceneId: scene.sceneId,
        teacherPreview: true,
        phase,
        hashValue: hashLessonValue,
      });
      const frame = Math.max(0, Math.floor(readProjectionEnd(projection) / 2));
      const audioSources = Object.fromEntries(
        request.speechArtifacts
          .filter((audio) => projection.allowedArtifactIds.includes(audio.descriptor.artifactId))
          .map((audio) => [
            audio.descriptor.artifactId,
            `data:${audio.descriptor.mimeType};base64,${Buffer.from(audio.bytes).toString('base64')}`,
          ]),
      );
      const inputProps = { projection, audioSources, sourceAssets: {} };
      const composition = await withRenderBrowser(identity, (browser) =>
        selectComposition({
          serveUrl: bundlePath,
          id: 'GuidedLesson',
          inputProps,
          puppeteerInstance: browser,
          chromeMode: identity.browserMode,
          logLevel: 'error',
        }),
      );
      const measurements: {
        frame: number;
        geometry: ReturnType<typeof validateLessonGeometry>;
      }[] = [];
      let frameBytes: Uint8Array | null = null;
      const sampledFrames = [
        ...new Set([
          frame,
          ...projection.narrationCues.map((cue) => Math.floor((cue.startFrame + cue.endFrame) / 2)),
          ...projection.visualCues.map((cue) => cue.startFrame),
        ]),
      ];
      for (const sampleFrame of sampledFrames) {
        let geometry: unknown = null;
        context.stage = 'frame';
        context.frame = sampleFrame;
        const rendered = await withRenderBrowser(identity, (browser) => {
          context.stage = 'frame';
          return renderStill({
            serveUrl: bundlePath,
            composition,
            inputProps,
            puppeteerInstance: browser,
            chromeMode: identity.browserMode,
            frame: sampleFrame,
            imageFormat: 'png',
            logLevel: 'error',
            onBrowserLog: (log) => {
              if (log.text.startsWith('tro.lesson.geometry:')) {
                try {
                  geometry = JSON.parse(log.text.slice('tro.lesson.geometry:'.length));
                } catch {
                  geometry = null;
                }
              }
            },
          });
        });
        if (!geometry || !rendered.buffer || rendered.buffer.byteLength > 16 * 1024 * 1024) {
          throw new Error('Rendered lesson evidence is incomplete.');
        }
        context.stage = 'geometry';
        context.geometry = geometry;
        measurements.push({ frame: sampleFrame, geometry: validateLessonGeometry(geometry) });
        if (sampleFrame === frame) {
          frameBytes = rendered.buffer;
        }
      }
      if (!frameBytes) {
        throw new Error('Rendered lesson evidence is incomplete.');
      }
      const artifactId = randomUUID();
      const digest = createHash('sha256').update(frameBytes).digest('hex');
      artifacts.push({
        artifactId,
        kind: 'frame',
        mimeType: 'image/png',
        bytes: frameBytes,
        digest,
        sceneId: scene.sceneId,
        phase,
      });
      const geometryBytes = Buffer.from(
        JSON.stringify({
          sceneId: scene.sceneId,
          phase,
          frame,
          canvas: { width: 1920, height: 1080 },
          smallestPlayer: { width: 640, height: 360 },
          measurements,
        }),
      );
      const geometryId = randomUUID();
      const geometryDigest = createHash('sha256').update(geometryBytes).digest('hex');
      artifacts.push({
        artifactId: geometryId,
        kind: 'source',
        mimeType: 'application/json',
        bytes: geometryBytes,
        digest: geometryDigest,
        sceneId: scene.sceneId,
        phase,
      });
      manifest = addEvidence(manifest, [
        {
          evidenceId: `frame-${artifactId}`,
          artifactId,
          kind: 'frame',
          digest,
          sceneId: scene.sceneId,
          frame,
          phase,
        },
        {
          evidenceId: `geometry-${geometryId}`,
          artifactId: geometryId,
          kind: 'geometry',
          digest: geometryDigest,
          sceneId: scene.sceneId,
          frame,
          phase,
        },
      ]);
    }
  }
  return { manifest, artifacts };
}

/** Chrome caches renderer processes after pages close. Finish each browser before admitting another operation. */
async function withRenderBrowser<Result>(
  identity: LessonPresentationIdentity,
  work: (browser: Awaited<ReturnType<typeof openBrowser>>) => Promise<Result>,
): Promise<Result> {
  context.stage = 'browser';
  const browser = await openBrowser('chrome', {
    browserExecutable: resolve(identity.browserPath),
    chromeMode: identity.browserMode,
    logLevel: 'error',
  });
  try {
    return await work(browser);
  } finally {
    await browser.close({ silent: true });
  }
}

function readProjectionEnd(projection: LearnerProjection): number {
  return Math.max(
    30,
    ...projection.narrationCues.map((cue) => cue.endFrame),
    ...projection.visualCues.map((cue) => cue.endFrame),
  );
}

function addEvidence(
  manifest: RenderManifest,
  evidence: RenderManifest['evidence'],
): RenderManifest {
  return { ...manifest, evidence: [...manifest.evidence, ...evidence] };
}
