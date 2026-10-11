// @vitest-environment happy-dom
import { createHash, webcrypto } from 'node:crypto';
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  LessonPhase,
  LessonStatus,
  SourcePassageKind,
  type LearnerProjection,
  type RenderManifest,
} from '#contracts/GuidedLessons.js';
import { serializeLessonValue } from '#contracts/LessonValue.js';
import type { GuidedLessonEvidence } from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonEvidence.js';
import type { GuidedLessonMediaProps } from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js';
import {
  TeacherLessonStudio,
  canReviewLessonPlan,
} from '../../../../src/desktop/renderer/guidedLessons/TeacherLessonStudio.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import {
  createLessonFixture,
  hashText,
} from '../../../server/features/guidedLessons/LessonFixture.js';
import { createTeacherLessonPreviewFixture } from '../../../server/features/guidedLessons/LessonPlaybackFixture.js';
import { createSourceLessonFixture } from '../../../server/features/guidedLessons/SourceLessonFixture.js';

type StudioProps = ComponentProps<typeof TeacherLessonStudio>;

vi.mock('../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js', () => ({
  GuidedLessonMedia: (props: GuidedLessonMediaProps) =>
    createElement(
      'section',
      { 'aria-label': 'Mocked lesson media' },
      createElement(
        'button',
        { type: 'button', onClick: () => props.onReadyChange?.(true) },
        'Make mocked preview ready',
      ),
      createElement(
        'button',
        { type: 'button', onClick: () => props.onReadyChange?.(false) },
        'Make mocked preview unavailable',
      ),
    ),
}));

vi.mock('../../../../src/desktop/renderer/guidedLessons/GuidedLessonEvidence.js', () => ({
  GuidedLessonEvidence: (props: ComponentProps<typeof GuidedLessonEvidence>) =>
    createElement(
      'section',
      { 'aria-label': 'Mocked lesson evidence' },
      createElement(
        'p',
        null,
        `Mocked reviewed evidence: ${props.reviewedIds.join(', ') || 'none'}`,
      ),
      ...props.evidence.map((item) =>
        createElement(
          'button',
          {
            key: item.evidenceId,
            type: 'button',
            disabled: props.busy,
            onClick: () => {
              props.onReview(item.evidenceId);
            },
          },
          `Review mocked evidence ${item.evidenceId}`,
        ),
      ),
    ),
}));

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
});
afterAll(() => {
  Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});
beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function createProps(): StudioProps {
  const fixture = createLessonFixture();
  return {
    userId: 'teacher-1',
    lesson: {
      id: 'lesson-1',
      classId: 'class-1',
      title: fixture.plan.title,
      status: LessonStatus.AWAITING_SCRIPT_APPROVAL,
      version: 1,
      language: 'en',
      updatedAt: '2026-10-09T21:00:00.000Z',
      releaseId: null,
      error: null,
      input: fixture.input,
      plan: fixture.plan,
      contentHash: fixture.record.contentHash,
      review: null,
      visualReview: null,
      manifest: null,
      scriptApproved: false,
      previewApproved: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        generationAttempts: 0,
        speechCharacters: 0,
        speechSeconds: 0,
        artifactBytes: 0,
      },
    },
    preview: null,
    busy: false,
    onSavePlan: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onSavePlan']>()
      .mockResolvedValue(),
    onApproveScript: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onRender: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onApprovePreview: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onApprovePreview']>()
      .mockResolvedValue(),
    onRelease: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onWithdraw: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onCancel: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onRetry: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onPreviewScene: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onPreviewScene']>()
      .mockResolvedValue(),
  };
}

it('shows reported usage without a fixed estimate or obsolete token cap', () => {
  const props = createProps();
  render(
    createStudio({
      ...props,
      lesson: {
        ...props.lesson,
        usage: { ...props.lesson.usage, inputTokens: 12345, outputTokens: 678 },
      },
    }),
  );
  fireEvent.click(screen.getByText('Run details'));
  expect(screen.getByText('Input: 12,345 · Output: 678')).toBeTruthy();
  expect(screen.queryByText(/20–40k|90k input|30k output/)).toBeNull();
});

function createStudio(props: StudioProps) {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, {
      children: createElement(TeacherLessonStudio, props),
    }),
  });
}

function selectScene(props: StudioProps, sceneId: string): void {
  const scenes = props.lesson.plan?.scenes ?? [];
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  const scene = scenes[index];
  if (!scene) {
    throw new Error('The requested scene is missing from the fixture.');
  }
  fireEvent.click(
    screen.getByRole('button', { name: `Scene ${String(index + 1)}: ${scene.title}` }),
  );
}

