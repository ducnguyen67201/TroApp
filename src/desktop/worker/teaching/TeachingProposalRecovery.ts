import { z } from 'zod';
import { GuidanceReason } from '#contracts/CursorCompanion.js';
import { TeachingFailure, TeachingFailureCode } from './TeachingFailure.js';

export interface TeachingProposalIssue {
  path: string;
  code: string;
}

export interface TeachingProposalRejection {
  attempt: number;
  issues: TeachingProposalIssue[];
  exhausted: boolean;
}

/** Per SDK segment. Invalid model arguments may be corrected twice; execution
 * failures still propagate. Feedback contains field paths, never input values. */
export class TeachingProposalRecovery {
  private rejectedCount = 0;

  constructor(private readonly report: (rejection: TeachingProposalRejection) => void) {}

  rejectInput(error: unknown): string {
    if (!(error instanceof Error) || error.constructor.name !== 'InvalidToolInputError') {
      throw error;
    }
    const details = z.object({ originalError: z.unknown().optional() }).parse(error);
    const issues =
      details.originalError instanceof z.ZodError
        ? details.originalError.issues.slice(0, 8).map((issue) => ({
            path: issue.path.map(String).join('.').slice(0, 200),
            code: issue.code,
          }))
        : [{ path: 'proposal', code: 'invalid_tool_input' }];
    return this.rejectFields(issues);
  }

  rejectFields(issues: TeachingProposalIssue[]): string {
    this.rejectedCount += 1;
    const exhausted = this.rejectedCount > 2;
    this.report({ attempt: this.rejectedCount, issues, exhausted });
    if (exhausted) {
      throw new TeachingFailure(
        TeachingFailureCode.MODEL_INPUT_INVALID,
        GuidanceReason.INVALID_REQUEST,
        { invalidFields: issues.map((issue) => issue.path) },
      );
    }
    return JSON.stringify({
      admitted: false,
      reason: 'invalid_tool_input',
      issues,
      correctionAttemptsRemaining: 3 - this.rejectedCount,
      instruction:
        'The proposal was rejected before presentation; no message or drawing was shown. Correct the listed fields and resubmit present_teaching_step using a current capture. Rectangle x/y must be within [0,1], width/height must be positive, x + width <= 1 and y + height <= 1. Preserve the original goal. Do not claim presentation succeeded.',
    });
  }
}
