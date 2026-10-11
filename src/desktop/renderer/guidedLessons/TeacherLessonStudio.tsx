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
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  LessonStatus,
  LessonPhase,
  LessonPlanSchema,
  SourcePassageKind,
  LessonTemplateKind,
  type GuidedLessonDetail,
  type LearnerProjection,
  type LessonPlan,
  type Scene,
} from '#contracts/GuidedLessons.js';
import { serializeLessonValue } from '#contracts/LessonValue.js';
import { useLocale } from '../localization/UseLocale.js';
import { GuidedLessonMedia } from './GuidedLessonMedia.js';
import { GuidedLessonEvidence } from './GuidedLessonEvidence.js';
import { LessonStoryboard } from './LessonStoryboard.js';
import { isGuidedLessonRunning, readLessonStatusLabel } from './GuidedLessonLabels.js';
import './TeacherLessonStudio.css';

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

const InspectorPanel = {
  NARRATION: 'narration',
  PYTHON: 'python',
  SOURCES: 'sources',
  POINTS: 'points',
  CHECKPOINTS: 'checkpoints',
  EVIDENCE: 'evidence',
} as const;

type InspectorPanel = (typeof InspectorPanel)[keyof typeof InspectorPanel];

const InspectorTabs = [
  { value: InspectorPanel.NARRATION, label: 'Narration' },
  { value: InspectorPanel.PYTHON, label: 'Python' },
  { value: InspectorPanel.SOURCES, label: 'Sources' },
  { value: InspectorPanel.POINTS, label: 'Key points' },
  { value: InspectorPanel.CHECKPOINTS, label: 'Checkpoints' },
  { value: InspectorPanel.EVIDENCE, label: 'Rendered review evidence' },
];

const CheckpointText = { QUESTION: 'question', HINT: 'hint', WORKED: 'worked' } as const;
type CheckpointText = (typeof CheckpointText)[keyof typeof CheckpointText];

interface StudioReview {
  scope: string;
  scriptScenes: string[];
  scriptRead: boolean;
  previewRead: boolean;
  previewPhases: string[];
  readyPreviewKey: string | null;
  evidenceIds: string[];
}

function createStudioReview(scope: string): StudioReview {
  return {
    scope,
    scriptScenes: [],
    scriptRead: false,
    previewRead: false,
    previewPhases: [],
    readyPreviewKey: null,
    evidenceIds: [],
  };
}

/** Present text may not be whitespace; source explanations require narration, while code/checkpoint scenes may omit it. */
export function canReviewLessonPlan(plan: LessonPlan | null): boolean {
  if (!plan || !LessonPlanSchema.safeParse(plan).success) {
    return false;
  }
  if (
    plan.scenes.some(
      (scene) =>
        scene.kind === LessonTemplateKind.SOURCE_EXPLANATION && scene.narration.length === 0,
    )
  ) {
    return false;
  }
  const text = [
    plan.title,
    plan.objective,
    plan.audience,
    plan.reflectionPrompt,
    ...plan.teacherQuestions,
    ...plan.scenes.flatMap((scene) => [
      scene.title,
      ...scene.narration.map((beat) => beat.text),
      ...(scene.kind === LessonTemplateKind.SOURCE_EXPLANATION
        ? scene.params.points.map((point) => point.text)
        : []),
    ]),
    ...plan.checkpoints.flatMap((checkpoint) => [
      checkpoint.question,
      ...checkpoint.options.map((option) => option.text),
      ...checkpoint.hints.map((hint) => hint.text),
      ...checkpoint.workedExplanation.map((beat) => beat.text),
    ]),
  ];
  return text.every((value) => value.trim().length > 0);
}

/** Bind scene playback to the current content, revision and canonical manifest SHA-256. */
export function isLessonPreviewCurrent(
  lesson: GuidedLessonDetail,
  preview: LearnerProjection | null,
  sceneId: string,
  phase: LessonPhase,
  manifestHash: string | null,
): preview is LearnerProjection {
  return Boolean(
    preview &&
    lesson.manifest &&
    lesson.contentHash &&
    manifestHash &&
    preview.renderManifestHash === manifestHash &&
    preview.contentHash === lesson.contentHash &&
    lesson.manifest.contentHash === lesson.contentHash &&
    preview.revisionId === lesson.manifest.revisionId &&
    preview.sceneId === sceneId &&
    preview.phase === phase,
  );
}

