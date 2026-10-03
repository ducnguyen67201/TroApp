import { z } from 'zod';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { DesktopLocaleSchema } from '#contracts/DesktopLocale.js';
import {
  ObservationCategory,
  ObservationScope,
  TargetFieldsSchema,
  ObservationFieldsSchema,
} from '../cua/CuaObservation.js';
import { EvidenceContentSchema } from '../cua/CuaTaskEvidence.js';
import { TaskGoalSchema } from './TaskGoal.js';
import type { TaskContext } from './TaskContext.js';
import { assertContextByteBudget } from './TaskContextBudget.js';

const PacketObservationSchema = z.strictObject({
  id: z.string().min(1),
  callId: z.string().min(1),
  taskId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  capturedAtMs: z.number().nonnegative(),
  target: TargetFieldsSchema,
  fields: ObservationFieldsSchema,
  scope: z.enum(ObservationScope),
  category: z.enum(ObservationCategory),
  contentIds: z.array(z.string()),
});

export const TaskEvidencePacketSchema = z.strictObject({
  taskId: z.string().min(1),
  originalRequest: z.string(),
  goal: TaskGoalSchema,
  locale: DesktopLocaleSchema,
  revision: z.number().int().nonnegative(),
  evidenceVersion: z.number().int().nonnegative(),
  observations: z.array(PacketObservationSchema),
  content: z.array(z.strictObject({ id: z.string(), part: EvidenceContentSchema })),
});

export type VerificationEvidencePacket = z.infer<typeof TaskEvidencePacketSchema>;

/** Built only from worker-owned state. Excludes actor claims and prior verdicts. */
export function createVerificationEvidencePacket(
  task: TaskContext,
  locale: DesktopLocale,
): VerificationEvidencePacket {
  task.assertActive();
  const snapshot = task.evidence.readSnapshot();
  const observations = snapshot.observations.filter((item) => task.evidence.isAdmissible(item));
  const content = new Map<string, z.infer<typeof EvidenceContentSchema>>();
  for (const observation of observations) {
    const parts = task.evidence.readContent(observation);
    observation.contentIds.forEach((id, index) => {
      const part = parts[index];
      if (part) {
        content.set(id, part);
      }
    });
  }
  const packet = TaskEvidencePacketSchema.parse({
    taskId: task.id,
    originalRequest: task.instruction,
    goal: task.goal,
    locale,
    revision: snapshot.revision,
    evidenceVersion: snapshot.version,
    observations: observations.map(
      ({
        id,
        callId,
        taskId,
        revision,
        sequence,
        capturedAtMs,
        target,
        fields,
        scope,
        category,
        contentIds,
      }) => ({
        id,
        callId,
        taskId,
        revision,
        sequence,
        capturedAtMs,
        target,
        fields,
        scope,
        category,
        contentIds,
      }),
    ),
    content: [...content].map(([id, part]) => ({ id, part })),
  });
  assertContextByteBudget(packet, task.config.maximumEvidencePacketBytes);
  return packet;
}
