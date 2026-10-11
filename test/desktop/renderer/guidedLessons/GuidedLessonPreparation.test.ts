// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GuidedLessonCommandSchema,
  SourcePassageKind,
  SourcePassageSchema,
} from '#contracts/GuidedLessons.js';
import { GuidedLessonPreparation } from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonPreparation.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';

type PreparationProps = ComponentProps<typeof GuidedLessonPreparation>;

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function createProps(passageCount = 3): PreparationProps {
  const passages = Array.from({ length: passageCount }, (_, index) =>
    SourcePassageSchema.parse({
      passageId: `passage-${String(index + 1)}`,
      materialId: 'material-1',
      publicationId: 'course-1',
      ownerSourceId: `source-${String(index + 1)}`,
      kind: index === 1 ? SourcePassageKind.PAGE_CORRECTION : SourcePassageKind.SOURCE_TEXT,
      correctsPassageIds: index === 1 ? ['passage-1'] : [],
      pageId: 'page-1',
      sourceDigest: 'a'.repeat(64),
      textDigest: 'b'.repeat(64),
      text:
        index === 1
          ? 'Correction: changing brightness does not necessarily change the hue.'
          : `Exact approved passage ${String(index + 1)}. Hue & brightness are distinct; <b>light</b> is literal source text.`,
    }),
  );
  const passageIds = passages.map((passage) => passage.passageId);
  return {
    input: {
      kind: 'teacherInput',
      classId: 'class-1',
      passages,
      revisions: [
        {
          id: 'course-1',
          title: 'Approved color theory',
          sections: [
            { id: 'section-1', title: 'Color and light', passageIds },
            { id: 'section-2', title: 'Color families', passageIds: passageIds.slice(0, 2) },
          ],
        },
        {
          id: 'course-2',
          title: 'Another approved revision',
          sections: [{ id: 'section-3', title: 'Light and shade', passageIds }],
        },
      ],
    },
    busy: false,
    onChooseRevision: vi.fn<PreparationProps['onChooseRevision']>(),
    onCreate: vi.fn<PreparationProps['onCreate']>().mockResolvedValue(),
  };
}

function createPreparation(props: PreparationProps) {
  return createElement(LocaleProvider, { children: createElement(GuidedLessonPreparation, props) });
}

