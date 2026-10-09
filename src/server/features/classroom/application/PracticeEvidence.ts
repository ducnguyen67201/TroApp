import { createHash } from 'node:crypto';
import {
  PracticeEvidenceKind,
  PracticeFailure,
  PracticeLimits,
  type PracticeEvidence,
  type PracticeRecord,
} from '#contracts/PracticeCheck.js';
import { PracticeError } from '../domain/PracticeFindings.js';
import { countTextTokens } from '../../../application/TextTokenCounter.js';

export function countPracticeInput(rubric: unknown, evidence: PracticeEvidence[]): number {
  return (
    countTextTokens(
      JSON.stringify({
        rubric,
        evidence: evidence.map((item) =>
          item.kind === PracticeEvidenceKind.TEXT
            ? item
            : { id: item.id, kind: item.kind, name: item.name },
        ),
      }),
    ) + 1000
  );
}

export function hashPracticePayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Enforces decoded limits and supported image signatures before storage or inference. */
export function describePracticeEvidence(evidence: PracticeEvidence[]): PracticeRecord['evidence'] {
  let total = 0;
  const ids = new Set<string>();
  return evidence.map((item) => {
    const bytes =
      item.kind === PracticeEvidenceKind.TEXT
        ? Buffer.from(item.text, 'utf8')
        : Buffer.from(item.base64, 'base64');
    total += bytes.length;
    if (ids.has(item.id) || total > PracticeLimits.TOTAL_BYTES) {
      throw new PracticeError(PracticeFailure.INVALID);
    }
    ids.add(item.id);
    if (item.kind === PracticeEvidenceKind.DOCUMENT) {
      const validHeader =
        item.mediaType === 'application/pdf'
          ? bytes.subarray(0, 5).toString() === '%PDF-'
          : bytes[0] === 80 && bytes[1] === 75;
      if (
        !validHeader ||
        bytes.length > PracticeLimits.IMAGE_BYTES ||
        bytes.toString('base64') !== item.base64
      ) {
        throw new PracticeError(PracticeFailure.INVALID);
      }
    }
    if (item.kind === PracticeEvidenceKind.IMAGE) {
      if (
        item.capture &&
        item.capture.digest !== createHash('sha256').update(bytes).digest('hex')
      ) {
        throw new PracticeError(PracticeFailure.INVALID);
      }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (
        bytes.length > PracticeLimits.IMAGE_BYTES ||
        bytes.toString('base64') !== item.base64 ||
        (item.mediaType === 'image/png' ? !png : !jpeg)
      ) {
        throw new PracticeError(PracticeFailure.INVALID);
      }
    }
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      ...(item.kind === PracticeEvidenceKind.IMAGE && item.capture
        ? { capture: item.capture }
        : {}),
      byteCount: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}
