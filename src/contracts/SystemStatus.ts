import { z } from 'zod';

export const DatabaseAvailability = { READY: 'ready', UNAVAILABLE: 'unavailable' } as const;

export const SystemStatusSchema = z.strictObject({
  service: z.literal('tro-api'),
  database: z.enum(DatabaseAvailability),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;
