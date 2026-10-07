import { getEncoding } from 'js-tiktoken';
import {
  MaterialContextLimits,
  MaterialContextStatus,
  type MaterialPacket,
  type MaterialContextSelection,
  type MaterialSourcePassage,
} from '#contracts/MaterialContext.js';

export interface MaterialTokenCounter {
  countText(text: string): number;
}
let encoding: ReturnType<typeof getEncoding> | null = null;
/** Local text estimate using bundled o200k ranks. Visual/protocol overhead is counted separately. */
export const materialTokenCounter: MaterialTokenCounter = {
  countText(text) {
    encoding ??= getEncoding('o200k_base');
    return encoding.encode(text, [], []).length;
  },
};

export function selectMaterialPacket(
  base: Omit<MaterialPacket, 'evidence'>,
  requiredIds: readonly string[],
  ranked: readonly MaterialSourcePassage[],
  counter: MaterialTokenCounter = materialTokenCounter,
): MaterialContextSelection {
  let packet: MaterialPacket = { ...base, evidence: [] };
  let tokens = counter.countText(JSON.stringify(packet));
  const ids = new Set<string>();
  const missingSourceIds: string[] = [];
  if (tokens > MaterialContextLimits.MAXIMUM_TOKENS) {
    return {
      status: MaterialContextStatus.NEEDS_EXPANSION,
      packet: null,
      tokens: 0,
      missingSourceIds: [...new Set(requiredIds)],
      omittedCount: ranked.length,
    };
  }
  for (const id of new Set(requiredIds)) {
    const passage = ranked.find((item) => item.id === id);
    if (!passage) {
      throw new Error('Material dependency references an unknown source.');
    }
    const candidate = { ...packet, evidence: [...packet.evidence, passage] };
    const size = counter.countText(JSON.stringify(candidate));
    if (size > MaterialContextLimits.MAXIMUM_TOKENS) {
      missingSourceIds.push(id);
      continue;
    }
    packet = candidate;
    tokens = size;
    ids.add(id);
  }
  if (missingSourceIds.length === 0) {
    for (const passage of ranked) {
      if (ids.has(passage.id)) {
        continue;
      }
      const candidate = { ...packet, evidence: [...packet.evidence, passage] };
      const size = counter.countText(JSON.stringify(candidate));
      if (size <= MaterialContextLimits.TARGET_TOKENS) {
        packet = candidate;
        tokens = size;
        ids.add(passage.id);
      }
    }
  }
  return {
    status: missingSourceIds.length
      ? MaterialContextStatus.NEEDS_EXPANSION
      : MaterialContextStatus.READY,
    packet,
    tokens,
    missingSourceIds,
    omittedCount: ranked.length - ids.size,
  };
}
