import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { Player, type PlayerRef } from '@remotion/player';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { LearnerProjection } from '#contracts/GuidedLessons.js';
import {
  LessonComposition,
  readLessonDurationFrames,
} from '../../../lessonMedia/LessonComposition.js';
import { LessonPresentationIdentity } from '../../../lessonMedia/PresentationIdentity.js';
import { useLocale } from '../localization/UseLocale.js';

export interface GuidedLessonMediaProps {
  userId: string;
  classId: string;
  lessonId: string;
  releaseId: string | null;
  projection: LearnerProjection;
  paused: boolean;
  initialFrame?: number;
  onFrameChange: (frame: number) => void;
  onReadyChange?: (ready: boolean) => void;
}

interface LoadedArtifact {
  scope: string;
  artifactId: string;
  mimeType: string;
  url: string;
}

/** Keeps only the current/next permitted media loaded; every URL belongs to this view. */
export function readNeededLessonArtifacts(projection: LearnerProjection, frame: number): string[] {
  const cues = projection.narrationCues;
  const currentIndex = cues.findIndex((cue) => cue.endFrame > frame);
  const currentCue = currentIndex >= 0 ? cues[currentIndex] : undefined;
  const nextCue = currentIndex >= 0 ? cues[currentIndex + 1] : undefined;
  const presentation = projection.presentation;
  const figure =
    presentation.kind === 'annotatedSource'
      ? presentation.figure
      : presentation.kind === 'checkpoint'
        ? presentation.figure
        : null;
  const wanted = figure
    ? [figure.assetId, currentCue?.artifactId]
    : [currentCue?.artifactId, nextCue?.artifactId];
  return [
    ...new Set(
      wanted.filter(
        (artifactId): artifactId is string =>
          artifactId !== undefined && projection.allowedArtifactIds.includes(artifactId),
      ),
    ),
  ];
}

/** A packaged player must use the exact composition and fonts approved for this release. */
export function canPlayLessonProjection(
  projection: Pick<LearnerProjection, 'compositionBundleHash' | 'fontBundleHash'>,
  identity: { compositionBundleHash: string; fontBundleHash: string } = LessonPresentationIdentity,
): boolean {
  return Boolean(
    identity.compositionBundleHash &&
    identity.fontBundleHash &&
    projection.compositionBundleHash === identity.compositionBundleHash &&
    projection.fontBundleHash === identity.fontBundleHash,
  );
}

export async function createVerifiedLessonArtifactUrl(
  bytes: Uint8Array,
  digest: string,
  mimeType: string,
): Promise<string> {
  const copy = new Uint8Array(bytes);
  const computed = await crypto.subtle.digest('SHA-256', copy.buffer);
  const hash = Array.from(new Uint8Array(computed), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== digest) {
    throw new Error('Artifact digest mismatch');
  }
  return URL.createObjectURL(new Blob([copy.buffer], { type: mimeType }));
}

