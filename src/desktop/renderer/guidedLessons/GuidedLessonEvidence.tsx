import { Alert, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState, type ReactElement } from 'react';
import type { EvidenceItem } from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';
import { createVerifiedLessonArtifactUrl } from './GuidedLessonMedia.js';

interface EvidenceDisplay {
  scope: string;
  artifactId: string;
  mimeType: string;
  url: string;
  text: string | null;
}

interface GuidedLessonEvidenceProps {
  userId: string;
  classId: string;
  lessonId: string;
  manifestHash: string;
  evidence: EvidenceItem[];
  reviewedIds: string[];
  busy: boolean;
  onReview: (evidenceId: string) => void;
}

/** Only teacher-authorized named artifacts can become evidence URLs, one at a time. */
export function GuidedLessonEvidence({
  userId,
  classId,
  lessonId,
  manifestHash,
  evidence,
  reviewedIds,
  busy,
  onReview,
}: GuidedLessonEvidenceProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [selectedId, setSelectedId] = useState(evidence[0]?.evidenceId ?? '');
  const [display, setDisplay] = useState<EvidenceDisplay | null>(null);
  const [failed, setFailed] = useState(false);
  const [decodedKey, setDecodedKey] = useState<string | null>(null);
  const selected = evidence.find((item) => item.evidenceId === selectedId);
  const scope = `${userId}:${classId}:${lessonId}:${manifestHash}`;
  const current =
    display?.scope === scope && display.artifactId === selected?.artifactId ? display : null;
  const artifactKey = `${scope}:${selected?.artifactId ?? ''}`;

  useEffect(() => {
    setSelectedId(evidence[0]?.evidenceId ?? '');
  }, [scope]);

  useEffect(() => {
    const lifetime = new AbortController();
    const isCancelled = (): boolean => lifetime.signal.aborted;
    let artifactUrl: string | null = null;
    setDisplay(null);
    setFailed(false);
    setDecodedKey(null);
    if (!selected) {
      return;
    }
    const load = async (): Promise<void> => {
      try {
        const read = window.tro.readGuidedLessonArtifact;
        if (!read) {
          throw new Error('Artifact bridge unavailable');
        }
        const reply = await read({
          classId,
          lessonId,
          releaseId: null,
          artifactId: selected.artifactId,
        });
        if (isCancelled()) {
          return;
        }
        if (
          reply.kind !== 'artifact' ||
          reply.artifactId !== selected.artifactId ||
          reply.digest !== selected.digest
        ) {
          throw new Error('Evidence does not match the manifest');
        }
        artifactUrl = await createVerifiedLessonArtifactUrl(
          reply.bytes,
          reply.digest,
          reply.mimeType,
        );
        if (isCancelled()) {
          URL.revokeObjectURL(artifactUrl);
          return;
        }
        let text: string | null = null;
        if (reply.mimeType === 'application/json') {
          if (reply.bytes.byteLength > 65_536) {
            throw new Error('Evidence report is too large');
          }
          const report: unknown = JSON.parse(new TextDecoder().decode(reply.bytes));
          text = JSON.stringify(report, null, 2);
          setDecodedKey(artifactKey);
        } else if (
          !reply.mimeType.startsWith('image/') &&
          !reply.mimeType.startsWith('audio/') &&
          !reply.mimeType.startsWith('video/')
        ) {
          throw new Error('Unsupported evidence type');
        }
        setDisplay({
          scope,
          artifactId: reply.artifactId,
          mimeType: reply.mimeType,
          url: artifactUrl,
          text,
        });
      } catch {
        if (!isCancelled()) {
          setFailed(true);
        }
      }
    };
    void load();
    return () => {
      lifetime.abort();
      if (artifactUrl) {
        URL.revokeObjectURL(artifactUrl);
      }
    };
  }, [scope, selected?.artifactId, selected?.digest, classId, lessonId]);

  return (
    <Stack gap="sm" className="guided-evidence">
      <Text fw={600}>{translate('Rendered review evidence')}</Text>
      <Select
        label={translate('Evidence item')}
        value={selectedId || null}
        data={evidence.map((item, index) => ({
          value: item.evidenceId,
          label: `${String(index + 1)}. ${item.kind} · ${item.sceneId ?? translate('Whole lesson')}${item.frame === null ? '' : ` · ${String(item.frame)}`}`,
        }))}
        onChange={(value) => {
          setSelectedId(value ?? '');
        }}
        disabled={busy}
      />
      {!current && !failed && selected && (
        <Group role="status">
          <Loader size="xs" />
          <Text size="sm">{translate('Loading lesson media…')}</Text>
        </Group>
      )}
      {failed && (
        <Alert color="orange" role="alert">
          {translate('Evidence could not be loaded. Refresh this lesson.')}
        </Alert>
      )}
      {current && (
        <div className="guided-evidence-display">
          {current.mimeType.startsWith('image/') && (
            <img
              src={current.url}
              alt={translate('Rendered lesson evidence')}
              onLoad={() => {
                setDecodedKey(artifactKey);
              }}
              onError={() => {
                setFailed(true);
              }}
            />
          )}
          {current.mimeType.startsWith('audio/') && (
            <audio
              src={current.url}
              controls
              preload="metadata"
              onLoadedMetadata={() => {
                setDecodedKey(artifactKey);
              }}
              onError={() => {
                setFailed(true);
              }}
            />
          )}
          {current.mimeType.startsWith('video/') && (
            <video
              src={current.url}
              controls
              preload="metadata"
              onLoadedMetadata={() => {
                setDecodedKey(artifactKey);
              }}
              onError={() => {
                setFailed(true);
              }}
            />
          )}
          {current.text !== null && <pre>{current.text}</pre>}
        </div>
      )}
      <Button
        variant="light"
        disabled={!current || !selected || failed || decodedKey !== artifactKey || busy}
        onClick={() => {
          if (selected && current && !failed && decodedKey === artifactKey) {
            onReview(selected.evidenceId);
          }
        }}
      >
        {translate('I reviewed this evidence')}
      </Button>
      <Text size="xs" c="dimmed">
        {reviewedIds.length} / {evidence.length} {translate('Evidence items reviewed')}
      </Text>
    </Stack>
  );
}