function chooseContent(sectionId = 'section-1'): void {
  fireEvent.change(screen.getByRole('combobox', { name: 'Concept or section' }), {
    target: { value: sectionId },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Learning objective' }), {
    target: { value: 'Distinguish hue from brightness.' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Audience' }), {
    target: { value: 'New art students' },
  });
}

function readForm(): HTMLFormElement {
  const form = screen.getByRole('navigation', { name: 'Lesson preparation' }).closest('form');
  if (!(form instanceof HTMLFormElement)) {
    throw new Error('Missing preparation form.');
  }
  return form;
}

it('requires the teacher to supply the audience rather than inventing it from the material', () => {
  const props = createProps();
  render(createPreparation(props));
  expect(screen.getByRole('textbox', { name: 'Audience' })).toHaveProperty('value', '');
  fireEvent.change(screen.getByRole('combobox', { name: 'Concept or section' }), {
    target: { value: 'section-1' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Learning objective' }), {
    target: { value: 'Distinguish hue from brightness.' },
  });
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  fireEvent.submit(readForm());
  expect(props.onCreate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Audience' }), {
    target: { value: 'Adult art learners' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Adult art learners')).toBeTruthy();
  expect(screen.queryByText(/20–40k|90k input|30k output/)).toBeNull();
});

it('uses actual material sections without fixed mode choices or a code-example step, even for Python text', () => {
  const original = createProps();
  const props: PreparationProps = {
    ...original,
    input: {
      ...original.input,
      revisions: original.input.revisions.map((revision) => ({
        ...revision,
        title: 'Python course',
      })),
      passages: original.input.passages.map((passage) => ({
        ...passage,
        text: 'Python loops can accumulate a running total.',
      })),
    },
  };
  render(createPreparation(props));
  const steps = within(screen.getByRole('navigation', { name: 'Lesson preparation' }));
  expect(steps.getAllByRole('button')).toHaveLength(2);
  expect(steps.getByRole('button', { name: 'Content' })).toBeTruthy();
  expect(steps.getByRole('button', { name: 'Review' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Explanation type' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Explain the selected material' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Python running-total demonstration' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Python examples' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Approved Python example' })).toBeNull();
  const sections = within(screen.getByRole('combobox', { name: 'Concept or section' }));
  expect(sections.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Choose a section',
    'Color and light',
    'Color families',
  ]);
  chooseContent();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('button', { name: 'Create and generate' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.queryByRole('button', { name: 'Edit examples' })).toBeNull();
  expect(
    screen.queryByRole('textbox', { name: 'Practice variant with a different input' }),
  ).toBeNull();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it('advances early Enter and submissions without generation, preserves content on Back, and requires a source', () => {
  const props = createProps();
  render(createPreparation(props));
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  chooseContent();
  fireEvent.change(screen.getByLabelText('Teacher instructions'), {
    target: { value: 'Compare two familiar colors.' },
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Learning objective' }), { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Create and generate' })).toBeTruthy();
  expect(props.onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('textbox', { name: 'Learning objective' })).toHaveProperty(
    'value',
    'Distinguish hue from brightness.',
  );
  expect(screen.getByRole('combobox', { name: 'Concept or section' })).toHaveProperty(
    'value',
    'section-1',
  );
  expect(screen.getByLabelText('Teacher instructions')).toHaveProperty(
    'value',
    'Compare two familiar colors.',
  );
  fireEvent.submit(readForm());
  expect(props.onCreate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit content' }));
  for (const name of ['Passage 1', 'Correction 2', 'Passage 3']) {
    fireEvent.click(screen.getByRole('checkbox', { name }));
  }
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  fireEvent.submit(readForm());
  expect(screen.queryByRole('button', { name: 'Create and generate' })).toBeNull();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it('keeps exact text disclosures independent from selection and exposes accessible, escaped source excerpts', () => {
  render(createPreparation(createProps()));
  chooseContent();
  expect(screen.getByRole('region', { name: 'Approved passages' })).toHaveProperty('tabIndex', 0);
  const summary = screen.getByLabelText('Read exact text: Passage 1');
  const disclosure = summary.closest('details');
  if (!(disclosure instanceof HTMLDetailsElement)) {
    throw new Error('Missing exact source disclosure.');
  }
  expect(disclosure.open).toBe(false);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(true);
  const checkbox = screen.getByRole('checkbox', { name: 'Passage 1' });
  const excerptId = checkbox.getAttribute('aria-describedby');
  expect(document.getElementById(excerptId ?? '')?.textContent).toContain(
    'Exact approved passage 1.',
  );
  expect(disclosure.querySelector('p')?.textContent).toContain('<b>light</b>');
  expect(disclosure.querySelector('b')).toBeNull();
  fireEvent.click(checkbox);
  expect(disclosure.open).toBe(true);
  expect(checkbox).toHaveProperty('checked', false);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(false);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search passages' }), {
    target: { value: 'Correction:' },
  });
  expect(screen.queryByRole('checkbox', { name: 'Passage 1' })).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Correction 2' })).toHaveProperty('checked', true);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search passages' }), {
    target: { value: '' },
  });
  expect(screen.getByRole('checkbox', { name: 'Passage 1' })).toHaveProperty('checked', false);
});

it.each([60, 180, 300])(
  'creates a %i-second lesson with the chosen section and options only from Review',
  (durationSeconds) => {
    const props = createProps();
    render(createPreparation(props));
    chooseContent('section-2');
    expect(screen.queryByRole('checkbox', { name: 'Passage 3' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Learning objective' }), {
      target: { value: '  Distinguish hue from brightness.  ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Audience' }), {
      target: { value: '  New art students  ' },
    });
    fireEvent.change(screen.getByLabelText('Length'), {
      target: { value: String(durationSeconds) },
    });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'vi' } });
    fireEvent.change(screen.getByLabelText('Teacher instructions'), {
      target: { value: '  Compare two familiar colors.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Color families')).toBeTruthy();
    expect(screen.getByText('Vietnamese')).toBeTruthy();
    expect(screen.getByLabelText('Read exact text: Correction 2')).toBeTruthy();
    expect(screen.queryByLabelText('Read exact text: Passage 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }));
    expect(props.onCreate).toHaveBeenCalledOnce();
    const command = vi.mocked(props.onCreate).mock.calls[0]?.[0];
    expect(command?.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(command).toEqual({
      action: 'create',
      commandId: command?.commandId,
      classId: 'class-1',
      courseRevisionId: 'course-1',
      conceptId: 'section-2',
      objective: 'Distinguish hue from brightness.',
      audience: 'New art students',
      language: 'vi',
      targetDurationSeconds: durationSeconds,
      passageIds: ['passage-1', 'passage-2'],
      teacherInstructions: 'Compare two familiar colors.',
      codeApproval: null,
      practiceCodeApproval: null,
    });
    expect(GuidedLessonCommandSchema.safeParse(command).success).toBe(true);
  },
);

it('clears the prior section and sources on revision changes and requests the chosen approved revision', () => {
  const props = createProps();
  render(createPreparation(props));
  chooseContent();
  fireEvent.change(screen.getByRole('combobox', { name: 'Approved source' }), {
    target: { value: 'course-2' },
  });
  expect(props.onChooseRevision).toHaveBeenCalledExactlyOnceWith('course-2');
  expect(screen.getByRole('combobox', { name: 'Concept or section' })).toHaveProperty('value', '');
  expect(screen.queryByRole('region', { name: 'Approved passages' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('textbox', { name: 'Learning objective' })).toHaveProperty(
    'value',
    'Distinguish hue from brightness.',
  );
  chooseContent('section-3');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }));
  expect(props.onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ courseRevisionId: 'course-2', conceptId: 'section-3' }),
  );
});

it('resets to Content when an incoming read no longer contains the chosen revision', () => {
  const props = createProps();
  const view = render(createPreparation(props));
  chooseContent();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  view.rerender(
    createPreparation({
      ...props,
      input: {
        ...props.input,
        revisions: props.input.revisions.filter((revision) => revision.id === 'course-2'),
      },
    }),
  );
  expect(screen.getByRole('combobox', { name: 'Approved source' })).toHaveProperty(
    'value',
    'course-2',
  );
  expect(screen.getByRole('combobox', { name: 'Concept or section' })).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: 'Create and generate' })).toBeNull();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it('includes and locks corrections outside section IDs in review and the exact creation payload', () => {
  const original = createProps(9);
  const props: PreparationProps = {
    ...original,
    input: {
      ...original.input,
      revisions: original.input.revisions.map((revision) => ({
        ...revision,
        sections: revision.sections.map((section) => ({
          ...section,
          passageIds: section.passageIds.filter((passageId) => passageId !== 'passage-2'),
        })),
      })),
    },
  };
  render(createPreparation(props));
  chooseContent();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Passage 1' }));
  const correction = screen.getByRole('checkbox', { name: 'Correction 2' });
  expect(correction).toHaveProperty('checked', true);
  expect(correction).toHaveProperty('disabled', true);
  expect(screen.getByText('Required with selected source')).toBeTruthy();
  expect(screen.getByText('2 / 8')).toBeTruthy();
  fireEvent.click(correction);
  expect(correction).toHaveProperty('checked', true);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const exactCorrection = screen.getByLabelText('Read exact text: Correction 2').closest('details');
  expect(exactCorrection?.querySelector('p')?.textContent).toBe(props.input.passages[1]?.text);
  expect(screen.queryByLabelText('Read exact text: Passage 3')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }));
  expect(props.onCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      passageIds: ['passage-1', 'passage-2'],
      codeApproval: null,
      practiceCodeApproval: null,
    }),
  );
});

