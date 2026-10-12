import { z } from 'zod';

const ClassroomInsightConfigSchema = z.strictObject({
  collectionPolicy: z.string().trim().min(1).max(200),
  retentionDays: z.number().int().min(1).max(3650),
});

/** Collection provenance and rolling retention for accepted classroom work. */
export const ClassroomInsightConfig = {
  collectionPolicy: 'classroom-learning-v1',
  retentionDays: 180,
} as const satisfies z.input<typeof ClassroomInsightConfigSchema>;

export type ClassroomInsightSettings = z.output<typeof ClassroomInsightConfigSchema>;

/** Validate before opening persistence or scheduling retention work. */
export function readClassroomInsightConfig(
  configuration: ClassroomInsightSettings = ClassroomInsightConfig,
): ClassroomInsightSettings {
  const parsed = ClassroomInsightConfigSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new Error('Classroom insight configuration is invalid.');
  }
  return parsed.data;
}
