import { useCallback, useEffect, useRef } from 'react';
import {
  InsightFailure,
  type ClassroomInsightCommand,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';
import { readInsightBridge } from './InsightBridge.js';

/** Account/class/child/window fencing plus per-query ordering keeps old replies out of new views. */
export function useInsightRequest(
  scope: string,
): (command: ClassroomInsightCommand, channel?: string) => Promise<ClassroomInsightReply> {
  const current = useRef({ scope, generation: 0, sequences: new Map<string, number>() });
  if (current.current.scope !== scope) {
    current.current = { scope, generation: current.current.generation + 1, sequences: new Map() };
  }
  useEffect(
    () => () => {
      current.current.generation += 1;
      current.current.sequences.clear();
    },
    [scope],
  );

  return useCallback(
    async (
      command: ClassroomInsightCommand,
      channel = 'action',
    ): Promise<ClassroomInsightReply> => {
      const state = current.current;
      const generation = state.generation;
      const sequence = (state.sequences.get(channel) ?? 0) + 1;
      state.sequences.set(channel, sequence);
      const send = readInsightBridge()?.controlClassroomInsights;
      if (!send) {
        return { kind: 'failed', code: InsightFailure.UNAVAILABLE };
      }
      try {
        const reply = await send(command);
        if (
          current.current !== state ||
          state.generation !== generation ||
          state.sequences.get(channel) !== sequence
        ) {
          return { kind: 'failed', code: InsightFailure.STALE };
        }
        return reply;
      } catch {
        return { kind: 'failed', code: InsightFailure.UNAVAILABLE };
      }
    },
    [scope],
  );
}