export function GuidedLessonMedia({
  userId,
  classId,
  lessonId,
  releaseId,
  projection,
  paused,
  initialFrame = 0,
  onFrameChange,
  onReadyChange,
}: GuidedLessonMediaProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const mediaScope = `${userId}:${classId}:${lessonId}:${releaseId ?? 'preview'}:${projection.renderManifestHash}:${projection.sceneId}:${projection.phase}`;
  const player = useRef<PlayerRef>(null);
  const [frameState, setFrameState] = useState({ scope: mediaScope, frame: initialFrame });
  const frame = frameState.scope === mediaScope ? frameState.frame : initialFrame;
  const [expanded, setExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState<LoadedArtifact[]>([]);
  const artifactsRef = useRef<LoadedArtifact[]>([]);
  const generation = useRef(0);
  const resumeAfterBuffer = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const needed = readNeededLessonArtifacts(projection, frame);
  const neededKey = needed.join('|');
  const currentArtifacts = artifacts.filter((artifact) => artifact.scope === mediaScope);
  const compatible = canPlayLessonProjection(projection);
  const ready =
    compatible &&
    !error &&
    needed.every((artifactId) =>
      currentArtifacts.some((artifact) => artifact.artifactId === artifactId),
    );

  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange, mediaScope]);

  useEffect(() => {
    const ref = player.current;
    const updateFrame = (event: { detail: { frame: number } }): void => {
      setFrameState({ scope: mediaScope, frame: event.detail.frame });
      onFrameChange(event.detail.frame);
    };
    ref?.addEventListener('frameupdate', updateFrame);
    return () => ref?.removeEventListener('frameupdate', updateFrame);
  }, [onFrameChange, expanded, mediaScope]);

  useEffect(() => {
    if (paused) {
      player.current?.pause();
      resumeAfterBuffer.current = false;
    }
  }, [paused]);

  useEffect(() => {
    setFrameState({ scope: mediaScope, frame: initialFrame });
    player.current?.seekTo(initialFrame);
  }, [mediaScope, initialFrame]);

  useEffect(() => {
    generation.current += 1;
    setArtifacts([]);
    artifactsRef.current.forEach((artifact) => {
      URL.revokeObjectURL(artifact.url);
    });
    artifactsRef.current = [];
    setError(false);
    return () => {
      generation.current += 1;
      player.current?.pause();
      artifactsRef.current.forEach((artifact) => {
        URL.revokeObjectURL(artifact.url);
      });
      artifactsRef.current = [];
    };
  }, [mediaScope]);

  useEffect(() => {
    const currentGeneration = generation.current;
    const lifetime = new AbortController();
    const isCancelled = (): boolean => lifetime.signal.aborted;
    if (!compatible) {
      player.current?.pause();
      setLoading(false);
      return;
    }
    const retained = artifactsRef.current.filter(
      (artifact) => artifact.scope === mediaScope && needed.includes(artifact.artifactId),
    );
    artifactsRef.current
      .filter((artifact) => artifact.scope !== mediaScope || !needed.includes(artifact.artifactId))
      .forEach((artifact) => {
        URL.revokeObjectURL(artifact.url);
      });
    artifactsRef.current = retained;
    setArtifacts(retained);
    const missing = needed.filter(
      (artifactId) => !retained.some((artifact) => artifact.artifactId === artifactId),
    );
    if (missing.length === 0) {
      setLoading(false);
      return;
    }
    resumeAfterBuffer.current = player.current?.isPlaying() ?? false;
    player.current?.pause();
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const read = window.tro.readGuidedLessonArtifact;
        if (!read) {
          throw new Error('Artifact bridge unavailable');
        }
        for (const artifactId of missing) {
          const reply = await read({ classId, lessonId, releaseId, artifactId });
          if (isCancelled() || currentGeneration !== generation.current) {
            return;
          }
          if (reply.kind !== 'artifact' || reply.artifactId !== artifactId) {
            throw new Error('Artifact unavailable');
          }
          const url = await createVerifiedLessonArtifactUrl(
            reply.bytes,
            reply.digest,
            reply.mimeType,
          );
          if (isCancelled() || currentGeneration !== generation.current) {
            URL.revokeObjectURL(url);
            return;
          }
          artifactsRef.current = [
            ...artifactsRef.current,
            { scope: mediaScope, artifactId, mimeType: reply.mimeType, url },
          ];
          setArtifacts(artifactsRef.current);
        }
        setError(false);
        setLoading(false);
        if (resumeAfterBuffer.current && !paused) {
          player.current?.play();
        }
      } catch {
        if (!isCancelled() && currentGeneration === generation.current) {
          setError(true);
          setLoading(false);
          player.current?.pause();
        }
      }
    };
    void load();
    return () => {
      lifetime.abort();
    };
  }, [mediaScope, neededKey, classId, lessonId, releaseId, compatible]);

  const audioSources = Object.fromEntries(
    currentArtifacts
      .filter((artifact) => artifact.mimeType.startsWith('audio/'))
      .map((artifact) => [artifact.artifactId, artifact.url]),
  );
  const sourceAssets = Object.fromEntries(
    currentArtifacts
      .filter((artifact) => artifact.mimeType.startsWith('image/'))
      .map((artifact) => [artifact.artifactId, artifact.url]),
  );
  const renderPlayer = (): ReactElement => (
    <Player
      key={mediaScope}
      ref={player}
      component={LessonComposition}
      inputProps={{ projection, audioSources, sourceAssets }}
      durationInFrames={readLessonDurationFrames(projection)}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      initialFrame={frame}
      controls={ready && !loading && !paused}
      clickToPlay={ready && !loading && !paused}
      spaceKeyToPlayOrPause={ready && !loading && !paused}
      style={{ width: '100%', aspectRatio: '16 / 9' }}
    />
  );

  return (
    <Stack gap="sm" className="guided-media">
      {!compatible && (
        <Alert role="alert" color="orange">
          {translate('Update Tro to play this lesson with its approved graphics and fonts.')}
        </Alert>
      )}
      <div className="guided-player-scroll">{compatible && !expanded && renderPlayer()}</div>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {projection.sceneTitle}
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={!compatible}
          onClick={() => {
            setExpanded(true);
          }}
        >
          {translate('Expand lesson')}
        </Button>
      </Group>
      {loading && (
        <Group role="status" gap="xs">
          <Loader size="xs" />
          <Text size="sm">{translate('Loading lesson media…')}</Text>
        </Group>
      )}
      {error && (
        <Alert role="alert" color="red">
          {translate('Media could not be loaded. Refresh this lesson.')}
        </Alert>
      )}
      <Modal
        opened={expanded}
        onClose={() => {
          setExpanded(false);
        }}
        title={projection.sceneTitle}
        size="90%"
      >
        <div className="guided-player-scroll">{compatible && expanded && renderPlayer()}</div>
      </Modal>
    </Stack>
  );
}
