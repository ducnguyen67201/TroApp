import { z } from 'zod';

export const TeachingReplyKind = {
  EXPLANATION: 'explanation',
  GUIDE: 'guide',
  NEEDS_INPUT: 'needs_input',
} as const;

export type TeachingReplyKind = (typeof TeachingReplyKind)[keyof typeof TeachingReplyKind];

/** The model proposes the reply purpose; native evidence determines demonstration success. */
export const TeachingReplySchema = z.strictObject({
  kind: z.enum(TeachingReplyKind),
  answer: z.string().trim().min(1),
});
