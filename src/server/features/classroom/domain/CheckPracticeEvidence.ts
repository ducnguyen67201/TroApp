import { PracticeFinding, type PracticeCheckpoint } from '#contracts/PracticeCheck.js';
import type { PracticeEvidenceUnit } from '#contracts/PracticeAssessment.js';

interface ScratchBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  topLevel: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readScratchBlock(value: unknown): ScratchBlock | null {
  if (
    !isRecord(value) ||
    typeof value.opcode !== 'string' ||
    (value.next != null && typeof value.next !== 'string') ||
    (value.parent != null && typeof value.parent !== 'string')
  ) {
    return null;
  }
  return {
    opcode: value.opcode,
    next: typeof value.next === 'string' ? value.next : null,
    parent: typeof value.parent === 'string' ? value.parent : null,
    topLevel: value.topLevel === true,
  };
}

/** Follows the next-chain from a real top-level event. Detached matching blocks do not count. */
export function hasConnectedScratchBlock(
  text: string,
  eventOpcode: string,
  blockOpcode: string,
): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(raw) || !isRecord(raw.blocks)) {
    return false;
  }
  const blocks = new Map<string, ScratchBlock>();
  for (const [id, value] of Object.entries(raw.blocks)) {
    const block = readScratchBlock(value);
    if (block) {
      blocks.set(id, block);
    }
  }
  for (const [eventId, event] of blocks) {
    if (event.opcode !== eventOpcode || event.parent != null || !event.topLevel) {
      continue;
    }
    let currentId = event.next;
    let previousId = eventId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const block = blocks.get(currentId);
      if (!block || block.parent !== previousId) {
        break;
      }
      if (block.opcode === blockOpcode) {
        return true;
      }
      previousId = currentId;
      currentId = block.next;
    }
  }
  return false;
}

/** Exact output checks compare supplied text only; they make no execution claim. */
export function checkPracticeEvidence(
  criterion: PracticeCheckpoint['criteria'][number],
  units: PracticeEvidenceUnit[],
): { finding: PracticeFinding; evidenceIds: string[] } {
  const rule = criterion.verification;
  if (!units.length || !rule || rule.kind === 'llm' || rule.kind === 'teacher') {
    return { finding: PracticeFinding.INSUFFICIENT_EVIDENCE, evidenceIds: [] };
  }
  const matches = units.filter((unit) =>
    rule.kind === 'exact-output'
      ? unit.text.replace(/\r\n/g, '\n').trim() === rule.expectedText.replace(/\r\n/g, '\n').trim()
      : hasConnectedScratchBlock(unit.text, rule.eventOpcode, rule.blockOpcode),
  );
  return {
    finding: matches.length ? PracticeFinding.MET : PracticeFinding.NEEDS_CHANGES,
    evidenceIds: [...new Set((matches.length ? matches : units).map((unit) => unit.evidenceId))],
  };
}
