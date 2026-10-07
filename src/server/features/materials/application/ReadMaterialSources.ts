import type { MaterialPublication } from '#contracts/ClassroomMaterials.js';
import {
  MaterialContextLimits,
  MaterialSourceScope,
  type MaterialSearchResult,
  type MaterialSourceRead,
} from '#contracts/MaterialContext.js';
import { rankMaterialPassages, readPublicationPassages } from './MaterialSourceSelection.js';
import { materialTokenCounter } from './MaterialTokenBudget.js';

/** Call only after classroom authorization; all filters/IDs remain inside the pinned publication. */
export function searchMaterialSources(
  publication: MaterialPublication,
  activityId: string,
  question: string,
  documentId: string | null,
): MaterialSearchResult {
  const ranked = rankMaterialPassages(publication, activityId, question, documentId);
  const result: MaterialSearchResult = { matches: [], hasMore: false };
  for (const passage of ranked) {
    const match = {
      sourceId: passage.id,
      materialId: passage.materialId,
      location: passage.location,
      excerpt: passage.text.slice(0, 300),
    };
    if (
      result.matches.length >= 8 ||
      materialTokenCounter.countText(
        JSON.stringify({ matches: [...result.matches, match], hasMore: true }),
      ) > MaterialContextLimits.SEARCH_TOKENS
    ) {
      result.hasMore = true;
      break;
    }
    result.matches.push(match);
  }
  return result;
}

export function readMaterialSource(
  publication: MaterialPublication,
  sourceId: string,
  scope: (typeof MaterialSourceScope)[keyof typeof MaterialSourceScope],
  offset = 0,
): MaterialSourceRead | null {
  const passages = readPublicationPassages(publication);
  const selected = passages.find((passage) => passage.id === sourceId);
  if (!selected) {
    return null;
  }
  const candidates =
    scope === MaterialSourceScope.PASSAGE
      ? [selected]
      : [
          selected,
          ...passages.filter(
            (passage) =>
              passage.id !== selected.id &&
              passage.sourceUnitId === selected.sourceUnitId &&
              (scope === MaterialSourceScope.SOURCE_UNIT ||
                Math.abs(passage.sequence - selected.sequence) <= 1),
          ),
        ];
  const result: MaterialSourceRead = { evidence: [], continuationSourceIds: [], nextOffset: null };
  for (const passage of candidates) {
    // The offset traverses source text followed by the effective teacher note; neither is silently lost.
    const startOffset = passage.id === sourceId ? offset : 0;
    const length = passage.text.length + (passage.teacherNote?.length ?? 0);
    if (startOffset > length) {
      return null;
    }
    let consumed = length - startOffset;
    let candidate = sliceMaterialEvidence(passage, startOffset, consumed);
    while (
      consumed > 0 &&
      materialTokenCounter.countText(
        JSON.stringify({ ...result, evidence: [...result.evidence, candidate] }),
      ) >
        MaterialContextLimits.READ_TOKENS - 200
    ) {
      consumed = Math.floor(consumed / 2);
      candidate = sliceMaterialEvidence(passage, startOffset, consumed);
    }
    if (startOffset + consumed < passage.text.length && consumed > 0) {
      const newline = passage.text.lastIndexOf('\n', startOffset + consumed - 1);
      if (newline >= startOffset) {
        consumed = newline + 1 - startOffset;
      }
      candidate = sliceMaterialEvidence(passage, startOffset, consumed);
    }
    if (consumed === 0 && length > startOffset) {
      result.continuationSourceIds.push(passage.id);
      continue;
    }
    result.evidence.push(candidate);
    if (startOffset + consumed < length) {
      result.continuationSourceIds.push(passage.id);
      if (passage.id === sourceId) {
        result.nextOffset = startOffset + consumed;
      }
    }
  }
  return result;
}

function sliceMaterialEvidence(
  passage: import('#contracts/MaterialContext.js').MaterialSourcePassage,
  offset: number,
  length: number,
) {
  const textStart = Math.min(offset, passage.text.length);
  const textEnd = Math.min(offset + length, passage.text.length);
  const noteStart = Math.max(0, offset - passage.text.length);
  const noteEnd = Math.max(0, offset + length - passage.text.length);
  const warnings = passage.warnings.slice(0, 2).map((warning) => warning.slice(0, 200));
  if (passage.warnings.length > 2 || passage.warnings.some((warning) => warning.length > 200)) {
    warnings.push('Additional extraction warnings remain with the original material.');
  }
  if (offset > 0 || offset + length < passage.text.length + (passage.teacherNote?.length ?? 0)) {
    warnings.push(
      'Partial source read. Follow continuation IDs and offsets for the complete example.',
    );
  }
  return {
    ...passage,
    warnings,
    text: passage.text.slice(textStart, textEnd),
    start: passage.start + textStart,
    end: passage.start + textEnd,
    teacherNote:
      noteEnd > noteStart ? (passage.teacherNote?.slice(noteStart, noteEnd) ?? null) : null,
  };
}
