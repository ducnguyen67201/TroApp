import {
  RenderManifestSchema,
  LessonPhase,
  EvidenceItemSchema,
  type SpeechArtifact,
  type TimelineCue,
} from '#contracts/GuidedLessons.js';
import { z } from 'zod';
import type { LessonRenderer } from '../application/LessonPorts.js';
import { hashLessonValue } from '../application/BuildLessonInput.js';

export interface LessonPresentationIdentity {
  compositionBundleHash: string;
  fontBundleHash: string;
  rendererVersion: string;
}

/** Duration comes from persisted speech samples. Frame boundaries never estimate narration by character count. */
export function buildLessonTimeline(
  request: Parameters<LessonRenderer['render']>[0],
  identity: LessonPresentationIdentity,
) {
  const cues: TimelineCue[] = [];
  let frame = 0;
  let elapsedMs = 0;
  const speech = new Map<string, SpeechArtifact>(
    request.speechArtifacts.map((artifact) => [artifact.descriptor.beatId, artifact.descriptor]),
  );
  for (const scene of request.plan.scenes) {
    const checkpoint = request.plan.checkpoints.find((item) => item.sceneId === scene.sceneId);
    const phases = [
      { phase: checkpoint?.phase ?? LessonPhase.WATCH, beats: scene.narration },
      ...(checkpoint ? [{ phase: LessonPhase.WORKED, beats: checkpoint.workedExplanation }] : []),
    ];
    const adjustment = request.adjustments?.scenes.find((item) => item.sceneId === scene.sceneId);
    for (const group of phases) {
      for (const beat of group.beats) {
        const audio = speech.get(beat.beatId);
        if (!audio || audio.contentHash !== request.contentHash) {
          throw new Error('Narration does not match the approved lesson.');
        }
        const holdMs =
          adjustment?.beatAdjustments.find((item) => item.beatId === beat.beatId)
            ?.additionalHoldMs ?? 0;
        elapsedMs += audio.durationMs + holdMs;
        const endFrame = Math.max(frame + 1, Math.ceil((elapsedMs * 30) / 1000));
        if (endFrame > 9000) {
          throw new Error('The measured lesson exceeds five minutes.');
        }
        cues.push({
          cueId: `cue-${beat.beatId}`,
          sceneId: scene.sceneId,
          phase: group.phase,
          beatId: beat.beatId,
          audioArtifactId: audio.artifactId,
          startFrame: frame,
          endFrame,
          traceEventId: beat.traceEventId,
          stateView: beat.stateView,
        });
        frame = endFrame;
      }
    }
  }
  return RenderManifestSchema.extend({ evidence: z.array(EvidenceItemSchema).max(100) }).parse({
    schemaVersion: '1.0',
    revisionId: request.revisionId,
    contentHash: request.contentHash,
    inputPacketHash: request.input.sourcePacketHash,
    adjustmentsHash: request.adjustments ? hashLessonValue(request.adjustments) : null,
    ...identity,
    templateVersions: request.input.templates.map((template) => ({
      templateId: template.templateId,
      version: template.templateVersion,
    })),
    width: 1920,
    height: 1080,
    fps: 30,
    speechArtifacts: request.speechArtifacts.map((audio) => audio.descriptor),
    cues,
    evidence: [],
    sourceAssetDigests: request.input.assets.map((asset) => ({
      assetId: asset.assetId,
      digest: asset.digest,
    })),
  });
}
