import { z } from 'zod';

export const MemoryEvidenceStatus = {
  OBSERVED: 'observed',
  USER_STATED: 'user_stated',
  MODEL_INFERRED: 'model_inferred',
} as const;

export const MemoryClaimSchema = z.strictObject({
  text: z.string().trim().min(1).max(1000),
  sourceIds: z.array(z.uuid()).min(1).max(12),
  status: z.enum(MemoryEvidenceStatus),
});

/** A model may describe evidence; completion, ownership and permissions are host-owned. */
export const CheckpointUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  coveredEventRevision: z.number().int().nonnegative(),
  sourceIds: z.array(z.uuid()).min(1).max(20),
  summary: z.string().trim().max(2400),
  openQuestions: z.array(z.string().trim().min(1).max(400)).max(12),
  claims: z.array(MemoryClaimSchema).max(16),
});

export const SessionCheckpointSchema = CheckpointUpdateSchema.extend({
  revision: z.number().int().nonnegative(),
});

export type CheckpointUpdate = z.infer<typeof CheckpointUpdateSchema>;

export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>;
