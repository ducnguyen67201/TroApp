import { GuidanceReason } from '#contracts/CursorCompanion.js';
import { TeachingFailure, TeachingFailureCode } from './TeachingFailure.js';

/** At most two repairs across schema, native refusals and missing final receipts. */
export class TeachingPresentationBudget {
  private failures = 0;

  reject(reason: string): Record<string, unknown> {
    this.failures += 1;
    if (this.failures > 2) {
      throw new TeachingFailure(
        TeachingFailureCode.PRESENTATION_INCOMPLETE,
        GuidanceReason.INVALID_REQUEST,
      );
    }
    return {
      admitted: false,
      reason,
      repairsRemaining: 2 - this.failures,
      repair:
        'Observe the actual screen and correct the target or action. Do not claim the drawing appeared or blame cursor motion. Preserve the original goal.',
    };
  }

  confirm(): void {
    this.failures = 0;
  }
}
