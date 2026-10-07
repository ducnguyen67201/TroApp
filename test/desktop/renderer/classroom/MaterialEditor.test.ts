// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MaterialState,
  MaterialIssue,
  MaterialPreparationPhase,
  type MaterialCollection,
  type MaterialReply,
} from '#contracts/ClassroomMaterials.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { MaterialEditor } from '../../../../src/desktop/renderer/classroom/MaterialEditor.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';

const classId = '11111111-1111-4111-8111-111111111111';
const materialId = '22222222-2222-4222-8222-222222222222';
const pageId = '33333333-3333-4333-8333-333333333333';
const sectionId = '44444444-4444-4444-8444-444444444444';
const existing: MaterialCollection = {
  classId,
  version: 4,
  state: MaterialState.APPROVED,
  teacherInstructions: 'Beginners practice printing.',
  sources: [{ id: materialId, name: 'SavedLesson.py', bytes: 14, digest: '', url: null }],
  draft: {
    summary: 'Previously reviewed lesson.',
    sections: [
      {
        id: sectionId,
        title: 'Printing',
        instruction: 'Print a greeting.',
        sourcePageIds: [pageId],
      },
    ],
    pages: [
      {
        id: pageId,
        materialId,
        location: 'Lines 1–2',
        extractedText: 'print("Hello")',
        preparedNote: 'Explain printing.',
        teacherNote: null,
        warnings: [],
      },
    ],
    questions: [],
  },
  issue: null,
  leaseUntil: null,
  preparedAt: null,
  approvedCourseId: sectionId,
};

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  window.localStorage.clear();
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderEditor(control: NonNullable<DesktopBridge['controlClassMaterials']>) {
  const download = vi
    .fn<NonNullable<DesktopBridge['downloadClassMaterial']>>()
    .mockResolvedValue(true);
  const bridge = { controlClassMaterials: control, downloadClassMaterial: download } satisfies Pick<
    DesktopBridge,
    'controlClassMaterials' | 'downloadClassMaterial'
  >;
  vi.stubGlobal('tro', bridge);
  const onApproved = vi.fn<() => Promise<void>>().mockResolvedValue();
  const view = (id: string) =>
    createElement(MantineProvider, {
      children: createElement(LocaleProvider, {
        children: createElement(MaterialEditor, {
          classId: id,
          live: false,
          t: (english) => english,
          onApproved,
        }),
      }),
    });
  return { ...render(view(classId)), view, download, onApproved };
}

