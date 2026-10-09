import { z } from 'zod';
import { DesktopObservationRegionSchema } from './DesktopObservation.js';
import { TeachingDrawingSchema } from './TeachingDrawing.js';

export const TeachingMessageKind = {
  INSTRUCTION: 'instruction',
  QUESTION: 'question',
  COMPLETION: 'completion',
} as const;

export const TeachingPresentationLimits = {
  MAX_CHARACTERS: 600,
  WORD_MS: 90,
  HOLD_MS: 2000,
  FADE_MS: 2800,
} as const;

/** Host-owned identity travels with text; meter updates cannot restart its animation. */
export const TeachingMessageSchema = z.strictObject({
  lessonId: z.uuid(),
  stepId: z.uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(TeachingMessageKind),
  text: z.string().trim().min(1).max(TeachingPresentationLimits.MAX_CHARACTERS),
});

export type TeachingMessage = z.infer<typeof TeachingMessageSchema>;

export const TeachingPurpose = { WALKTHROUGH: 'walkthrough', TOUR: 'tour' } as const;

export const TeachingActionKind = {
  CLICK: 'click',
  DRAG: 'drag',
  SCROLL: 'scroll',
  TYPE: 'type',
  KEYBOARD: 'keyboard',
  HIGHLIGHT: 'highlight',
  WAIT: 'wait',
} as const;

export const TeachingAssessment = {
  REACHED: 'reached',
  PENDING: 'pending',
  DEVIATED: 'deviated',
  UNCERTAIN: 'uncertain',
} as const;

export const TeachingGoalCriteriaSchema = z.array(z.string().trim().min(1).max(400)).min(1).max(8);

export const DefineTeachingGoalSchema = z.strictObject({
  purpose: z.enum(TeachingPurpose),
  outcome: z.string().trim().min(1).max(600),
  criteria: TeachingGoalCriteriaSchema,
});

export const ReviseTeachingGoalSchema = z.strictObject({
  previousRevisionId: z.uuid(),
  definition: DefineTeachingGoalSchema,
  reason: z.string().trim().min(1).max(600),
  captureId: z.string().min(1).max(256),
});

export const TeachingGoalEvidenceSchema = z
  .array(
    z.strictObject({
      criterionId: z.uuid(),
      captureId: z.string().min(1).max(256),
      observation: z.string().trim().min(1).max(600),
    }),
  )
  .max(8);
const LabelSchema = z.string().trim().min(1).max(160);
const TargetSchema = z.strictObject({ label: LabelSchema, bounds: DesktopObservationRegionSchema });
export const TeachingActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(TeachingActionKind.CLICK), target: TargetSchema }),
  z.strictObject({
    kind: z.literal(TeachingActionKind.DRAG),
    source: TargetSchema,
    destination: TargetSchema,
  }),
  z.strictObject({
    kind: z.literal(TeachingActionKind.SCROLL),
    viewport: TargetSchema,
    direction: z.enum(['up', 'down', 'left', 'right']),
  }),
  z.strictObject({
    kind: z.literal(TeachingActionKind.TYPE),
    target: TargetSchema,
    focused: z.boolean(),
    text: z.string().min(1).max(500),
    submit: z.boolean(),
  }),
  z.strictObject({ kind: z.literal(TeachingActionKind.KEYBOARD), shortcut: LabelSchema }),
  z.strictObject({ kind: z.literal(TeachingActionKind.HIGHLIGHT), target: TargetSchema }),
  z.strictObject({
    kind: z.literal(TeachingActionKind.WAIT),
    evidence: z.string().trim().min(1).max(600),
  }),
]);

export type TeachingAction = z.infer<typeof TeachingActionSchema>;

export const PresentTeachingStepSchema = z
  .strictObject({
    captureId: z.string().min(1).max(256),
    goalRevisionId: z.uuid(),
    checkpointId: z.uuid().nullable(),
    previousStepAssessment: z.enum(TeachingAssessment).nullable(),
    assessmentEvidence: z.string().trim().min(1).max(600),
    instruction: z.string().trim().min(1).max(TeachingPresentationLimits.MAX_CHARACTERS),
    expectedResult: z.string().trim().min(1).max(750),
    action: TeachingActionSchema,
    drawing: TeachingDrawingSchema.nullable(),
  })
  .superRefine((proposal, context) => {
    const isTextOnly =
      proposal.action.kind === TeachingActionKind.KEYBOARD ||
      proposal.action.kind === TeachingActionKind.WAIT ||
      (proposal.action.kind === TeachingActionKind.TYPE && proposal.action.focused);
    if (isTextOnly !== (proposal.drawing === null)) {
      context.addIssue({
        code: 'custom',
        path: ['drawing'],
        message: isTextOnly
          ? 'Keyboard, focused typing and loading waits require drawing: null.'
          : 'Spatial actions require a drawing with valid strokes.',
      });
    }
  });

export type PresentTeachingStep = z.infer<typeof PresentTeachingStepSchema>;

export const TeachingPresentationReceiptSchema = z
  .strictObject({
    lessonId: z.uuid(),
    stepId: z.uuid(),
    presentationId: z.uuid(),
    goalRevisionId: z.uuid(),
    captureId: z.string().min(1).max(256),
    messagePresented: z.literal(true),
    drawingPresented: z.boolean(),
    textOnly: z.boolean(),
    interrupted: z.boolean(),
  })
  .refine((receipt) => receipt.textOnly || receipt.drawingPresented);

export type TeachingPresentationReceipt = z.infer<typeof TeachingPresentationReceiptSchema>;