it('counts required corrections toward the eight-passage cap and permits a correction alone', () => {
  const props = createProps(9);
  render(createPreparation(props));
  chooseContent();
  const correction = screen.getByRole('checkbox', { name: 'Correction 2' });
  fireEvent.click(correction);
  expect(correction).toHaveProperty('checked', true);
  expect(correction).toHaveProperty('disabled', false);
  expect(screen.getByText('1 / 8')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false);
  fireEvent.click(correction);
  for (let index = 3; index <= 9; index++) {
    fireEvent.click(screen.getByRole('checkbox', { name: `Passage ${String(index)}` }));
  }
  const source = screen.getByRole('checkbox', { name: 'Passage 1' });
  expect(screen.getByText('7 / 8')).toBeTruthy();
  expect(source).toHaveProperty('disabled', true);
  fireEvent.click(source);
  expect(source).toHaveProperty('checked', false);
  expect(correction).toHaveProperty('checked', false);
  fireEvent.click(correction);
  expect(screen.getByText('8 / 8')).toBeTruthy();
  expect(source).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Passage 9' }));
  expect(source).toHaveProperty('disabled', false);
  fireEvent.click(source);
  expect(screen.getByText('8 / 8')).toBeTruthy();
  expect(correction).toHaveProperty('checked', true);
  expect(correction).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', { name: 'Passage 9' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }));
  expect(props.onCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      passageIds: [
        'passage-1',
        'passage-2',
        'passage-3',
        'passage-4',
        'passage-5',
        'passage-6',
        'passage-7',
        'passage-8',
      ],
    }),
  );
});