function reviewScriptScenes(props: StudioProps): void {
  for (const scene of props.lesson.plan?.scenes ?? []) {
    selectScene(props, scene.sceneId);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' }));
  }
}

function createPreview(
  sceneId: string,
  phase: LessonPhase = LessonPhase.WATCH,
  manifest?: RenderManifest,
): LearnerProjection {
  return createTeacherLessonPreviewFixture(
    sceneId,
    phase,
    (value) => createHash('sha256').update(serializeLessonValue(value)).digest('hex'),
    manifest,
  );
}

function createPreviewProps(): StudioProps {
  const props = createProps();
  const fixture = createLessonFixture();
  return {
    ...props,
    lesson: {
      ...props.lesson,
      manifest: fixture.record.manifest,
      status: LessonStatus.PREVIEW_READY,
      scriptApproved: true,
    },
    preview: createPreview('watch'),
  };
}

it('reviews general-material points and exact sources without forcing Python or checkpoint panels', () => {
  const props = createProps();
  const fixture = createSourceLessonFixture();
  props.lesson = {
    ...props.lesson,
    title: fixture.plan.title,
    input: fixture.input,
    plan: fixture.plan,
    contentHash: fixture.record.contentHash,
  };
  render(createStudio(props));
  expect(screen.queryByRole('button', { name: 'Python' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Checkpoints' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Key points' }));
  const pointsRegion = screen.getByRole('region', { name: 'Scene content' });
  const scene = fixture.plan.scenes[0];
  if (scene?.kind !== 'sourceExplanation') {
    throw new Error('The source fixture needs a source explanation.');
  }
  for (const point of scene.params.points) {
    expect(pointsRegion.textContent).toContain(point.text);
  }
  expect(pointsRegion.textContent).toContain('Read-only key points from the approved script.');
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
  expect(screen.getByText(fixture.input.passages[0]?.text ?? '')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(
    screen.getByRole('checkbox', { name: 'I reviewed the script and sources.' }),
  ).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
});

it('blocks source explanations without narration from scene review, approval and saving', () => {
  const fixture = createSourceLessonFixture();
  expect(canReviewLessonPlan(fixture.plan)).toBe(true);
  const silentPlan = {
    ...fixture.plan,
    scenes: fixture.plan.scenes.map((scene, index) =>
      index === 0 ? { ...scene, narration: [] } : scene,
    ),
  };
  expect(canReviewLessonPlan(silentPlan)).toBe(false);
  const props = createProps();
  props.lesson = {
    ...props.lesson,
    input: fixture.input,
    plan: silentPlan,
    contentHash: fixture.record.contentHash,
  };
  render(createStudio(props));
  expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Lesson title' }), {
    target: { value: 'An edited source lesson' },
  });
  const save = screen.getByRole('button', { name: 'Save edits and review again' });
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(save);
  expect(props.onSavePlan).not.toHaveBeenCalled();
  expect(props.onApproveScript).not.toHaveBeenCalled();
});

async function acknowledgeCurrentPreview(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Make mocked preview ready' }));
  const acknowledge = screen.getByRole('button', { name: 'I reviewed this scene' });
  await waitFor(() => {
    expect(acknowledge).toHaveProperty('disabled', false);
  });
  fireEvent.click(acknowledge);
}

it('requires explicit review of every script scene and a separate complete-review attestation', () => {
  const props = createProps();
  render(createStudio(props));
  const acknowledgment = screen.getByRole('checkbox', {
    name: 'I reviewed the script, sources, hints and worked explanations.',
  });
  expect(acknowledgment).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
  for (const scene of props.lesson.plan?.scenes ?? []) {
    selectScene(props, scene.sceneId);
  }
  expect(acknowledgment).toHaveProperty('disabled', true);
  expect(props.onApproveScript).not.toHaveBeenCalled();
  reviewScriptScenes(props);
  expect(acknowledgment).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(acknowledgment);
  fireEvent.click(screen.getByRole('button', { name: 'Approve this script' }));
  expect(props.onApproveScript).toHaveBeenCalledOnce();
});

