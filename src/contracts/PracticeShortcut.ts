import { z } from 'zod';

export const PracticeShortcut = {
  MAC_ACCELERATOR: 'Command+K',
  WINDOWS_ACCELERATOR: 'Alt+K',
} as const;

/** Navigation intent only; this event never carries evidence or authorizes hand-in. */
export const PracticeShortcutEventSchema = z.strictObject({
  requestId: z.uuid(),
  captureId: z.uuid().optional(),
  classId: z.uuid(),
  participationId: z.uuid(),
  activityId: z.uuid(),
  attemptId: z.uuid(),
  contextVersion: z.number().int().nonnegative(),
});

export type PracticeShortcutEvent = z.infer<typeof PracticeShortcutEventSchema>;