it.each([
  { name: 'Learning objective', limit: 500 },
  { name: 'Audience', limit: 400 },
  { name: 'Teacher instructions', limit: 2000 },
])(
  'enforces the $limit-character limit for $name before review or generation',
  ({ name, limit }) => {
    const props = createProps();
    render(createPreparation(props));
    chooseContent();
    const field = screen.getByLabelText(name);
    expect(field).toHaveProperty('maxLength', limit);
    fireEvent.change(field, { target: { value: 'x'.repeat(limit + 1) } });
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Review' })).toHaveProperty('disabled', true);
    fireEvent.submit(readForm());
    expect(screen.queryByRole('button', { name: 'Create and generate' })).toBeNull();
    expect(props.onCreate).not.toHaveBeenCalled();
  },
);

it.each(['Learning objective', 'Audience'])('rejects whitespace-only %s', (name) => {
  const props = createProps();
  render(createPreparation(props));
  chooseContent();
  const field = screen.getByLabelText(name);
  expect(field).toHaveProperty('required', true);
  fireEvent.change(field, { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  fireEvent.submit(readForm());
  expect(props.onCreate).not.toHaveBeenCalled();
});

it('disables preparation and prevents dispatch while approved material or a command is busy', () => {
  const props = createProps();
  const view = render(createPreparation(props));
  chooseContent();
  view.rerender(createPreparation({ ...props, busy: true }));
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  expect(
    screen.getByRole('textbox', { name: 'Learning objective' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
  fireEvent.submit(readForm());
  expect(screen.queryByRole('button', { name: 'Create and generate' })).toBeNull();
  view.rerender(createPreparation(props));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  view.rerender(createPreparation({ ...props, busy: true }));
  expect(screen.getByRole('button', { name: 'Create and generate' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
  fireEvent.submit(readForm());
  expect(props.onCreate).not.toHaveBeenCalled();
});
