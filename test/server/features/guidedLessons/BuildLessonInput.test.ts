import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MaterialPublicationSchema } from '#contracts/ClassroomMaterials.js';
import {
  SourcePassageKind,
  LessonLanguage,
  type GuidedLessonCommand,
} from '#contracts/GuidedLessons.js';
import {
  buildLessonInput,
  buildPublicationLessonPassages,
  hashLessonText,
} from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { validateLessonInput } from '../../../../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';

function createPublication() {
  const pageId = randomUUID();
  const passageId = randomUUID();
  const materialId = randomUUID();
  const code =
    'numbers = [2, 4, 6]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)';
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
          bytes: code.length,
          digest: hashLessonText(code),
          url: null,
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
            extractedText: code,
            preparedNote: '',
            teacherNote: 'Use total = 0 before the loop.',
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
            end: code.length,
            location: 'Page 1',
            heading: 'Accumulator',
            text: code,
            teacherNote: null,
            warnings: [],
          },
        ],
        documents: [
          {
            materialId,
            sourceDigest: hashLessonText(code),
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
            teacherNote: 'Do not reset total during the loop.',
          },
        ],
      },
    }),
  };
}

describe('guided lesson approved source packet', () => {
  it('preserves original text and separate page/document corrections with exact digests', () => {
    const { publication, code } = createPublication();
    const passages = buildPublicationLessonPassages(publication);
    const original = passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT);
    expect(original?.text).toBe(code);
    expect(original?.textDigest).toBe(hashLessonText(code));
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

  it('requires teacher code citations to include the published corrections before any generation', () => {
    const { publication, code } = createPublication();
    const passages = buildPublicationLessonPassages(publication);
    const original = passages.find((passage) => passage.kind === SourcePassageKind.SOURCE_TEXT);
    if (!original) {
      throw new Error('Missing source fixture.');
    }
    const command: Extract<GuidedLessonCommand, { action: 'create' }> = {
      action: 'create',
      commandId: randomUUID(),
      classId: publication.classId,
      courseRevisionId: publication.courseId,
      conceptId: 'accumulator',
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
