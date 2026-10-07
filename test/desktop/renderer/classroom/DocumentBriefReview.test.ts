// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentBriefReview } from '../../../../src/desktop/renderer/classroom/DocumentBriefReview.js';
import type { MaterialCollection, MaterialDraftV2 } from '#contracts/ClassroomMaterials.js';
const materialId = '11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const passageId = '33333333-3333-4333-8333-333333333333';
const draft: MaterialDraftV2 = {
  schemaVersion: 2,
  summary: 'Practice',
  sections: [],
  questions: [],
  pages: [
    {
      id: pageId,
      materialId,
      location: 'Source',
      extractedText: 'print("Hello")',
      preparedNote: '',
      teacherNote: null,
      warnings: [],
    },
  ],
  passages: [
    {
      id: passageId,
      materialId,
      sourceUnitId: pageId,
      sequence: 0,
      start: 0,
      end: 14,
      location: 'Source',
      heading: '',
      text: 'print("Hello")',
      teacherNote: null,
      warnings: [],
    },
  ],
  documents: [
    {
      materialId,
      sourceDigest: '',
      teacherNote: null,
      purpose: { text: 'Use printing.', origin: 'source', sourceIds: [passageId] },
      topics: ['Python'],
      setup: [],
      practice: [],
      examples: [],
      uncertainties: [],
    },
  ],
};
const collection: MaterialCollection = {
  classId: materialId,
  version: 1,
  state: 'review',
  sources: [{ id: materialId, name: 'Lesson.py', digest: '', url: null, bytes: 14 }],
  teacherInstructions: '',
  draft,
  issue: null,
  leaseUntil: null,
  preparedAt: null,
  approvedCourseId: null,
};
beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('edits a document brief separately while retaining generated text and original code', () => {
  const onChange = vi.fn<(collection: MaterialCollection) => void>();
  render(
    createElement(MantineProvider, {
      children: createElement(DocumentBriefReview, {
        collection,
        draft,
        editable: true,
        onChange,
        t: (english) => english,
      }),
    }),
  );
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Document brief: Lesson.py', hidden: true }),
    { target: { value: 'Teacher: use IDLE.' } },
  );
  const changed = onChange.mock.calls[0]?.[0].draft;
  if (!changed || !('schemaVersion' in changed)) {
    throw new Error('Missing change.');
  }
  expect(changed.documents[0]?.teacherNote).toBe('Teacher: use IDLE.');
  expect(changed.documents[0]?.purpose.text).toBe('Use printing.');
  expect(changed.pages[0]?.extractedText).toBe('print("Hello")');
});
