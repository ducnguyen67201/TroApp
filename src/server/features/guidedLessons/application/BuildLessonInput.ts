import { createHash, randomUUID } from 'node:crypto';
import {
  LessonInputSchema,
  SourcePassageKind,
  LessonTemplateKind,
  type SourcePassage,
  type GuidedLessonCommand,
  type LessonInput,
} from '#contracts/GuidedLessons.js';
import type { MaterialPublication } from '#contracts/ClassroomMaterials.js';
import type { MaterialSourcePassage } from '#contracts/MaterialContext.js';
import { serializeLessonValue } from '#contracts/LessonValue.js';
import { readPublicationPassages } from '../../materials/application/MaterialSourceSelection.js';
import { LessonError, LessonFailure } from './LessonFailure.js';
import { compileAccumulator } from '../domain/CompileAccumulator.js';

export function hashLessonValue(value: unknown): string {
  return createHash('sha256').update(serializeLessonValue(value)).digest('hex');
}

export function hashLessonText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Links have no file digest; bind document corrections to ordered published text, not remote bytes. */
function hashDocumentSourceText(
  sourcePassages: readonly MaterialSourcePassage[],
  materialId: string,
): string {
  return hashLessonValue(
    sourcePassages
      .filter((passage) => passage.materialId === materialId)
      .map((passage) => ({ passageId: passage.id, text: passage.text })),
  );
}

/** Preserve material identity and exact ranges; corrections have their own citable text and digest. */
export function buildPublicationLessonPassages(publication: MaterialPublication): SourcePassage[] {
  const sourcePassages = readPublicationPassages(publication);
  const passages: SourcePassage[] = sourcePassages
    .filter((passage) => passage.text.length > 0)
    .map((passage) => ({
      passageId: passage.id,
      materialId: passage.materialId,
      publicationId: publication.courseId,
      ownerSourceId: passage.id,
      kind: SourcePassageKind.SOURCE_TEXT,
      correctsPassageIds: [],
      pageId: passage.sourceUnitId,
      sourceDigest:
        publication.sources.find((source) => source.id === passage.materialId)?.digest ||
        hashLessonText(passage.text),
      textDigest: hashLessonText(passage.text),
      text: passage.text,
    }));
  for (const page of publication.draft.pages) {
    if (!page.teacherNote?.trim()) {
      continue;
    }
    passages.push({
      passageId: `page-correction-${hashLessonText(`${publication.courseId}:${page.id}`).slice(0, 40)}`,
      materialId: page.materialId,
      publicationId: publication.courseId,
      ownerSourceId: page.id,
      kind: SourcePassageKind.PAGE_CORRECTION,
      correctsPassageIds: sourcePassages
        .filter((passage) => passage.sourceUnitId === page.id)
        .map((passage) => passage.id),
      pageId: page.id,
      sourceDigest:
        publication.sources.find((source) => source.id === page.materialId)?.digest ||
        hashLessonText(page.extractedText),
      textDigest: hashLessonText(page.teacherNote),
      text: page.teacherNote,
    });
  }
  if ('schemaVersion' in publication.draft) {
    for (const document of publication.draft.documents) {
      if (!document.teacherNote?.trim()) {
        continue;
      }
      passages.push({
        passageId: `document-correction-${hashLessonText(`${publication.courseId}:${document.materialId}`).slice(0, 40)}`,
        materialId: document.materialId,
        publicationId: publication.courseId,
        ownerSourceId: document.materialId,
        kind: SourcePassageKind.DOCUMENT_CORRECTION,
        correctsPassageIds: sourcePassages
          .filter((passage) => passage.materialId === document.materialId)
          .map((passage) => passage.id),
        pageId: null,
        sourceDigest:
          publication.sources.find((source) => source.id === document.materialId)?.digest ||
          document.sourceDigest ||
          hashDocumentSourceText(sourcePassages, document.materialId),
        textDigest: hashLessonText(document.teacherNote),
        text: document.teacherNote,
      });
    }
  }
  return passages;
}

