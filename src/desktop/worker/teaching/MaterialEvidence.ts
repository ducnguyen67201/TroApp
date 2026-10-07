import { Tiktoken } from 'js-tiktoken/lite';
import o200kRanks from 'js-tiktoken/ranks/o200k_base';
import type { AgentInputItem } from '@openai/agents';
import type { TeachingContext } from '#contracts/Classroom.js';

let encoding: Tiktoken | null = null;

/** Download metadata stays in the desktop; only selected evidence enters the model packet. */
export function projectClassroomForAgent(context: TeachingContext | undefined) {
  if (!context) {
    return null;
  }
  const materialContext = context.materialContext;
  if (!materialContext || !('schemaVersion' in materialContext)) {
    return context;
  }
  return {
    ...context,
    materialContext: {
      schemaVersion: materialContext.schemaVersion,
      status: materialContext.status,
      packet: materialContext.packet,
      missingSourceIds: materialContext.missingSourceIds,
      omittedCount: materialContext.omittedCount,
    },
  };
}

/** Evict whole exchange groups so retained tool results never lose their matching calls. */
export function countMaterialHistoryTokens(
  context: TeachingContext | undefined,
  exchanges: readonly AgentInputItem[][],
): number {
  encoding ??= new Tiktoken(o200kRanks);
  const material = projectClassroomForAgent(context)?.materialContext ?? null;
  const results = exchanges
    .flat()
    .filter(
      (item) =>
        'type' in item &&
        item.type === 'function_call_result' &&
        [
          'read_class_material_source',
          'search_class_material',
          'read_class_material_note',
        ].includes(item.name),
    );
  return encoding.encode(JSON.stringify({ material, results }), [], []).length;
}
