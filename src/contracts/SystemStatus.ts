import { z } from 'zod';

export const DatabaseAvailability = { READY: 'ready', UNAVAILABLE: 'unavailable' } as const;

export const SystemStatusSchema = z.strictObject({
  service: z.literal('tro-api'),
  database: z.enum(DatabaseAvailability),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const SystemStatusResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), status: SystemStatusSchema }),
  z.strictObject({ success: z.literal(false), message: z.string() }),
]);

export type SystemStatusResult = z.infer<typeof SystemStatusResultSchema>;

/** Public desktop capabilities; generic IPC and network access are deliberately absent. */
export interface DesktopBridge {
  readServiceStatus(): Promise<SystemStatusResult>;
}
