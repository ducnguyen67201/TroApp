import { z } from 'zod';

export const DesktopPermissionState = {
  READY: 'ready',
  NEEDS_PERMISSION: 'needs-permission',
  UNKNOWN: 'unknown',
} as const;

export const PermissionGrant = {
  GRANTED: 'granted',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
  NOT_REQUIRED: 'not-required',
} as const;

export const PermissionArea = {
  ACCESSIBILITY: 'accessibility',
  SCREEN_RECORDING: 'screen-recording',
} as const;

export const DesktopPermissionStatusSchema = z.strictObject({
  kind: z.enum(DesktopPermissionState),
  accessibility: z.enum(PermissionGrant),
  screenRecording: z.enum(PermissionGrant),
});

export type DesktopPermissionStatus = z.infer<typeof DesktopPermissionStatusSchema>;

export type PermissionArea = (typeof PermissionArea)[keyof typeof PermissionArea];

export const PermissionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('request') }),
  z.strictObject({ kind: z.literal('open-settings'), area: z.enum(PermissionArea) }),
]);

export const PermissionActionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opened') }),
  z.strictObject({ kind: z.literal('failed'), message: z.string() }),
]);

export type PermissionActionResult = z.infer<typeof PermissionActionResultSchema>;
