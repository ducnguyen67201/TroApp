import { createHash } from 'node:crypto';
import type { MaterialPage, MaterialPublication } from '#contracts/ClassroomMaterials.js';
import { MaterialContextLimits, type MaterialSourcePassage } from '#contracts/MaterialContext.js';

/** Stable ranges retain exact text; headings help retrieval without rewriting source evidence. */
export function buildMaterialPassages(pages: readonly MaterialPage[]): MaterialSourcePassage[] {
  return pages.flatMap((page) => {
    const passages: MaterialSourcePassage[] = [];
    let start = 0;
    do {
      let end = Math.min(
        start + MaterialContextLimits.PASSAGE_CHARACTERS,
        page.extractedText.length,
      );
      if (end < page.extractedText.length) {
        const boundary = page.extractedText.lastIndexOf('\n', end);
        if (boundary > start + 1000) {
          end = boundary + 1;
        }
      }
      const text = page.extractedText.slice(start, end);
      const hash = createHash('sha256')
        .update(`${page.id}:${String(start)}:${String(end)}`)
        .digest('hex');
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      passages.push({
        id,
        sourceUnitId: page.id,
        materialId: page.materialId,
        sequence: passages.length,
        start,
        end,
        location: page.location,
        heading:
          text
            .split('\n')
            .find((line) => line.trim())
            ?.slice(0, 200) ?? '',
        text,
        teacherNote: start === 0 ? page.teacherNote : null,
        warnings: [
          ...page.warnings,
          ...(page.extractedText.length > MaterialContextLimits.PASSAGE_CHARACTERS
            ? [
                'This source unit has multiple ordered passages; read neighboring passages for the complete example.',
              ]
            : []),
        ].slice(0, 10),
      });
      start = end;
    } while (start < page.extractedText.length);
    return passages;
  });
}

export function readPublicationPassages(publication: MaterialPublication): MaterialSourcePassage[] {
  const passages =
    'schemaVersion' in publication.draft
      ? publication.draft.passages
      : buildMaterialPassages(publication.draft.pages);
  return passages.map((passage) => ({
    ...passage,
    teacherNote:
      passage.sequence === 0
        ? (publication.draft.pages.find((page) => page.id === passage.sourceUnitId)?.teacherNote ??
          passage.teacherNote)
        : null,
  }));
}

function readSearchTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/đ/g, 'd')
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 1),
    ),
  ];
}

/** Direct passage matches remain reachable even when a document brief omitted the fact. */
export function rankMaterialPassages(
  publication: MaterialPublication,
  activityId: string,
  question: string,
  documentId: string | null = null,
): MaterialSourcePassage[] {
  const pageIds = new Set(
    publication.draft.sections.find((section) => section.id === activityId)?.sourcePageIds ?? [],
  );
  const terms = readSearchTerms(question);
  return readPublicationPassages(publication)
    .filter((passage) => !documentId || passage.materialId === documentId)
    .map((passage, index) => {
      const document =
        'schemaVersion' in publication.draft
          ? publication.draft.documents.find((item) => item.materialId === passage.materialId)
          : null;
      const headings = new Set(
        readSearchTerms(`${passage.heading} ${document?.topics.join(' ') ?? ''}`),
      );
      const content = new Set(
        readSearchTerms(
          `${passage.text} ${passage.teacherNote ?? ''} ${document?.teacherNote ?? ''}`,
        ),
      );
      const score =
        (pageIds.has(passage.sourceUnitId) ? 2 : 0) +
        terms.reduce(
          (sum, term) => sum + (headings.has(term) ? 4 : 0) + (content.has(term) ? 3 : 0),
          0,
        );
      return { passage, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.passage);
}
