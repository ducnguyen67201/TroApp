// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MaterialFiles } from '../../../../src/desktop/renderer/classroom/MaterialFiles.js';
import { MaterialState, type MaterialCollection } from '#contracts/ClassroomMaterials.js';

const collection: MaterialCollection = {
  classId: '306b1f29-6d1f-4327-9228-f76f72b1f701',
  version: 0,
  state: 'collecting',
  sources: [],
  teacherInstructions: '',
  draft: null,
  issue: null,
  leaseUntil: null,
  preparedAt: null,
  approvedCourseId: null,
};
afterEach(cleanup);

it('names the material and requires confirmation before removing it', () => {
  const materialId = crypto.randomUUID();
  const { onRemove } = renderFiles(false, {
    ...collection,
    sources: [{ id: materialId, name: 'Lesson.py', bytes: 20, digest: '', url: null }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delete Lesson.py' }));
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('Lesson.py');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete Lesson.py' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove material' }));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith(materialId);
});

function renderFiles(disabled = false, materials: MaterialCollection = collection) {
  const onRemove = vi.fn<(materialId: string) => void>();
  const onAddFiles = vi.fn<(files: File[]) => Promise<void>>().mockResolvedValue();
  const onAddLink = vi
    .fn<(url: string, name: string) => Promise<boolean>>()
    .mockResolvedValue(true);
  const result = render(
    createElement(MantineProvider, {
      children: createElement(MaterialFiles, {
        collection: materials,
        disabled,
        t: (english) => english,
        onAddFiles,
        onAddLink,
        onRemove,
        onDownload: vi.fn<(materialId: string) => void>(),
      }),
    }),
  );
  return { ...result, onAddFiles, onAddLink, onRemove };
}

it('uses the same upload callback for selecting and dropping real files', () => {
  const { container, onAddFiles } = renderFiles();
  const file = new File(['print("hello")'], 'Lesson.py');
  const input = container.querySelector('input[type="file"]');
  const drop = screen.getByText('Drop your files here').parentElement;
  if (!input || !drop) {
    throw new Error('Missing file selection controls.');
  }
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.drop(drop, { dataTransfer: { files: [file] } });
  expect(onAddFiles).toHaveBeenNthCalledWith(1, [file]);
  expect(onAddFiles).toHaveBeenNthCalledWith(2, [file]);
});

it('ignores dropped files while uploads are disabled', () => {
  const { onAddFiles } = renderFiles(true);
  const drop = screen.getByText('Drop your files here').parentElement;
  if (!drop) {
    throw new Error('Missing drop zone.');
  }
  fireEvent.drop(drop, { dataTransfer: { files: [new File(['x'], 'Lesson.txt')] } });
  expect(onAddFiles).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Choose files' })).toHaveProperty('disabled', true);
});

it('rejects credential-bearing links and derives the title for a valid reference', async () => {
  const { onAddLink } = renderFiles();
  const input = screen.getByRole('textbox', { name: 'Material link (HTTPS)' });
  fireEvent.change(input, { target: { value: 'https://user:password@example.test/' } });
  expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
  fireEvent.change(input, { target: { value: 'https://scratch.mit.edu/projects/1/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => {
    expect(input).toHaveProperty('value', '');
  });
  expect(onAddLink).toHaveBeenCalledWith('https://scratch.mit.edu/projects/1/', 'scratch.mit.edu');
});

const oldMaterialId = '11111111-1111-4111-8111-111111111111';
const mixedMaterials: MaterialCollection = {
  ...collection,
  sources: [
    { id: oldMaterialId, name: 'Existing.pdf', bytes: 20, digest: '', url: null },
    { id: crypto.randomUUID(), name: 'New.pdf', bytes: 20, digest: '', url: null },
    {
      id: crypto.randomUUID(),
      name: 'Scratch',
      bytes: 0,
      digest: '',
      url: 'https://scratch.mit.edu/projects/1/',
    },
  ],
  draft: {
    summary: 'Previous results',
    sections: [],
    pages: [
      {
        id: crypto.randomUUID(),
        materialId: oldMaterialId,
        location: 'Page 1',
        extractedText: 'Lesson',
        preparedNote: 'Lesson',
        teacherNote: null,
        warnings: [],
      },
    ],
    questions: [],
  },
};

function readFileRow(name: string) {
  const row = screen.getByText(name).closest('.material-file');
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing material row');
  }
  return within(row);
}

it.each([MaterialState.COLLECTING, MaterialState.FAILED])(
  'distinguishes previously processed files, new uploads and unfetched links in %s',
  (state) => {
    renderFiles(false, { ...mixedMaterials, state });
    expect(readFileRow('Existing.pdf').getByText('Processed')).toBeTruthy();
    expect(readFileRow('New.pdf').getByText('Not processed')).toBeTruthy();
    expect(readFileRow('Scratch').getByText('Reference only')).toBeTruthy();
    expect(readFileRow('Scratch').getByText('Link contents are not read.')).toBeTruthy();
  },
);

it.each([MaterialState.QUEUED, MaterialState.PREPARING])(
  'shows the active batch without claiming that reference links are being fetched (%s)',
  (state) => {
    renderFiles(true, { ...mixedMaterials, state });
    expect(
      readFileRow('Existing.pdf').getByText(
        state === MaterialState.QUEUED ? 'Queued' : 'Processing again',
      ),
    ).toBeTruthy();
    expect(
      readFileRow('New.pdf').getByText(state === MaterialState.QUEUED ? 'Queued' : 'Processing'),
    ).toBeTruthy();
    expect(readFileRow('Scratch').getByText('Reference only')).toBeTruthy();
  },
);

it('updates an uploaded file to processed only after its results arrive', () => {
  const { rerender } = renderFiles(false, mixedMaterials);
  expect(readFileRow('New.pdf').getByText('Not processed')).toBeTruthy();
  const newSource = mixedMaterials.sources.find((source) => source.name === 'New.pdf');
  if (!newSource || !mixedMaterials.draft) {
    throw new Error('Missing test materials');
  }
  const finished: MaterialCollection = {
    ...mixedMaterials,
    state: MaterialState.REVIEW,
    draft: {
      ...mixedMaterials.draft,
      pages: [
        ...mixedMaterials.draft.pages,
        {
          id: crypto.randomUUID(),
          materialId: newSource.id,
          location: 'Page 1',
          extractedText: 'New lesson',
          preparedNote: 'New lesson',
          teacherNote: null,
          warnings: [],
        },
      ],
    },
  };
  rerender(
    createElement(MantineProvider, {
      children: createElement(MaterialFiles, {
        collection: finished,
        disabled: false,
        t: (english) => english,
        onAddFiles: async () => {},
        onAddLink: () => Promise.resolve(true),
        onRemove: () => {},
        onDownload: () => {},
      }),
    }),
  );
  expect(readFileRow('New.pdf').getByText('Processed')).toBeTruthy();
});
