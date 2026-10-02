import { z } from 'zod';

/** Main selects the private MCP endpoint; this never crosses renderer IPC. */
export const DesktopDriverConnectionSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

export type DesktopDriverConnection = z.infer<typeof DesktopDriverConnectionSchema>;