/** Select the publication's actual section pages and separately citable corrections. */
export function readPublicationSectionPassages(
  section: MaterialPublication['draft']['sections'][number],
  passages: readonly SourcePassage[],
): SourcePassage[] {
  const originals = new Set(
    passages
      .filter((passage) => passage.pageId && section.sourcePageIds.includes(passage.pageId))
      .map((passage) => passage.passageId),
  );
  return passages.filter(
    (passage) =>
      originals.has(passage.passageId) ||
      passage.correctsPassageIds.some((passageId) => originals.has(passageId)),
  );
}

export function buildLessonInput(
  publication: MaterialPublication,
  command: Extract<GuidedLessonCommand, { action: 'create' }>,
): LessonInput {
  const section = publication.draft.sections.find(
    (candidate) => candidate.id === command.conceptId,
  );
  if (
    !section ||
    command.classId !== publication.classId ||
    command.courseRevisionId !== publication.courseId ||
    (command.practiceCodeApproval && !command.codeApproval)
  ) {
    throw new LessonError(LessonFailure.INVALID);
  }
  const allPassages = buildPublicationLessonPassages(publication);
  const sectionPassages = readPublicationSectionPassages(section, allPassages);
  const selectedIds = new Set(command.passageIds);
  const selected = sectionPassages.filter((passage) => selectedIds.has(passage.passageId));
  if (selected.length !== selectedIds.size || selected.length === 0) {
    throw new LessonError(LessonFailure.INVALID);
  }
  const passages = allPassages.filter(
    (passage) =>
      selectedIds.has(passage.passageId) ||
      passage.correctsPassageIds.some((id) => selectedIds.has(id)),
  );
  const codeBlocks: LessonInput['codeBlocks'] = [];
  const traces: LessonInput['traces'] = [];
  if (command.codeApproval) {
    const codeBlockId = randomUUID();
    const compiled = compileAccumulator(
      {
        codeBlockId,
        traceId: randomUUID(),
        approvalReceiptId: command.commandId,
        variantOfCodeBlockId: null,
        code: command.codeApproval.code,
        sourceRefs: command.codeApproval.sourceRefs,
      },
      hashLessonText,
    );
    codeBlocks.push(compiled.codeBlock);
    traces.push(compiled.trace);
    if (command.practiceCodeApproval) {
      const practice = compileAccumulator(
        {
          codeBlockId: randomUUID(),
          traceId: randomUUID(),
          approvalReceiptId: command.commandId,
          variantOfCodeBlockId: codeBlockId,
          code: command.practiceCodeApproval.code,
          sourceRefs: command.practiceCodeApproval.sourceRefs,
        },
        hashLessonText,
      );
      codeBlocks.push(practice.codeBlock);
      traces.push(practice.trace);
    }
  }
  const packet = {
    schemaVersion: '1.0',
    requestId: command.commandId,
    classId: command.classId,
    courseRevisionId: publication.courseId,
    conceptId: command.conceptId,
    objective: command.objective,
    audience: command.audience,
    language: command.language,
    targetDurationSeconds: command.targetDurationSeconds,
    passages,
    codeBlocks,
    traces,
    assets: [],
    templates:
      codeBlocks.length === 0
        ? [
            {
              templateId: LessonTemplateKind.SOURCE_EXPLANATION,
              templateVersion: '1.0.0',
              supportedLayoutVariants: ['standard'],
              contentRules: [
                'Explain only the selected approved passages and their published corrections.',
                'Use short source-cited points and narration without code execution or graded checkpoints.',
                'Essential text is at least 48 canvas pixels.',
              ],
            },
          ]
        : [
            {
              templateId: 'codeTrace',
              templateVersion: '1.0.0',
              supportedLayoutVariants: ['standard', 'wideCode'],
              contentRules: [
                'Essential text is at least 48 canvas pixels.',
                'Only the approved accumulator trace is supported.',
              ],
            },
            {
              templateId: 'checkpoint',
              templateVersion: '1.0.0',
              supportedLayoutVariants: ['standard', 'wideCode'],
              contentRules: ['Pending checkpoints show only the held before state.'],
            },
          ],
    teacherAnswerKeys: [],
    teacherInstructions: command.teacherInstructions,
  };
  return LessonInputSchema.parse({ ...packet, sourcePacketHash: hashLessonValue(packet) });
}
