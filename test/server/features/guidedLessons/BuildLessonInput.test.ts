import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MaterialPublicationSchema,
  type MaterialPublication,
} from '#contracts/ClassroomMaterials.js';
import {
  SourcePassageKind,
  LessonLanguage,
  LessonTemplateKind,
  TeacherInputSchema,
  type GuidedLessonCommand,
} from '#contracts/GuidedLessons.js';
import {
  buildLessonInput,
  buildPublicationLessonPassages,
  hashLessonText,
  hashLessonValue,
} from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { validateLessonInput } from '../../../../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';

function createPublication(options: { digest?: string; url?: string; text?: string } = {}) {
  const pageId = randomUUID();
  const passageId = randomUUID();
  const materialId = randomUUID();
  const code =
    'numbers = [2, 4, 6]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)';
  const sourceText = options.text ?? options.url ?? code;
  const sourceDigest = options.digest ?? (options.url ? '' : hashLessonText(sourceText));
  return {
    code,
    publication: MaterialPublicationSchema.parse({
      courseId: randomUUID(),
      classId: randomUUID(),
      teacherInstructions: '',
      sources: [
        {
          id: materialId,
          name: 'Approved accumulator lesson',
          bytes: options.url ? 0 : sourceText.length,
          digest: sourceDigest,
          url: options.url ?? null,
        },
      ],
      draft: {
        schemaVersion: 2,
        summary: 'A running total',
        questions: [],
        sections: [
          {
            id: randomUUID(),
            title: 'Accumulator',
            instruction: 'Follow each addition.',
            sourcePageIds: [pageId],
          },
        ],
        pages: [
          {
            id: pageId,
            materialId,
            location: 'Page 1',
            extractedText: sourceText,
            preparedNote: '',
            teacherNote: options.text
              ? 'Use only the selected source for this explanation.'
              : 'Use total = 0 before the loop.',
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
            end: sourceText.length,
            location: 'Page 1',
            heading: 'Accumulator',
            text: sourceText,
            teacherNote: null,
            warnings: [],
          },
        ],
        documents: [
          {
            materialId,
            sourceDigest,
            purpose: {
              text: 'Understand a running total.',
              origin: 'source',
              sourceIds: [passageId],
            },
            topics: ['Accumulator'],
            setup: [],
            practice: [],
            examples: [],
            uncertainties: [],
            teacherNote: options.text
              ? 'Keep the explanation within this material.'
              : 'Do not reset total during the loop.',
          },
        ],
      },
    }),
  };
}

function createSourceCommand(
  publication: MaterialPublication,
): Extract<GuidedLessonCommand, { action: 'create' }> {
  const section = publication.draft.sections[0];
  if (!section) {
    throw new Error('The publication fixture needs a section.');
  }
  return {
    action: 'create',
    commandId: randomUUID(),
    classId: publication.classId,
    courseRevisionId: publication.courseId,
    conceptId: section.id,
    objective: 'Explain the selected material.',
    audience: 'Students learning this topic',
    language: LessonLanguage.EN,
    targetDurationSeconds: 180,
    passageIds: buildPublicationLessonPassages(publication).map((passage) => passage.passageId),
    teacherInstructions: '',
    codeApproval: null,
    practiceCodeApproval: null,
  };
}