it('preserves unsaved edits on a repeated server read, then resets them on a new version', () => {
  const props = createProps();
  const view = render(createStudio(props));
  fireEvent.change(screen.getByRole('textbox', { name: 'Lesson title' }), {
    target: { value: 'An edited title' },
  });
  view.rerender(
    createStudio({
      ...props,
      lesson: { ...props.lesson, plan: props.lesson.plan ? { ...props.lesson.plan } : null },
    }),
  );
  expect(screen.getByRole('textbox', { name: 'Lesson title' })).toHaveProperty(
    'value',
    'An edited title',
  );
  expect(
    screen.getByRole('checkbox', {
      name: 'I reviewed the script, sources, hints and worked explanations.',
    }),
  ).toHaveProperty('disabled', true);
  view.rerender(createStudio({ ...props, lesson: { ...props.lesson, version: 2 } }));
  expect(screen.getByRole('textbox', { name: 'Lesson title' })).toHaveProperty(
    'value',
    props.lesson.plan?.title,
  );
});

it('preserves explicit reviews on a repeated read and clears them when the lesson version changes', () => {
  const props = createProps();
  const view = render(createStudio(props));
  reviewScriptScenes(props);
  const acknowledgment = screen.getByRole('checkbox', {
    name: 'I reviewed the script, sources, hints and worked explanations.',
  });
  fireEvent.click(acknowledgment);
  view.rerender(createStudio({ ...props, lesson: { ...props.lesson } }));
  expect(acknowledgment).toHaveProperty('checked', true);
  view.rerender(createStudio({ ...props, lesson: { ...props.lesson, version: 2 } }));
  expect(acknowledgment).toHaveProperty('checked', false);
  expect(acknowledgment).toHaveProperty('disabled', true);
  for (const scene of props.lesson.plan?.scenes ?? []) {
    selectScene(props, scene.sceneId);
    expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
      'checked',
      false,
    );
  }
});

it('invalidates the edited scene review and blocks approval until the saved script is reviewed again', () => {
  const props = createProps();
  render(createStudio(props));
  reviewScriptScenes(props);
  const acknowledgment = screen.getByRole('checkbox', {
    name: 'I reviewed the script, sources, hints and worked explanations.',
  });
  fireEvent.click(acknowledgment);
  selectScene(props, 'watch');
  fireEvent.click(screen.getByRole('button', { name: 'Narration' }));
  const narration = screen.getByRole('textbox', { name: 'Narration 1' });
  fireEvent.change(narration, { target: { value: 'A teacher-edited opening explanation.' } });
  expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
    'checked',
    false,
  );
  expect(acknowledgment).toHaveProperty('checked', false);
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save edits and review again' }));
  expect(props.onSavePlan).toHaveBeenCalledOnce();
  expect(props.onApproveScript).not.toHaveBeenCalled();
  expect(props.onRender).not.toHaveBeenCalled();
  expect(props.onRetry).not.toHaveBeenCalled();
  const saved = vi.mocked(props.onSavePlan).mock.calls[0]?.[0];
  const original = props.lesson.plan;
  if (!saved || !original) {
    throw new Error('The edited plan was not captured.');
  }
  expect(saved).toEqual({
    ...original,
    scenes: original.scenes.map((scene) =>
      scene.sceneId === 'watch'
        ? {
            ...scene,
            narration: scene.narration.map((beat, index) =>
              index === 0 ? { ...beat, text: 'A teacher-edited opening explanation.' } : beat,
            ),
          }
        : scene,
    ),
  });
});

it('refuses to review or save a whitespace-only existing narration beat', () => {
  const props = createProps();
  render(createStudio(props));
  fireEvent.change(screen.getByRole('textbox', { name: 'Narration 1' }), {
    target: { value: ' \n\t ' },
  });
  expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
    'disabled',
    true,
  );
  const save = screen.getByRole('button', { name: 'Save edits and review again' });
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(save);
  expect(props.onSavePlan).not.toHaveBeenCalled();
  expect(props.onApproveScript).not.toHaveBeenCalled();
});

it('allows review of a checkpoint with no pending narration beats', () => {
  const props = createProps();
  const plan = props.lesson.plan;
  if (!plan) {
    throw new Error('The script fixture is missing.');
  }
  const silentCheckpointProps: StudioProps = {
    ...props,
    lesson: {
      ...props.lesson,
      plan: {
        ...plan,
        scenes: plan.scenes.map((scene) =>
          scene.sceneId === 'predict' ? { ...scene, narration: [] } : scene,
        ),
      },
    },
  };
  render(createStudio(silentCheckpointProps));
  selectScene(silentCheckpointProps, 'predict');
  const review = screen.getByRole('checkbox', { name: 'I reviewed this script scene.' });
  expect(review).toHaveProperty('disabled', false);
  fireEvent.click(review);
  expect(review).toHaveProperty('checked', true);
  expect(props.onApproveScript).not.toHaveBeenCalled();
});