it('opens saved materials and previous review without uploading again', async () => {
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockResolvedValue({ kind: 'collection', collection: existing });
  const { download } = renderEditor(control);
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  expect(screen.getByText('SavedLesson.py')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Process materials again' })).toHaveProperty(
    'disabled',
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(download).toHaveBeenCalledWith(classId, materialId);
  expect(control).toHaveBeenCalledExactlyOnceWith({
    kind: 'read',
    classId,
    materialSchemaVersion: 2,
  });
});

it('ends failed loading and retries the same existing collection', async () => {
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockRejectedValueOnce(new Error('Connection failed'))
    .mockResolvedValue({ kind: 'collection', collection: existing });
  renderEditor(control);
  await screen.findByText('Materials could not be loaded. Refresh to try again.');
  expect(screen.queryByText('Loading materials…')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh materials' }));
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(control).toHaveBeenCalledTimes(2);
});

it.each([MaterialState.COLLECTING, MaterialState.FAILED, MaterialState.QUEUED])(
  'retains the last review and downloads without permitting stale approval (%s)',
  async (state) => {
    const control = vi
      .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
      .mockResolvedValue({ kind: 'collection', collection: { ...existing, state } });
    renderEditor(control);
    await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
    expect(screen.getByText('SavedLesson.py')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use reviewed materials' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Lesson summary', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Download' })).toHaveProperty('disabled', false);
  },
);

it('saves manual edits before asking AI to adjust, and keeps the existing review during preparation', async () => {
  let current = existing;
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockImplementation((command) => {
      if (command.kind === 'save-review' && current.draft) {
        current = {
          ...current,
          version: 5,
          state: MaterialState.REVIEW,
          draft: { ...current.draft, summary: command.summary },
        };
      } else if (command.kind === 'prepare') {
        current = { ...current, version: 6, state: MaterialState.QUEUED };
      }
      return Promise.resolve({ kind: 'collection', collection: current });
    });
  const { onApproved } = renderEditor(control);
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Lesson summary', hidden: true }), {
    target: { value: 'Teacher wording to retain.' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI to adjust suggestions' }), {
    target: { value: 'Add practice with input().' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update suggestions with AI' }));
  await screen.findByText('Updating suggestions… Your previous review stays below.');
  expect(screen.getByText('Teacher wording to retain.', { selector: 'p' })).toBeTruthy();
  expect(control.mock.calls.map(([command]) => command.kind)).toEqual([
    'read',
    'save-review',
    'prepare',
  ]);
  expect(control).toHaveBeenLastCalledWith({
    kind: 'prepare',
    classId,
    version: 5,
    materialSchemaVersion: 2,
    teacherInstructions: existing.teacherInstructions,
    locale: 'en',
    revisionRequest: 'Add practice with input().',
  });
  expect(onApproved).not.toHaveBeenCalled();
});

it('does not queue an AI revision when saving the teacher edits fails', async () => {
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'save-review'
          ? { kind: 'failed', code: 'stale' }
          : { kind: 'collection', collection: existing },
      ),
    );
  renderEditor(control);
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Lesson summary', hidden: true }), {
    target: { value: 'Unsaved teacher edit.' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask AI to adjust suggestions' }), {
    target: { value: 'Shorten the first section.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update suggestions with AI' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Unsaved teacher edit.', { selector: 'p' })).toBeTruthy();
  expect(control.mock.calls.map(([command]) => command.kind)).toEqual(['read', 'save-review']);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh materials' }));
  expect(control).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Keep edits' }));
  expect(screen.getByText('Unsaved teacher edit.', { selector: 'p' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh materials' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits and refresh' }));
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  expect(control).toHaveBeenCalledTimes(3);
});

it('ignores a late load from a class that the teacher left', async () => {
  let resolveFirst: (reply: MaterialReply) => void = () => {
    throw new Error('Missing request');
  };
  const first = new Promise<MaterialReply>((resolve) => {
    resolveFirst = resolve;
  });
  const secondClassId = '55555555-5555-4555-8555-555555555555';
  const second = { ...existing, classId: secondClassId, sources: [], draft: null };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockImplementation((command) =>
      command.classId === classId
        ? first
        : Promise.resolve({ kind: 'collection', collection: second }),
    );
  const { rerender, view } = renderEditor(control);
  rerender(view(secondClassId));
  await waitFor(() => {
    expect(screen.queryByText('Loading materials…')).toBeNull();
  });
  await act(async () => {
    resolveFirst({ kind: 'collection', collection: existing });
    await first;
  });
  expect(screen.queryByText('SavedLesson.py')).toBeNull();
  expect(screen.queryByText('Previously reviewed lesson.', { selector: 'p' })).toBeNull();
});

it('does not replace completed suggestions with an older overlapping preparation poll', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let finishOlderPoll: (reply: MaterialReply) => void = () => {
    throw new Error('Missing poll');
  };
  const olderPoll = new Promise<MaterialReply>((resolve) => {
    finishOlderPoll = resolve;
  });
  if (!existing.draft) {
    throw new Error('Missing draft');
  }
  const completed = {
    ...existing,
    version: 9,
    state: MaterialState.REVIEW,
    draft: { ...existing.draft, summary: 'Updated AI suggestions.' },
  };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockResolvedValueOnce({
      kind: 'collection',
      collection: { ...existing, state: MaterialState.QUEUED },
    })
    .mockImplementationOnce(() => olderPoll)
    .mockResolvedValue({ kind: 'collection', collection: completed });
  renderEditor(control);
  await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await screen.findByText('Updated AI suggestions.', { selector: 'p' });
  await act(async () => {
    finishOlderPoll({
      kind: 'collection',
      collection: { ...existing, version: 7, state: MaterialState.PREPARING },
    });
    await olderPoll;
  });
  expect(screen.getByText('Updated AI suggestions.', { selector: 'p' })).toBeTruthy();
  expect(screen.queryByText('Previously reviewed lesson.', { selector: 'p' })).toBeNull();
  expect(
    screen.getByRole('region', { name: 'Review your materials' }).getAttribute('aria-busy'),
  ).toBe('false');
});

it('exposes batch processing before the file list and preserves the preparation command', async () => {
  const current: MaterialCollection = { ...existing, state: MaterialState.COLLECTING };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockResolvedValueOnce({ kind: 'collection', collection: current })
    .mockResolvedValue({
      kind: 'collection',
      collection: { ...current, version: 5, state: MaterialState.QUEUED },
    });
  renderEditor(control);
  const button = await screen.findByRole('button', { name: 'Process materials again' });
  expect(
    button.compareDocumentPosition(screen.getByText('SavedLesson.py')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(button);
  await waitFor(() => {
    expect(control).toHaveBeenLastCalledWith({
      kind: 'prepare',
      classId,
      version: existing.version,
      materialSchemaVersion: 2,
      teacherInstructions: existing.teacherInstructions,
      locale: 'en',
    });
  });
  expect(screen.getByRole('button', { name: 'Processing…' })).toHaveProperty('disabled', true);
});

it.each([
  [MaterialPreparationPhase.CHECKING_REFERENCES, 'Checking source references…'],
  [MaterialPreparationPhase.CORRECTING_REFERENCES, 'Correcting source references…'],
])(
  'shows preparation reference status while keeping the existing review (%s)',
  async (phase, label) => {
    const control = vi.fn<NonNullable<DesktopBridge['controlClassMaterials']>>().mockResolvedValue({
      kind: 'collection',
      collection: {
        ...existing,
        state: MaterialState.PREPARING,
        preparationProgress: { completed: 1, total: 2, phase },
      },
    });
    renderEditor(control);
    await screen.findByText('Previously reviewed lesson.', { selector: 'p' });
    expect(screen.getByText((text) => text.includes(label))).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Review your materials' }).getAttribute('aria-busy'),
    ).toBe('true');
    expect(screen.queryByRole('button', { name: 'Use reviewed materials' })).toBeNull();
  },
);

it('explains a failed citation repair and exposes an explicit retry with the previous review intact', async () => {
  const control = vi.fn<NonNullable<DesktopBridge['controlClassMaterials']>>().mockResolvedValue({
    kind: 'collection',
    collection: {
      ...existing,
      state: MaterialState.FAILED,
      issue: MaterialIssue.CITATION_VALIDATION_FAILED,
    },
  });
  renderEditor(control);
  await screen.findByText(
    'AI source references could not be verified. Your files and previous review are saved. Process materials again to retry.',
  );
  expect(screen.getByText('Previously reviewed lesson.', { selector: 'p' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Process materials again' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(control).toHaveBeenCalledTimes(1);
});
