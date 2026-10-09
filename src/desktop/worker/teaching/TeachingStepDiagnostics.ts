import type { PresentTeachingStep, TeachingMessage } from '#contracts/TeachingStep.js';
/** Metadata only: ordinary logs contain no instruction or screen pixels. */
export function describeTeachingProposal(proposal: PresentTeachingStep) {
  return {
    actionKind: proposal.action.kind,
    instructionChars: proposal.instruction.length,
    expectedResultChars: proposal.expectedResult.length,
    goalRevisionId: proposal.goalRevisionId,
    checkpointId: proposal.checkpointId,
    previousStepAssessment: proposal.previousStepAssessment,
    strokeCount: proposal.drawing?.strokes.length ?? 0,
    pointCount:
      proposal.drawing?.strokes.reduce((count, stroke) => count + stroke.points.length, 0) ?? 0,
  };
}

export function describeTeachingMessage(message: TeachingMessage | null | undefined) {
  return {
    messageSequence: message?.sequence ?? null,
    messageKind: message?.kind ?? null,
    messageChars: message?.text.length ?? 0,
  };
}
