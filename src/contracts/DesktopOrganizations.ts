import { z } from 'zod';
import { OrganizationCommandSchema } from './Organizations.js';

/** Pins a Settings request to the signed-in account that initiated it. */
export const DesktopOrganizationRequestSchema = z.strictObject({
  expectedAccountId: z.string().min(1).max(200),
  command: OrganizationCommandSchema,
});

export type DesktopOrganizationRequest = z.infer<typeof DesktopOrganizationRequestSchema>;
