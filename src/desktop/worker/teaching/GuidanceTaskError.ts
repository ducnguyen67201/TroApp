import type { GuidanceReason } from '#contracts/CursorCompanion.js';

/** A typed native terminal result survives the SDK abort and task cleanup. */
export class GuidanceTaskError extends Error {
  constructor(
    readonly reason: GuidanceReason,
    readonly canceled = false,
  ) {
    super(reason);
    this.name = 'GuidanceTaskError';
  }
}
