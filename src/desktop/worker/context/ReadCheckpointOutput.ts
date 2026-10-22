import type { PreparedTaskContext } from './PrepareTaskContext.js';

/** Split optional memory from the ordinary reply; invalid memory never repairs/replays an action. */
export function readCheckpointOutput(raw: unknown, context?: PreparedTaskContext): unknown {
  if (
    !context ||
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    !('checkpointUpdate' in raw)
  ) {
    return raw;
  }
  const { checkpointUpdate, ...normal } = raw;
  context.acceptUpdate(checkpointUpdate);
  return normal;
}
