import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  LessonStatus,
  LessonPhase,
  type GuidedLessonDetail,
  type LearnerProjection,
  type LessonPlan,
} from '#contracts/GuidedLessons.js';
import { useLocale } from '../localization/UseLocale.js';
import { GuidedLessonMedia } from './GuidedLessonMedia.js';
import { GuidedLessonEvidence } from './GuidedLessonEvidence.js';
import { isGuidedLessonRunning, readLessonStatusLabel } from './GuidedLessonLabels.js';

interface TeacherLessonStudioProps {
  userId: string;
  lesson: GuidedLessonDetail;
  preview: LearnerProjection | null;
  busy: boolean;
  onSavePlan: (plan: LessonPlan) => Promise<void>;
  onApproveScript: () => Promise<void>;
  onRender: () => Promise<void>;
  onApprovePreview: (evidenceIds: string[]) => Promise<void>;
  onRelease: () => Promise<void>;
  onWithdraw: () => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
  onPreviewScene: (sceneId: string, phase?: LessonPhase) => Promise<void>;
}

/** Teacher edits change a draft; explicit hash-bound approvals remain backend commands. */
export function TeacherLessonStudio({
  userId,
  lesson,
  preview,
  busy,
  onSavePlan,
  onApproveScript,
  onRender,
  onApprovePreview,
  onRelease,
  onWithdraw,
  onCancel,
  onRetry,
  onPreviewScene,
}: TeacherLessonStudioProps): ReactElement {
  const { messages } = useLocale();
  const translate = messages.translateGuidedLesson;
  const [plan, setPlan] = useState(lesson.plan);
  const [sceneId, setSceneId] = useState(lesson.plan?.scenes[0]?.sceneId ?? '');
  const [scriptRead, setScriptRead] = useState(false);
  const [previewRead, setPreviewRead] = useState(false);
  const [inspectedScenes, setInspectedScenes] = useState<string[]>([]);
  const [openedScriptScenes, setOpenedScriptScenes] = useState<string[]>(
    lesson.plan?.scenes[0] ? [lesson.plan.scenes[0].sceneId] : [],
  );
  const [readyPreviewKey, setReadyPreviewKey] = useState<string | null>(null);
  const [reviewedEvidenceIds, setReviewedEvidenceIds] = useState<string[]>([]);
  const dirty = JSON.stringify(plan) !== JSON.stringify(lesson.plan);
  const scene = plan?.scenes.find((item) => item.sceneId === sceneId);
  const checkpoint = plan?.checkpoints.find((item) => item.sceneId === sceneId);
  const running = isGuidedLessonRunning(lesson.status);
  const canEdit =
    !busy &&
    !running &&
    lesson.status !== LessonStatus.RELEASED &&
    lesson.status !== LessonStatus.USAGE_UNCERTAIN;
  const canMakePreview =
    lesson.scriptApproved &&
    (!lesson.manifest ||
      lesson.status === LessonStatus.FAILED ||
      lesson.status === LessonStatus.BUDGET_BLOCKED);
  const receiveFrame = useCallback((): void => {}, []);
  const previewKey = preview
    ? `${preview.renderManifestHash}:${preview.sceneId}:${preview.phase}`
    : '';
  const previewCheckpoint = plan?.checkpoints.find((item) => item.sceneId === preview?.sceneId);
  const previewPhase = preview?.phase ?? LessonPhase.WATCH;
  const previewPhases = previewCheckpoint
    ? [previewCheckpoint.phase, LessonPhase.WORKED]
    : [LessonPhase.WATCH];
  const requiredPreviewScenes =
    plan?.scenes.flatMap((item) => {
      const itemCheckpoint = plan.checkpoints.find(
        (candidate) => candidate.sceneId === item.sceneId,
      );
      return (
        itemCheckpoint ? [itemCheckpoint.phase, LessonPhase.WORKED] : [LessonPhase.WATCH]
      ).map((phase) => `${item.sceneId}:${phase}`);
    }) ?? [];
  const inspectedEveryPhase = requiredPreviewScenes.every((key) => inspectedScenes.includes(key));
  const inspectedEveryEvidence =
    lesson.manifest?.evidence.every((item) => reviewedEvidenceIds.includes(item.evidenceId)) ??
    false;
  const receivePreviewReady = useCallback(
    (ready: boolean): void => {
      setReadyPreviewKey(ready ? previewKey : null);
    },
    [previewKey],
  );

  useEffect(() => {
    setPlan(lesson.plan);
    setScriptRead(false);
    setPreviewRead(false);
    setInspectedScenes([]);
    setOpenedScriptScenes(lesson.plan?.scenes[0] ? [lesson.plan.scenes[0].sceneId] : []);
    setReadyPreviewKey(null);
    setReviewedEvidenceIds([]);
    setSceneId((current) =>
      lesson.plan?.scenes.some((item) => item.sceneId === current)
        ? current
        : (lesson.plan?.scenes[0]?.sceneId ?? ''),
    );
  }, [lesson.contentHash, lesson.version]);

  const replaceSceneNarration = (beatId: string, text: string): void => {
    setPlan((current) =>
      current
        ? {
            ...current,
            scenes: current.scenes.map((item) =>
              item.sceneId === sceneId
                ? {
                    ...item,
                    narration: item.narration.map((beat) =>
                      beat.beatId === beatId ? { ...beat, text } : beat,
                    ),
                  }
                : item,
            ),
          }
        : null,
    );
    setScriptRead(false);
  };
  const replaceCheckpointText = (
    kind: 'question' | 'hint' | 'worked',
    id: string,
    text: string,
  ): void => {
    setPlan((current) =>
      current
        ? {
            ...current,
            checkpoints: current.checkpoints.map((item) =>
              item.sceneId !== sceneId
                ? item
                : kind === 'question'
                  ? { ...item, question: text }
                  : kind === 'hint'
                    ? {
                        ...item,
                        hints: item.hints.map((hint) =>
                          hint.hintId === id ? { ...hint, text } : hint,
                        ),
                      }
                    : {
                        ...item,
                        workedExplanation: item.workedExplanation.map((beat) =>
                          beat.beatId === id ? { ...beat, text } : beat,
                        ),
                      },
            ),
          }
        : null,
    );
    setScriptRead(false);
  };

  return (
    <div className="guided-studio-grid">
      <Stack gap="lg" className="guided-paper-panel">
        <Group justify="space-between">
          <Text fw={600}>{translate('Generation status')}</Text>
          <Badge variant="light">{translate(readLessonStatusLabel(lesson.status))}</Badge>
        </Group>
        {running && (
          <Text size="sm" c="dimmed" role="status">
            {translate('No estimated progress is available for this stage.')}
          </Text>
        )}
        {lesson.error && (
          <Alert color="orange" role="alert">
            {lesson.error}
          </Alert>
        )}
        <Group>
          {running && (
            <Button variant="outline" color="red" disabled={busy} onClick={() => void onCancel()}>
              {translate('Cancel run')}
            </Button>
          )}
          {[
            LessonStatus.FAILED,
            LessonStatus.CANCELLED,
            LessonStatus.BUDGET_BLOCKED,
            LessonStatus.NEEDS_TEACHER_INPUT,
          ].some((status) => status === lesson.status) &&
            !lesson.scriptApproved && (
              <Button variant="outline" disabled={busy} onClick={() => void onRetry()}>
                {translate('Retry with a new allowance')}
              </Button>
            )}
        </Group>
        {plan && (
          <>
            <Text fw={600}>{translate('Script and checkpoints')}</Text>
            <TextInput
              label={translate('Lesson title')}
              value={plan.title}
              maxLength={120}
              disabled={!canEdit}
              onChange={(event) => {
                const title = event.currentTarget.value;
                setPlan((current) => (current ? { ...current, title } : null));
                setScriptRead(false);
              }}
            />
            <Select
              label={translate('Scene')}
              value={sceneId || null}
              data={plan.scenes.map((item, index) => ({
                value: item.sceneId,
                label: `${String(index + 1)}. ${item.title}`,
              }))}
              onChange={(value) => {
                setSceneId(value ?? '');
                if (value) {
                  setOpenedScriptScenes((current) =>
                    current.includes(value) ? current : [...current, value],
                  );
                }
              }}
            />
            {scene?.narration.map((beat, index) => (
              <Textarea
                key={beat.beatId}
                label={`${translate('Narration')} ${String(index + 1)}`}
                value={beat.text}
                maxLength={1200}
                minRows={3}
                disabled={!canEdit}
                onChange={(event) => {
                  replaceSceneNarration(beat.beatId, event.currentTarget.value);
                }}
              />
            ))}
            {checkpoint && (
              <Stack gap="sm" className="guided-checkpoint-review">
                <Textarea
                  label={translate('Question')}
                  value={checkpoint.question}
                  maxLength={500}
                  minRows={2}
                  disabled={!canEdit}
                  onChange={(event) => {
                    replaceCheckpointText(
                      'question',
                      checkpoint.checkpointId,
                      event.currentTarget.value,
                    );
                  }}
                />
                {checkpoint.hints.map((hint, index) => (
                  <Textarea
                    key={hint.hintId}
                    label={`${translate('Hints')} ${String(index + 1)}`}
                    value={hint.text}
                    maxLength={500}
                    disabled={!canEdit}
                    onChange={(event) => {
                      replaceCheckpointText('hint', hint.hintId, event.currentTarget.value);
                    }}
                  />
                ))}
                {checkpoint.workedExplanation.map((beat) => (
                  <Textarea
                    key={beat.beatId}
                    label={translate('Worked explanation')}
                    value={beat.text}
                    maxLength={1200}
                    disabled={!canEdit}
                    onChange={(event) => {
                      replaceCheckpointText('worked', beat.beatId, event.currentTarget.value);
                    }}
                  />
                ))}
              </Stack>
            )}
            {dirty && (
              <>
                <Text size="xs" c="dimmed">
                  {translate('Edits require a new review and approval before media is made.')}
                </Text>
                <Button loading={busy} disabled={!canEdit} onClick={() => void onSavePlan(plan)}>
                  {translate('Save edits and review again')}
                </Button>
              </>
            )}
            {!lesson.scriptApproved && (
              <>
                <Text size="xs" c="dimmed">
                  {openedScriptScenes.length} / {plan.scenes.length}{' '}
                  {translate('Script scenes opened')}
                </Text>
                <Checkbox
                  checked={scriptRead}
                  onChange={(event) => {
                    setScriptRead(event.currentTarget.checked);
                  }}
                  label={translate(
                    'I reviewed the script, sources, hints and worked explanations.',
                  )}
                  disabled={
                    openedScriptScenes.length < plan.scenes.length || dirty || busy || running
                  }
                />
                <Button
                  disabled={
                    !scriptRead ||
                    dirty ||
                    busy ||
                    running ||
                    lesson.status !== LessonStatus.AWAITING_SCRIPT_APPROVAL
                  }
                  onClick={() => void onApproveScript()}
                >
                  {translate('Approve this script')}
                </Button>
              </>
            )}
            {lesson.scriptApproved && (
              <Badge color="green" variant="light">
                {translate('Script approved')}
              </Badge>
            )}
            {canMakePreview && (
              <Button
                loading={busy || running}
                onClick={() => void onRender()}
                disabled={running || busy}
              >
                {translate('Make private preview')}
              </Button>
            )}
          </>
        )}
        <details className="guided-source-details">
          <summary>{translate('Sources')}</summary>
          {lesson.input?.passages.map((passage) => (
            <p key={passage.passageId}>{passage.text}</p>
          ))}
        </details>
        {lesson.review?.issues.length || lesson.visualReview?.issues.length ? (
          <Stack gap="xs">
            <Text fw={600}>{translate('Review findings')}</Text>
            {[...(lesson.review?.issues ?? []), ...(lesson.visualReview?.issues ?? [])].map(
              (issue) => (
                <Alert
                  key={issue.issueId}
                  color={issue.severity === 'minor' ? 'gray' : 'orange'}
                  title={issue.criterion}
                >
                  {issue.observed} {issue.suggestedFix}
                </Alert>
              ),
            )}
          </Stack>
        ) : null}
        <div className="guided-usage">
          <Text fw={600} size="sm">
            {translate('Actual reported token usage')}
          </Text>
          <Text size="xs">
            {translate('Input')}: {lesson.usage.inputTokens.toLocaleString()} ·{' '}
            {translate('Output')}: {lesson.usage.outputTokens.toLocaleString()}
          </Text>
          <Text size="xs" c="dimmed">
            {translate(
              'Estimated clean run: 20–40k text tokens. Image inputs are counted separately.',
            )}
          </Text>
          <Text size="xs" c="dimmed">
            {translate(
              'Run limits: 90k input and 30k output tokens. Reviewing later edits uses a separate run allowance. These are limits, not actual usage.',
            )}
          </Text>
          {lesson.status === LessonStatus.USAGE_UNCERTAIN && (
            <Text size="xs">{translate('Unknown usage remains reserved.')}</Text>
          )}
        </div>
      </Stack>
      <Stack gap="md" className="guided-preview-panel">
        <Group justify="space-between">
          <Text fw={600}>{translate('Actual lesson preview')}</Text>
          <Badge variant="outline">{translate('Private draft')}</Badge>
        </Group>
        {lesson.manifest && plan ? (
          <>
            <Select
              label={translate('Preview scene')}
              value={preview?.sceneId ?? null}
              data={plan.scenes.map((item) => ({ value: item.sceneId, label: item.title }))}
              onChange={(value) => {
                if (value) {
                  void onPreviewScene(value);
                }
              }}
              disabled={busy}
            />
            <Select
              label={translate('Preview phase')}
              value={previewPhase}
              data={previewPhases.map((phase) => ({
                value: phase,
                label: translate(
                  phase === LessonPhase.WORKED
                    ? 'Worked answer'
                    : phase === LessonPhase.TRY
                      ? 'Try'
                      : phase === LessonPhase.PREDICT
                        ? 'Predict'
                        : 'Watch',
                ),
              }))}
              onChange={(phase) => {
                if (preview && previewPhases.some((candidate) => candidate === phase)) {
                  void onPreviewScene(
                    preview.sceneId,
                    previewPhases.find((candidate) => candidate === phase),
                  );
                }
              }}
              disabled={busy || !preview}
            />
            {preview && (
              <GuidedLessonMedia
                userId={userId}
                classId={lesson.classId}
                lessonId={lesson.id}
                releaseId={null}
                projection={preview}
                paused={busy}
                onFrameChange={receiveFrame}
                onReadyChange={receivePreviewReady}
              />
            )}
            {preview && (
              <Button
                variant="light"
                disabled={readyPreviewKey !== previewKey || busy}
                onClick={() => {
                  const key = `${preview.sceneId}:${preview.phase}`;
                  setInspectedScenes((current) =>
                    current.includes(key) ? current : [...current, key],
                  );
                }}
              >
                {translate('I reviewed this scene')}
              </Button>
            )}
            <Text size="xs" c="dimmed">
              {inspectedScenes.length} / {requiredPreviewScenes.length}{' '}
              {translate('Scene phases reviewed')}
            </Text>
            {preview && (
              <GuidedLessonEvidence
                userId={userId}
                classId={lesson.classId}
                lessonId={lesson.id}
                manifestHash={preview.renderManifestHash}
                evidence={lesson.manifest.evidence}
                reviewedIds={reviewedEvidenceIds}
                busy={busy}
                onReview={(evidenceId) => {
                  setReviewedEvidenceIds((current) =>
                    current.includes(evidenceId) ? current : [...current, evidenceId],
                  );
                }}
              />
            )}
            <Checkbox
              checked={previewRead}
              onChange={(event) => {
                setPreviewRead(event.currentTarget.checked);
              }}
              label={translate(
                'I watched and listened to this exact preview, including its checkpoints.',
              )}
              disabled={!inspectedEveryPhase || !inspectedEveryEvidence || busy || running}
            />
            {!lesson.previewApproved && (
              <Button
                disabled={
                  !previewRead ||
                  !inspectedEveryPhase ||
                  !inspectedEveryEvidence ||
                  busy ||
                  running ||
                  dirty
                }
                onClick={() => void onApprovePreview(reviewedEvidenceIds)}
              >
                {translate('Approve preview')}
              </Button>
            )}
            <Button
              disabled={
                !preview ||
                !lesson.previewApproved ||
                busy ||
                running ||
                dirty ||
                lesson.status === LessonStatus.RELEASED
              }
              onClick={() => void onRelease()}
            >
              {translate('Release to class')}
            </Button>
            {lesson.releaseId && (
              <Button
                variant="outline"
                color="red"
                disabled={busy}
                onClick={() => void onWithdraw()}
              >
                {translate('Withdraw release')}
              </Button>
            )}
          </>
        ) : (
          <div className="guided-empty">
            <Text c="dimmed">{translate('The preview is not ready yet.')}</Text>
          </div>
        )}
      </Stack>
    </div>
  );
}