it.each(['Question', 'Hints 1', 'Worked explanation'])(
  'refuses to review or save a whitespace-only %s in a checkpoint',
  (label) => {
    const props = createProps();
    render(createStudio(props));
    selectScene(props, 'predict');
    fireEvent.click(screen.getByRole('button', { name: 'Checkpoints' }));
    fireEvent.change(screen.getByRole('textbox', { name: label }), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('checkbox', { name: 'I reviewed this script scene.' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Save edits and review again' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(props.onSavePlan).not.toHaveBeenCalled();
  },
);

it('keeps exact source text and its related published correction available on demand', () => {
  const props = createProps();
  const input = props.lesson.input;
  const passage = input?.passages[0];
  if (!input || !passage) {
    throw new Error('The source fixture is missing.');
  }
  const correctionText = 'Use the running total,\nnot only the current number. Đúng.';
  const correction = {
    ...passage,
    passageId: 'published-correction',
    ownerSourceId: 'correction-owner',
    kind: SourcePassageKind.PAGE_CORRECTION,
    correctsPassageIds: [passage.passageId],
    sourceDigest: hashText(correctionText),
    textDigest: hashText(correctionText),
    text: correctionText,
  };
  render(
    createStudio({
      ...props,
      lesson: { ...props.lesson, input: { ...input, passages: [passage, correction] } },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
  const sourceSummary = screen.getByText(/^Source passage \d+$/, { selector: 'summary' });
  const correctionSummary = screen.getByText(/^Correction \d+$/, { selector: 'summary' });
  fireEvent.click(sourceSummary);
  fireEvent.click(correctionSummary);
  const sourceDetails = sourceSummary.closest('details');
  const correctionDetails = correctionSummary.closest('details');
  expect(sourceDetails).toHaveProperty('open', true);
  expect(sourceDetails?.textContent).toContain(passage.text);
  expect(correctionDetails).toHaveProperty('open', true);
  expect(correctionDetails?.textContent).toContain(correctionText);
  expect(props.onApproveScript).not.toHaveBeenCalled();
});

it.each([LessonStatus.RENDERING, LessonStatus.RELEASED, LessonStatus.USAGE_UNCERTAIN])(
  'keeps narration editing locked while the lesson is %s',
  (status) => {
    const props = createProps();
    render(createStudio({ ...props, lesson: { ...props.lesson, status } }));
    expect(screen.getByRole('textbox', { name: 'Narration 1' })).toHaveProperty('disabled', true);
    expect(props.onSavePlan).not.toHaveBeenCalled();
  },
);

it('blocks rendering an approved script while local edits are unsaved', () => {
  const props = createProps();
  render(createStudio({ ...props, lesson: { ...props.lesson, scriptApproved: true } }));
  const renderPreview = screen.getByRole('button', { name: 'Make private preview' });
  expect(renderPreview).toHaveProperty('disabled', false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Narration 1' }), {
    target: { value: 'This narration has not been saved or approved.' },
  });
  expect(renderPreview).toHaveProperty('disabled', true);
  fireEvent.click(renderPreview);
  expect(props.onRender).not.toHaveBeenCalled();
});

it('does not acknowledge stale scene media while the selected scene preview is pending', async () => {
  const props = createPreviewProps();
  const view = render(createStudio(props));
  fireEvent.click(await screen.findByRole('button', { name: 'Make mocked preview ready' }));
  const acknowledge = screen.getByRole('button', { name: 'I reviewed this scene' });
  await waitFor(() => {
    expect(acknowledge).toHaveProperty('disabled', false);
  });
  selectScene(props, 'predict');
  expect(props.onPreviewScene).toHaveBeenLastCalledWith('predict', LessonPhase.PREDICT);
  expect(acknowledge).toHaveProperty('disabled', true);
  expect(screen.queryByRole('region', { name: 'Actual lesson preview' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Script illustration' })).toBeTruthy();
  fireEvent.click(acknowledge);
  view.rerender(createStudio({ ...props, preview: createPreview('predict', LessonPhase.PREDICT) }));
  expect(acknowledge).toHaveProperty('disabled', true);
  await acknowledgeCurrentPreview();
  expect(screen.getByText('1 / 4 Scene phases reviewed')).toBeTruthy();
  expect(props.onApprovePreview).not.toHaveBeenCalled();
});

it('refuses a ready projection with the right scene and content but a different manifest hash', async () => {
  const props = createPreviewProps();
  const view = render(createStudio(props));
  fireEvent.click(await screen.findByRole('button', { name: 'Make mocked preview ready' }));
  const acknowledge = screen.getByRole('button', { name: 'I reviewed this scene' });
  await waitFor(() => {
    expect(acknowledge).toHaveProperty('disabled', false);
  });
  const preview = props.preview;
  if (!preview) {
    throw new Error('The preview fixture is missing.');
  }
  view.rerender(
    createStudio({ ...props, preview: { ...preview, renderManifestHash: 'f'.repeat(64) } }),
  );
  const staleReady = screen.queryByRole('button', { name: 'Make mocked preview ready' });
  if (staleReady) {
    fireEvent.click(staleReady);
  }
  expect(acknowledge).toHaveProperty('disabled', true);
  expect(screen.queryByRole('region', { name: 'Actual lesson preview' })).toBeNull();
  fireEvent.click(acknowledge);
  expect(screen.getByText('0 / 4 Scene phases reviewed')).toBeTruthy();
  expect(props.onApprovePreview).not.toHaveBeenCalled();
  expect(props.onRelease).not.toHaveBeenCalled();
});

it('requires pending and worked phases, every evidence item and explicit preview attestation before approval', async () => {
  const props = createPreviewProps();
  const view = render(createStudio(props));
  const attestation = screen.getByRole('checkbox', {
    name: 'I watched and listened to this exact preview, including its checkpoints.',
  });
  expect(attestation).toHaveProperty('disabled', true);
  for (const [sceneId, phase] of [
    ['watch', LessonPhase.WATCH],
    ['predict', LessonPhase.PREDICT],
    ['continue', LessonPhase.WATCH],
  ] satisfies Array<[string, LessonPhase]>) {
    selectScene(props, sceneId);
    view.rerender(createStudio({ ...props, preview: createPreview(sceneId, phase) }));
    await acknowledgeCurrentPreview();
  }
  expect(attestation).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Rendered review evidence' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review mocked evidence evidence-1' }));
  expect(attestation).toHaveProperty('disabled', true);
  selectScene(props, 'predict');
  fireEvent.click(screen.getByRole('combobox', { name: 'Preview phase' }));
  fireEvent.click(screen.getByRole('option', { name: 'Worked answer' }));
  view.rerender(createStudio({ ...props, preview: createPreview('predict', LessonPhase.WORKED) }));
  await acknowledgeCurrentPreview();
  expect(attestation).toHaveProperty('disabled', false);
  const approve = screen.getByRole('button', { name: 'Approve preview' });
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(attestation);
  expect(approve).toHaveProperty('disabled', false);
  fireEvent.click(approve);
  expect(props.onApprovePreview).toHaveBeenCalledExactlyOnceWith(['evidence-1']);
  expect(props.onRelease).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Release to class' })).toHaveProperty('disabled', true);
});

it('clears scene and evidence acknowledgments when a manifest changes within the same content revision', async () => {
  const props = createPreviewProps();
  const view = render(createStudio(props));
  await acknowledgeCurrentPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Rendered review evidence' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review mocked evidence evidence-1' }));
  expect(screen.getByText('Mocked reviewed evidence: evidence-1')).toBeTruthy();
  const manifest = props.lesson.manifest;
  if (!manifest) {
    throw new Error('The preview manifest fixture is missing.');
  }
  const revisedManifest = {
    ...manifest,
    evidence: manifest.evidence.map((item) => ({ ...item, digest: 'f'.repeat(64) })),
  };
  view.rerender(
    createStudio({
      ...props,
      lesson: { ...props.lesson, manifest: revisedManifest },
      preview: createPreview('watch', LessonPhase.WATCH, revisedManifest),
    }),
  );
  expect(screen.getByText('0 / 4 Scene phases reviewed')).toBeTruthy();
  expect(await screen.findByText('Mocked reviewed evidence: none')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'I reviewed this scene' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(props.onApprovePreview).not.toHaveBeenCalled();
});

it('blocks releasing an approved preview after a local narration edit', async () => {
  const initial = createPreviewProps();
  const props = { ...initial, lesson: { ...initial.lesson, previewApproved: true } };
  render(createStudio(props));
  await screen.findByRole('region', { name: 'Actual lesson preview' });
  const release = screen.getByRole('button', { name: 'Release to class' });
  expect(release).toHaveProperty('disabled', false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Narration 1' }), {
    target: { value: 'An unsaved narration change invalidates the current preview.' },
  });
  expect(release).toHaveProperty('disabled', true);
  expect(screen.queryByRole('region', { name: 'Actual lesson preview' })).toBeNull();
  fireEvent.click(release);
  expect(props.onRelease).not.toHaveBeenCalled();
});
