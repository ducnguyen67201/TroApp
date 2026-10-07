import { getEncoding } from 'js-tiktoken';
import { createHash } from 'node:crypto';
import {
  PracticeFailure,
  PracticeLimits,
  type PracticeEvidence,
  type PracticeRecord,
} from '#contracts/PracticeCheck.js';
import { PracticeError } from '../domain/PracticeFindings.js';
const encoding = getEncoding('o200k_base');
export function countPracticeInput(rubric: unknown, evidence: PracticeEvidence[]): number {
  return (
    encoding.encode(
      JSON.stringify({
        rubric,
        evidence: evidence.map((item) =>
          item.kind === 'text' ? item : { id: item.id, kind: item.kind, name: item.name },
        ),
      }),
    ).length + 1000
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
      item.kind === 'text' ? Buffer.from(item.text, 'utf8') : Buffer.from(item.base64, 'base64');
    total += bytes.length;
    if (ids.has(item.id) || total > PracticeLimits.TOTAL_BYTES) {
      throw new PracticeError(PracticeFailure.INVALID);
    }
    ids.add(item.id);
    if (item.kind === 'image') {
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
      byteCount: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}
