import { tool } from '@openai/agents';
import { z } from 'zod';
import type { PreparedTaskContext } from './PrepareTaskContext.js';

/** Optional read-only evidence tools. They do not expose writes or action capabilities. */
export function createStudyContextTools(context: PreparedTaskContext) {
  return [
    tool({
      name: 'search_activity_context',
      description:
        'Search authorized session evidence by meaning. Set includeRetained only for an explicit older-history question or retained-task reference. Check coverage/continuation; past state is not current action geometry.',
      parameters: z.strictObject({
        query: z.string().min(1).max(2000),
        cursor: z.string().max(100).nullable(),
        includeRetained: z.boolean(),
      }),
      execute: (input) =>
        context.request({ kind: 'search', generation: context.readGeneration(), ...input }),
    }),
    tool({
      name: 'read_activity_source',
      description: 'Read an exact retained evidence range. Follow nextOffset for omitted details.',
      parameters: z.strictObject({
        sourceId: z.uuid(),
        offset: z.number().int().nonnegative(),
        length: z.number().int().min(1).max(4000),
      }),
      execute: (input) =>
        context.request({ kind: 'read-source', generation: context.readGeneration(), ...input }),
    }),
  ];
}