describe('guided lesson approved source packet', () => {
  it.each(['conceptId', 'classId', 'courseRevisionId'] as const)(
    'rejects a %s that is not bound to the approved publication',
    (field) => {
      const { publication } = createPublication();
      const command = createSourceCommand(publication);
      expect(() => buildLessonInput(publication, { ...command, [field]: randomUUID() })).toThrow();
    },
  );

  it('rejects a passage from another real section instead of silently broadening the chosen section', () => {
    const { publication } = createPublication();
    const draft = publication.draft;
    if (!('schemaVersion' in draft)) {
      throw new Error('The fixture needs exact source passages.');
    }
    const page = draft.pages[0];
    const passage = draft.passages[0];
    if (!page || !passage) {
      throw new Error('The fixture needs a source page and passage.');
    }
    const otherPage = { ...page, id: randomUUID(), teacherNote: null };
    const otherPassage = { ...passage, id: randomUUID(), sourceUnitId: otherPage.id };
    const otherSection = {
      id: randomUUID(),
      title: 'Another approved section',
      instruction: 'Use only this page.',
      sourcePageIds: [otherPage.id],
    };
    const expanded = MaterialPublicationSchema.parse({
      ...publication,
      draft: {
        ...draft,
        pages: [...draft.pages, otherPage],
        passages: [...draft.passages, otherPassage],
        sections: [...draft.sections, otherSection],
      },
    });
    const command = createSourceCommand(publication);
    expect(buildLessonInput(expanded, command).conceptId).toBe(command.conceptId);
    expect(() =>
      buildLessonInput(expanded, { ...command, passageIds: [otherPassage.id] }),
    ).toThrow();
    const selected = buildLessonInput(expanded, {
      ...command,
      conceptId: otherSection.id,
      passageIds: [otherPassage.id],
    });
    expect(selected.conceptId).toBe(otherSection.id);
    expect(selected.passages.some((item) => item.passageId === passage.id)).toBe(false);
    expect(selected.passages.some((item) => item.passageId === otherPassage.id)).toBe(true);
  });

  it.each([
    'Water evaporates into vapor and condenses into liquid water.',
    'Comments explain a Python program. Indentation groups statements. print displays text.',
  ])('accepts source explanations without inventing an executable example: %s', (text) => {
    const { publication } = createPublication({ text });
    const command = createSourceCommand(publication);
    const input = buildLessonInput(publication, command);
    expect(input.codeBlocks).toEqual([]);
    expect(input.traces).toEqual([]);
    expect(input.assets).toEqual([]);
    expect(input.teacherAnswerKeys).toEqual([]);
    expect(input.templates.map((template) => template.templateId)).toEqual([
      LessonTemplateKind.SOURCE_EXPLANATION,
    ]);
    expect(input.passages.some((passage) => passage.text === text)).toBe(true);
    expect(validateLessonInput(input)).toEqual([]);
    expect(input.targetDurationSeconds).toBe(180);
    expect(input.sourcePacketHash).toHaveLength(64);
  });

  it('rejects a practice program without an approved base before admitting a lesson', () => {
    const { publication, code } = createPublication();
    const command = createSourceCommand(publication);
    expect(() =>
      buildLessonInput(publication, {
        ...command,
        practiceCodeApproval: {
          code,
          variantOfCodeBlockId: null,
          sourceRefs: buildPublicationLessonPassages(publication).map((passage) => ({
            passageId: passage.passageId,
            startOffset: 0,
            endOffset: passage.text.length,
          })),
        },
      }),
    ).toThrow();
  });
  it('preserves original text and separate page/document corrections with exact digests', () => {
    const { publication, code } = createPublication();
    const passages = buildPublicationLessonPassages(publication);
    const original = passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT);
    expect(original?.text).toBe(code);
    expect(original?.textDigest).toBe(hashLessonText(code));
    expect(passages.every((passage) => passage.sourceDigest === hashLessonText(code))).toBe(true);
    expect(
      passages.filter((passage) => passage.kind !== SourcePassageKind.SOURCE_TEXT),
    ).toHaveLength(2);
    expect(
      passages
        .filter((passage) => passage.kind !== SourcePassageKind.SOURCE_TEXT)
        .every((passage) => passage.correctsPassageIds.includes(original?.passageId ?? '')),
    ).toBe(true);
    expect(
      passages.find((passage) => passage.kind === SourcePassageKind.DOCUMENT_CORRECTION)?.pageId,
    ).toBeNull();
  });

  it('loads linked material and its corrections when no source file digest exists', () => {
    const url = 'https://example.test/lesson';
    const { publication } = createPublication({ url });
    const savedPublication = structuredClone(publication);
    const passages = buildPublicationLessonPassages(publication);
    const input = TeacherInputSchema.parse({
      classId: publication.classId,
      revisions: [],
      passages,
    });
    expect(input.passages).toHaveLength(3);
    expect(
      passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT)?.sourceDigest,
    ).toBe(hashLessonText(url));
    expect(
      passages.find((passage) => passage.kind === SourcePassageKind.PAGE_CORRECTION)?.sourceDigest,
    ).toBe(hashLessonText(url));
    if (!('schemaVersion' in publication.draft)) {
      throw new Error('Expected the version-two publication fixture.');
    }
    expect(
      passages.find((passage) => passage.kind === SourcePassageKind.DOCUMENT_CORRECTION)
        ?.sourceDigest,
    ).toBe(
      hashLessonValue(
        publication.draft.passages.map((passage) => ({
          passageId: passage.id,
          text: passage.text,
        })),
      ),
    );
    expect(publication).toEqual(savedPublication);
    expect(publication.sources[0]?.digest).toBe('');
    expect(publication.draft.documents[0]?.sourceDigest).toBe('');
    expect(passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT)?.text).toBe(
      url,
    );
  });

  it('keeps malformed nonempty source digests subject to the strict lesson contract', () => {
    const { publication } = createPublication({ digest: 'malformed-file-digest' });
    const passages = buildPublicationLessonPassages(publication);
    expect(passages.every((passage) => passage.sourceDigest === 'malformed-file-digest')).toBe(
      true,
    );
    expect(
      TeacherInputSchema.safeParse({ classId: publication.classId, revisions: [], passages })
        .success,
    ).toBe(false);
  });

  it('requires teacher code citations to include the published corrections before any generation', () => {
    const { publication, code } = createPublication();
    const passages = buildPublicationLessonPassages(publication);
    const original = passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT);
    if (!original) {
      throw new Error('Missing source fixture.');
    }
    const command: Extract<GuidedLessonCommand, { action: 'create' }> = {
      ...createSourceCommand(publication),
      objective: 'Explain the running total.',
      audience: 'Beginning Python learners',
      language: LessonLanguage.EN,
      targetDurationSeconds: 120,
      passageIds: [original.passageId],
      teacherInstructions: '',
      codeApproval: {
        code,
        variantOfCodeBlockId: null,
        sourceRefs: [
          { passageId: original.passageId, startOffset: 0, endOffset: original.text.length },
        ],
      },
      practiceCodeApproval: null,
    };
    const incomplete = buildLessonInput(publication, command);
    expect(incomplete.passages).toHaveLength(3);
    expect(
      validateLessonInput(incomplete).some((issue) =>
        issue.observed.includes('omits its published teacher correction'),
      ),
    ).toBe(true);
    const corrected = buildLessonInput(publication, {
      ...command,
      codeApproval: {
        code,
        variantOfCodeBlockId: null,
        sourceRefs: passages.map((passage) => ({
          passageId: passage.passageId,
          startOffset: 0,
          endOffset: passage.text.length,
        })),
      },
    });
    expect(validateLessonInput(corrected)).toEqual([]);
    expect(corrected.sourcePacketHash).not.toBe(incomplete.sourcePacketHash);
  });
});
