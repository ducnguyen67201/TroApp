import { z } from 'zod';
import {
  OnboardingAction,
  OnboardingFailure,
  OnboardingStatus,
  OnboardingStep,
  onboardingTourVersion,
} from './OnboardingValues.js';

export const OnboardingProgressSchema = z.strictObject({
  storageVersion: z.literal(1),
  tourVersion: z.literal(onboardingTourVersion),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  status: z.enum(OnboardingStatus),
  stepId: z.enum(OnboardingStep),
});

export type OnboardingProgress = z.infer<typeof OnboardingProgressSchema>;

/** The expected identity fences stale renderer requests; main still derives the disk owner. */
export const OnboardingReadSchema = z.strictObject({
  expectedAccountId: z.string().min(1).max(256),
});

export type OnboardingRead = z.infer<typeof OnboardingReadSchema>;

export const OnboardingRestartSchema = OnboardingReadSchema.extend({
  expectedRevision: OnboardingProgressSchema.shape.revision,
});

export type OnboardingRestart = z.infer<typeof OnboardingRestartSchema>;

export const OnboardingUpdateSchema = OnboardingRestartSchema.extend({
  action: z.enum({
    START: OnboardingAction.START,
    NEXT: OnboardingAction.NEXT,
    BACK: OnboardingAction.BACK,
    DISMISS: OnboardingAction.DISMISS,
  }),
});

export type OnboardingUpdate = z.infer<typeof OnboardingUpdateSchema>;

export const OnboardingReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), progress: OnboardingProgressSchema }),
  z.strictObject({ kind: z.literal('failed'), reason: z.enum(OnboardingFailure) }),
]);

export type OnboardingReply = z.infer<typeof OnboardingReplySchema>;