function readScenePhases(plan: LessonPlan | null, sceneId: string): LessonPhase[] {
  const checkpoint = plan?.checkpoints.find((item) => item.sceneId === sceneId);
  return checkpoint ? [checkpoint.phase, LessonPhase.WORKED] : [LessonPhase.WATCH];
}

/** Scene review stays explicit; only the existing backend commands approve or release exact content. */
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
  const manifestIdentity = lesson.manifest ? JSON.stringify(lesson.manifest) : '';
  const reviewScope = `${userId}:${lesson.id}:${lesson.contentHash ?? ''}:${String(lesson.version)}:${manifestIdentity}`;
  const [plan, setPlan] = useState(lesson.plan);
  const [sceneId, setSceneId] = useState(lesson.plan?.scenes[0]?.sceneId ?? '');
  const [panel, setPanel] = useState<InspectorPanel>(InspectorPanel.NARRATION);
  const [phaseSelection, setPhaseSelection] = useState<{
    sceneId: string;
    phase: LessonPhase;
  } | null>(null);
  const [reviewState, setReviewState] = useState<StudioReview>(() =>
    createStudioReview(reviewScope),
  );
  const review = reviewState.scope === reviewScope ? reviewState : createStudioReview(reviewScope);
  const requestedPreview = useRef<string | null>(null);
  const [manifestDigest, setManifestDigest] = useState<{
    identity: string;
    hash: string | null;
    failed: boolean;
  } | null>(null);
  const [manifestCheckAttempt, setManifestCheckAttempt] = useState(0);
  const manifestHash = manifestDigest?.identity === manifestIdentity ? manifestDigest.hash : null;
  const manifestCheckFailed =
    manifestDigest?.identity === manifestIdentity && manifestDigest.failed;
  const scene = plan?.scenes.find((item) => item.sceneId === sceneId);
  const hasApprovedCode = Boolean(lesson.input?.codeBlocks.length);
  const inspectorTabs = InspectorTabs.filter(
    (tab) =>
      (tab.value !== InspectorPanel.PYTHON || hasApprovedCode) &&
      (tab.value !== InspectorPanel.POINTS ||
        scene?.kind === LessonTemplateKind.SOURCE_EXPLANATION) &&
      (tab.value !== InspectorPanel.CHECKPOINTS || Boolean(plan?.checkpoints.length)),
  );
  const activePanel = inspectorTabs.some((tab) => tab.value === panel)
    ? panel
    : InspectorPanel.NARRATION;
  const sceneIndex = plan?.scenes.findIndex((item) => item.sceneId === sceneId) ?? -1;
  const checkpoint = plan?.checkpoints.find((item) => item.sceneId === sceneId);
  const dirty = JSON.stringify(plan) !== JSON.stringify(lesson.plan);
  const validPlan = canReviewLessonPlan(plan);
  const running = isGuidedLessonRunning(lesson.status);
  const canEdit =
    !busy &&
    !running &&
    lesson.status !== LessonStatus.RELEASED &&
    lesson.status !== LessonStatus.USAGE_UNCERTAIN;
  const previewPhases = readScenePhases(plan, sceneId);
  const selectedPhase =
    phaseSelection?.sceneId === sceneId && previewPhases.includes(phaseSelection.phase)
      ? phaseSelection.phase
      : (previewPhases[0] ?? LessonPhase.WATCH);
  const currentPreview =
    !dirty && isLessonPreviewCurrent(lesson, preview, sceneId, selectedPhase, manifestHash)
      ? preview
      : null;
  const previewKey = currentPreview
    ? `${reviewScope}:${currentPreview.renderManifestHash}:${sceneId}:${selectedPhase}`
    : '';
  const requiredPreviewPhases =
    plan?.scenes.flatMap((item) =>
      readScenePhases(plan, item.sceneId).map((phase) => `${item.sceneId}:${phase}`),
    ) ?? [];
  const reviewedEveryPhase =
    requiredPreviewPhases.length > 0 &&
    requiredPreviewPhases.every((key) => review.previewPhases.includes(key));
  const reviewedEveryEvidence = Boolean(
    lesson.manifest?.evidence.length &&
    lesson.manifest.evidence.every((item) => review.evidenceIds.includes(item.evidenceId)),
  );
  const reviewedEveryScriptScene = Boolean(
    plan?.scenes.length && plan.scenes.every((item) => review.scriptScenes.includes(item.sceneId)),
  );
  const canMakePreview =
    lesson.scriptApproved &&
    (!lesson.manifest ||
      lesson.status === LessonStatus.FAILED ||
      lesson.status === LessonStatus.BUDGET_BLOCKED);
  const sourceIds = new Set([
    ...(scene?.sourceRefs.map((ref) => ref.passageId) ?? []),
    ...(scene?.kind === LessonTemplateKind.SOURCE_EXPLANATION
      ? scene.params.points.flatMap((point) => point.sourceRefs.map((ref) => ref.passageId))
      : []),
    ...(scene?.narration.flatMap((beat) => beat.sourceRefs.map((ref) => ref.passageId)) ?? []),
    ...(checkpoint?.sourceRefs.map((ref) => ref.passageId) ?? []),
    ...(checkpoint?.hints.flatMap((hint) => hint.sourceRefs.map((ref) => ref.passageId)) ?? []),
    ...(checkpoint?.workedExplanation.flatMap((beat) =>
      beat.sourceRefs.map((ref) => ref.passageId),
    ) ?? []),
  ]);
  const selectedSources =
    lesson.input?.passages.filter(
      (passage) =>
        sourceIds.has(passage.passageId) ||
        passage.correctsPassageIds.some((id) => sourceIds.has(id)),
    ) ?? [];
  const otherSources =
    lesson.input?.passages.filter(
      (passage) => !selectedSources.some((selected) => selected.passageId === passage.passageId),
    ) ?? [];
  const traceId =
    scene?.kind === LessonTemplateKind.CODE_TRACE || scene?.kind === LessonTemplateKind.CHECKPOINT
      ? scene.params.traceId
      : null;
  const trace = lesson.input?.traces.find((item) => item.traceId === traceId);
  const selectedCode = lesson.input?.codeBlocks.find(
    (item) => item.codeBlockId === trace?.codeBlockId,
  );

  const receiveFrame = useCallback((): void => {}, []);
  const receivePreviewReady = useCallback(
    (ready: boolean): void => {
      setReviewState((current) =>
        current.scope === reviewScope
          ? { ...current, readyPreviewKey: ready && previewKey ? previewKey : null }
          : current,
      );
    },
    [previewKey, reviewScope],
  );

  useEffect(() => {
    setPlan(lesson.plan);
    setReviewState(createStudioReview(reviewScope));
    setSceneId((current) =>
      lesson.plan?.scenes.some((item) => item.sceneId === current)
        ? current
        : (lesson.plan?.scenes[0]?.sceneId ?? ''),
    );
  }, [userId, lesson.id, lesson.contentHash, lesson.version, manifestIdentity]);

  useEffect(() => {
    let cancelled = false;
    if (!lesson.manifest) {
      setManifestDigest(null);
      return;
    }
    const verifyManifest = async (): Promise<void> => {
      try {
        const bytes = new TextEncoder().encode(serializeLessonValue(lesson.manifest));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (!cancelled) {
          setManifestDigest({ identity: manifestIdentity, hash, failed: false });
        }
      } catch {
        if (!cancelled) {
          setManifestDigest({ identity: manifestIdentity, hash: null, failed: true });
        }
      }
    };
    void verifyManifest();
    return () => {
      cancelled = true;
    };
  }, [manifestIdentity, manifestCheckAttempt]);

  useEffect(() => {
    if (!lesson.manifest || !sceneId || dirty) {
      requestedPreview.current = null;
      return;
    }
    const key = `${userId}:${lesson.id}:${lesson.contentHash ?? ''}:${manifestIdentity}:${sceneId}:${selectedPhase}`;
    if (requestedPreview.current === key) {
      return;
    }
    requestedPreview.current = key;
    void onPreviewScene(sceneId, selectedPhase);
  }, [
    userId,
    lesson.id,
    lesson.contentHash,
    manifestIdentity,
    sceneId,
    selectedPhase,
    dirty,
    onPreviewScene,
  ]);

  const clearLocalReview = (): void => {
    setReviewState(createStudioReview(reviewScope));
  };
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
    clearLocalReview();
  };
  const replaceSceneTitle = (title: string): void => {
    setPlan((current) =>
      current
        ? {
            ...current,
            scenes: current.scenes.map((item) =>
              item.sceneId === sceneId ? { ...item, title } : item,
            ),
          }
        : null,
    );
    clearLocalReview();
  };
  const replaceCheckpointText = (kind: CheckpointText, id: string, text: string): void => {
    setPlan((current) =>
      current
        ? {
            ...current,
            checkpoints: current.checkpoints.map((item) =>
              item.sceneId !== sceneId
                ? item
                : kind === CheckpointText.QUESTION
                  ? { ...item, question: text }
                  : kind === CheckpointText.HINT
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
    clearLocalReview();
  };
  const selectScene = (item: Scene): void => {
    setSceneId(item.sceneId);
  };
  const renderNarration = (): ReactElement => (
    <Stack gap="md">
      <TextInput
        label={translate('Lesson title')}
        value={plan?.title ?? ''}
        maxLength={120}
        disabled={!canEdit}
        onChange={(event) => {
          const title = event.currentTarget.value;
          setPlan((current) => (current ? { ...current, title } : null));
          clearLocalReview();
        }}
      />
      {scene && (
        <TextInput
          label={translate('Scene title')}
          value={scene.title}
          maxLength={120}
          disabled={!canEdit}
          onChange={(event) => {
            replaceSceneTitle(event.currentTarget.value);
          }}
        />
      )}
      {scene?.narration.map((beat, index) => (
        <Textarea
          key={beat.beatId}
          label={`${translate('Narration')} ${String(index + 1)}`}
          value={beat.text}
          maxLength={1200}
          minRows={3}
          disabled={!canEdit}
          error={
            !beat.text.trim() ? translate('Enter text before saving or approving.') : undefined
          }
          onChange={(event) => {
            replaceSceneNarration(beat.beatId, event.currentTarget.value);
          }}
        />
      ))}
      {scene?.narration.length === 0 && (
        <Text size="sm" c="dimmed">
          {translate('This scene has no narration.')}
        </Text>
      )}
      {plan && (
        <details className="studio-lesson-notes">
          <summary>{translate('Reflection and teacher questions')}</summary>
          <Text size="sm" mt="sm">
            {plan.reflectionPrompt}
          </Text>
          {plan.teacherQuestions.length > 0 && (
            <ol>
              {plan.teacherQuestions.map((question, index) => (
                <li key={`${String(index)}:${question}`}>{question}</li>
              ))}
            </ol>
          )}
        </details>
      )}
    </Stack>
  );
  const renderCheckpoint = (): ReactElement =>
    checkpoint ? (
      <Stack gap="md">
        <Textarea
          label={translate('Question')}
          value={checkpoint.question}
          maxLength={500}
          minRows={2}
          disabled={!canEdit}
          onChange={(event) => {
            replaceCheckpointText(
              CheckpointText.QUESTION,
              checkpoint.checkpointId,
              event.currentTarget.value,
            );
          }}
        />
        {checkpoint.options.length > 0 && (
          <ol className="studio-answer-options">
            {checkpoint.options.map((option) => (
              <li key={option.optionId}>{option.text}</li>
            ))}
          </ol>
        )}
        {checkpoint.hints.map((hint, index) => (
          <Textarea
            key={hint.hintId}
            label={`${translate('Hints')} ${String(index + 1)}`}
            value={hint.text}
            maxLength={500}
            disabled={!canEdit}
            onChange={(event) => {
              replaceCheckpointText(CheckpointText.HINT, hint.hintId, event.currentTarget.value);
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
              replaceCheckpointText(CheckpointText.WORKED, beat.beatId, event.currentTarget.value);
            }}
          />
        ))}
      </Stack>
    ) : (
      <Text size="sm" c="dimmed">
        {translate('This scene has no checkpoint.')}
      </Text>
    );

  return (
    <section className="lesson-scene-studio" aria-label={translate('Teacher studio')}>
      <header className="studio-header">
        <Text className="studio-eyebrow">
          {translate(lesson.scriptApproved ? 'Private preview review' : 'Script and checkpoints')}
        </Text>
        <Group gap="sm">
          <Badge variant="light">{translate(readLessonStatusLabel(lesson.status))}</Badge>
          <details className="studio-run-details">
            <summary>{translate('Run details')}</summary>
            <div>
              <Text fw={600} size="sm">
                {translate('Actual reported token usage')}
              </Text>
              <Text size="sm">
                {translate('Input')}: {lesson.usage.inputTokens.toLocaleString()} ·{' '}
                {translate('Output')}: {lesson.usage.outputTokens.toLocaleString()}
              </Text>
              {lesson.status === LessonStatus.USAGE_UNCERTAIN && (
                <Text size="sm">{translate('Unknown usage remains reserved.')}</Text>
              )}
              {Boolean(lesson.review?.issues.length || lesson.visualReview?.issues.length) && (
                <>
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
                </>
              )}
            </div>
          </details>
        </Group>
      </header>
      {manifestCheckFailed && (
        <Alert color="orange" role="alert">
          {translate('Preview identity could not be verified. Refresh this lesson.')}
        </Alert>
      )}
      {lesson.error && (
        <Alert color="orange" role="alert">
          {lesson.error}
        </Alert>
      )}
      {running && (
        <Group className="studio-running" role="status">
          <Text size="sm">{translate('No estimated progress is available for this stage.')}</Text>
          <Button
            variant="outline"
            color="red"
            size="xs"
            disabled={busy}
            onClick={() => void onCancel()}
          >
            {translate('Cancel run')}
          </Button>
        </Group>
      )}
      {[
        LessonStatus.FAILED,
        LessonStatus.CANCELLED,
        LessonStatus.BUDGET_BLOCKED,
        LessonStatus.NEEDS_TEACHER_INPUT,
      ].some((status) => status === lesson.status) &&
        !lesson.scriptApproved && (
          <Button
            className="studio-retry"
            variant="outline"
            disabled={busy || dirty || (!validPlan && Boolean(plan))}
            onClick={() => void onRetry()}
          >
            {translate('Retry with a new allowance')}
          </Button>
        )}
      <Text className="studio-live-status" role="status">
        {translate('Scene')} {sceneIndex + 1}: {scene?.title ?? translate('Preparing lesson…')}
      </Text>
      <div className="studio-workspace">
        <div className={lesson.manifest ? 'studio-stage studio-stage-has-preview' : 'studio-stage'}>
          <div className="studio-canvas-toolbar">
            <div>
              <span className="studio-scene-number">{String(sceneIndex + 1).padStart(2, '0')}</span>
              <h3>{scene?.title ?? translate('Preparing lesson…')}</h3>
            </div>
            <span>
              {translate(currentPreview ? 'Actual lesson preview' : 'Script illustration')}
            </span>
          </div>
          <div
            className="studio-canvas"
            role="region"
            tabIndex={0}
            aria-label={translate(currentPreview ? 'Actual lesson preview' : 'Script illustration')}
          >
            {currentPreview ? (
              <GuidedLessonMedia
                key={previewKey}
                userId={userId}
                classId={lesson.classId}
                lessonId={lesson.id}
                releaseId={null}
                projection={currentPreview}
                paused={busy || dirty}
                onFrameChange={receiveFrame}
                onReadyChange={receivePreviewReady}
              />
            ) : scene ? (
              <LessonStoryboard scene={scene} input={lesson.input} checkpoint={checkpoint} />
            ) : (
              <div className="studio-waiting">
                <span aria-hidden="true">▧</span>
                <Text>{translate('Preparing lesson…')}</Text>
              </div>
            )}
          </div>
          {lesson.manifest && (
            <div className="studio-preview-controls">
              <Select
                label={translate('Preview phase')}
                value={selectedPhase}
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
                onChange={(value) => {
                  const phase = previewPhases.find((candidate) => candidate === value);
                  if (phase) {
                    setPhaseSelection({ sceneId, phase });
                  }
                }}
                disabled={busy || dirty}
              />
              <Button
                variant="light"
                disabled={!currentPreview || review.readyPreviewKey !== previewKey || busy || dirty}
                onClick={() => {
                  if (currentPreview && review.readyPreviewKey === previewKey && !dirty) {
                    const key = `${currentPreview.sceneId}:${currentPreview.phase}`;
                    setReviewState((current) =>
                      current.scope === reviewScope
                        ? {
                            ...current,
                            previewRead: false,
                            previewPhases: current.previewPhases.includes(key)
                              ? current.previewPhases
                              : [...current.previewPhases, key],
                          }
                        : current,
                    );
                  }
                }}
              >
                {translate('I reviewed this scene')}
              </Button>
              {!currentPreview && (
                <Button
                  variant="subtle"
                  disabled={busy || dirty}
                  onClick={() => {
                    if (manifestCheckFailed) {
                      setManifestCheckAttempt((attempt) => attempt + 1);
                    }
                    void onPreviewScene(sceneId, selectedPhase);
                  }}
                >
                  {translate('Load this scene')}
                </Button>
              )}
              <Text size="sm" c="dimmed">
                {review.previewPhases.length} / {requiredPreviewPhases.length}{' '}
                {translate('Scene phases reviewed')}
              </Text>
            </div>
          )}
          {plan && (
            <nav
              className="studio-filmstrip"
              aria-label={translate('Scenes in this lesson')}
              onKeyDown={(event) => {
                const target = event.target;
                if (
                  (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
                  !(target instanceof HTMLButtonElement)
                ) {
                  return;
                }
                const currentIndex = plan.scenes.findIndex(
                  (item) => item.sceneId === target.dataset.sceneId,
                );
                const nextIndex =
                  (currentIndex + (event.key === 'ArrowRight' ? 1 : plan.scenes.length - 1)) %
                  plan.scenes.length;
                const next = plan.scenes[nextIndex];
                if (next) {
                  event.preventDefault();
                  setSceneId(next.sceneId);
                  event.currentTarget
                    .querySelectorAll<HTMLButtonElement>('button')
                    [nextIndex]?.focus();
                }
              }}
            >
              {plan.scenes.map((item, index) => (
                <button
                  key={item.sceneId}
                  type="button"
                  className="studio-scene-button"
                  data-scene-id={item.sceneId}
                  aria-label={`${translate('Scene')} ${String(index + 1)}: ${item.title}`}
                  aria-current={item.sceneId === sceneId ? 'true' : undefined}
                  onClick={() => {
                    selectScene(item);
                  }}
                >
                  <LessonStoryboard
                    scene={item}
                    input={lesson.input}
                    checkpoint={plan.checkpoints.find(
                      (candidate) => candidate.sceneId === item.sceneId,
                    )}
                    compact
                  />
                  <span className="studio-scene-label">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{item.title}</strong>
                    <span
                      className={
                        review.scriptScenes.includes(item.sceneId)
                          ? 'studio-review-dot reviewed'
                          : 'studio-review-dot'
                      }
                      aria-label={translate(
                        review.scriptScenes.includes(item.sceneId)
                          ? 'Scene reviewed'
                          : 'Scene not reviewed',
                      )}
                    >
                      {review.scriptScenes.includes(item.sceneId) ? '✓' : ''}
                    </span>
                  </span>
                </button>
              ))}
            </nav>
          )}
        </div>
        <aside className="studio-inspector" aria-label={translate('Scene content and review')}>
          <div className="studio-inspector-heading">
            <Text fw={600} size="sm">
              {translate('Scene')} {sceneIndex + 1}
            </Text>
            <Badge variant="light" color={review.scriptScenes.includes(sceneId) ? 'green' : 'gray'}>
              {translate(
                review.scriptScenes.includes(sceneId) ? 'Scene reviewed' : 'Scene not reviewed',
              )}
            </Badge>
          </div>
          <nav className="studio-inspector-tabs" aria-label={translate('Scene content')}>
            {inspectorTabs.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={activePanel === value}
                disabled={value === InspectorPanel.EVIDENCE && !lesson.manifest}
                onClick={() => {
                  setPanel(value);
                }}
              >
                {translate(label)}
              </button>
            ))}
          </nav>
          <div
            className="studio-inspector-content"
            role="region"
            tabIndex={0}
            aria-label={translate('Scene content')}
          >
            {activePanel === InspectorPanel.NARRATION && renderNarration()}
            {activePanel === InspectorPanel.CHECKPOINTS && renderCheckpoint()}
            {activePanel === InspectorPanel.POINTS &&
              scene?.kind === LessonTemplateKind.SOURCE_EXPLANATION && (
                <>
                  <Text size="sm" c="dimmed">
                    {translate('Read-only key points from the approved script.')}
                  </Text>
                  <ol className="studio-inspector-points">
                    {scene.params.points.map((point) => (
                      <li key={point.pointId}>{point.text}</li>
                    ))}
                  </ol>
                </>
              )}
            {activePanel === InspectorPanel.PYTHON &&
              (selectedCode ? (
                <>
                  <Text size="sm" c="dimmed">
                    {translate('Approved Python example')}
                  </Text>
                  <pre className="studio-inspector-code">
                    {selectedCode.lines.map((line) => line.text).join('\n')}
                  </pre>
                  <Text size="sm" c="dimmed">
                    {translate('Read-only code from the approved lesson input.')}
                  </Text>
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {translate('This scene has no Python example.')}
                </Text>
              ))}
            {activePanel === InspectorPanel.SOURCES && (
              <div className="studio-source-list">
                {selectedSources.map((passage, index) => (
                  <details
                    key={passage.passageId}
                    className={
                      passage.kind === SourcePassageKind.SOURCE_TEXT ? '' : 'studio-correction'
                    }
                  >
                    <summary>
                      {translate(
                        passage.kind === SourcePassageKind.SOURCE_TEXT
                          ? 'Source passage'
                          : 'Correction',
                      )}{' '}
                      {index + 1}
                    </summary>
                    <p>{passage.text}</p>
                  </details>
                ))}
                {selectedSources.length === 0 && (
                  <Text size="sm" c="dimmed">
                    {translate('No source passages are attached to this scene.')}
                  </Text>
                )}
                {otherSources.length > 0 && (
                  <details>
                    <summary>{translate('Other lesson sources')}</summary>
                    {otherSources.map((passage) => (
                      <div key={passage.passageId}>
                        {passage.kind !== SourcePassageKind.SOURCE_TEXT && (
                          <Text fw={600} size="sm" mt="sm">
                            {translate('Correction')}
                          </Text>
                        )}
                        <p>{passage.text}</p>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            )}
            {activePanel === InspectorPanel.EVIDENCE && lesson.manifest && (
              <>
                {currentPreview ? (
                  <GuidedLessonEvidence
                    userId={userId}
                    classId={lesson.classId}
                    lessonId={lesson.id}
                    manifestHash={currentPreview.renderManifestHash}
                    evidence={lesson.manifest.evidence}
                    reviewedIds={review.evidenceIds}
                    busy={busy || dirty}
                    onReview={(evidenceId) => {
                      if (
                        !dirty &&
                        lesson.manifest?.evidence.some((item) => item.evidenceId === evidenceId)
                      ) {
                        setReviewState((current) =>
                          current.scope === reviewScope
                            ? {
                                ...current,
                                previewRead: false,
                                evidenceIds: current.evidenceIds.includes(evidenceId)
                                  ? current.evidenceIds
                                  : [...current.evidenceIds, evidenceId],
                              }
                            : current,
                        );
                      }
                    }}
                  />
                ) : (
                  <Text size="sm" c="dimmed">
                    {translate('Load the current preview before reviewing its evidence.')}
                  </Text>
                )}
              </>
            )}
          </div>
          <div
            className="studio-review-controls"
            role="region"
            tabIndex={0}
            aria-label={translate('Review and approval')}
          >
            {dirty && (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  {translate('Edits require a new review and approval before media is made.')}
                </Text>
                {!validPlan && (
                  <Text size="sm" c="orange" role="alert">
                    {translate('Enter text before saving or approving.')}
                  </Text>
                )}
                <Button
                  loading={busy}
                  disabled={!canEdit || !validPlan}
                  onClick={() => {
                    if (plan && canReviewLessonPlan(plan) && canEdit) {
                      void onSavePlan(plan);
                    }
                  }}
                >
                  {translate('Save edits and review again')}
                </Button>
              </Stack>
            )}
            {plan && !lesson.scriptApproved && (
              <>
                <Checkbox
                  checked={review.scriptScenes.includes(sceneId)}
                  disabled={!scene || !canEdit || dirty || !validPlan}
                  label={translate('I reviewed this script scene.')}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    if (!dirty && validPlan && scene) {
                      setReviewState((current) =>
                        current.scope === reviewScope
                          ? {
                              ...current,
                              scriptRead: false,
                              scriptScenes: checked
                                ? [...new Set([...current.scriptScenes, sceneId])]
                                : current.scriptScenes.filter((id) => id !== sceneId),
                            }
                          : current,
                      );
                    }
                  }}
                />
                <Text size="sm" c="dimmed">
                  {review.scriptScenes.length} / {plan.scenes.length}{' '}
                  {translate('Script scenes reviewed')}
                </Text>
                <Checkbox
                  checked={review.scriptRead}
                  label={translate(
                    plan.checkpoints.length > 0
                      ? 'I reviewed the script, sources, hints and worked explanations.'
                      : 'I reviewed the script and sources.',
                  )}
                  disabled={!reviewedEveryScriptScene || !canEdit || dirty || !validPlan}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setReviewState((current) =>
                      current.scope === reviewScope ? { ...current, scriptRead: checked } : current,
                    );
                  }}
                />
                <Button
                  disabled={
                    !review.scriptRead ||
                    !reviewedEveryScriptScene ||
                    !canEdit ||
                    dirty ||
                    !validPlan ||
                    lesson.status !== LessonStatus.AWAITING_SCRIPT_APPROVAL
                  }
                  onClick={() => {
                    if (review.scriptRead && reviewedEveryScriptScene && !dirty && validPlan) {
                      void onApproveScript();
                    }
                  }}
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
                disabled={running || busy || dirty || !validPlan}
                onClick={() => {
                  if (!dirty && validPlan && lesson.scriptApproved) {
                    void onRender();
                  }
                }}
              >
                {translate('Make private preview')}
              </Button>
            )}
            {lesson.manifest && (
              <>
                <Checkbox
                  checked={review.previewRead}
                  label={translate(
                    'I watched and listened to this exact preview, including its checkpoints.',
                  )}
                  disabled={
                    !currentPreview ||
                    !reviewedEveryPhase ||
                    !reviewedEveryEvidence ||
                    busy ||
                    running ||
                    dirty
                  }
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setReviewState((current) =>
                      current.scope === reviewScope
                        ? { ...current, previewRead: checked }
                        : current,
                    );
                  }}
                />
                {!lesson.previewApproved && (
                  <Button
                    disabled={
                      !currentPreview ||
                      !review.previewRead ||
                      !reviewedEveryPhase ||
                      !reviewedEveryEvidence ||
                      busy ||
                      running ||
                      dirty ||
                      lesson.status !== LessonStatus.PREVIEW_READY
                    }
                    onClick={() => {
                      if (
                        currentPreview &&
                        review.previewRead &&
                        reviewedEveryPhase &&
                        reviewedEveryEvidence &&
                        !dirty
                      ) {
                        void onApprovePreview(review.evidenceIds);
                      }
                    }}
                  >
                    {translate('Approve preview')}
                  </Button>
                )}
                <Button
                  disabled={
                    !currentPreview ||
                    !lesson.previewApproved ||
                    busy ||
                    running ||
                    dirty ||
                    lesson.status === LessonStatus.RELEASED
                  }
                  onClick={() => {
                    if (currentPreview && lesson.previewApproved && !dirty) {
                      void onRelease();
                    }
                  }}
                >
                  {translate('Release to class')}
                </Button>
              </>
            )}
            {lesson.releaseId && (
              <Button
                variant="outline"
                color="red"
                disabled={busy || dirty}
                onClick={() => void onWithdraw()}
              >
                {translate('Withdraw release')}
              </Button>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
