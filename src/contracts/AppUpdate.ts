import { z } from 'zod';

export const AppUpdateState = {
  DISABLED: 'disabled',
  CHECKING: 'checking',
  CURRENT: 'current',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  RESTARTING: 'restarting',
  ERROR: 'error',
} as const;

export const AppUpdatePhase = { CHECK: 'check', DOWNLOAD: 'download', INSTALL: 'install' } as const;

export const AppUpdateCommand = {
  STATUS: 'status',
  CHECK: 'check',
  DOWNLOAD: 'download',
  RESTART: 'restart',
} as const;

export const AppUpdateFailure = { BUSY: 'busy', UNAVAILABLE: 'unavailable' } as const;

export const AppUpdateVersionSchema = z.string().min(1).max(128);

/** Release feeds are public, build-owned HTTPS addresses, never renderer input. */
export const AppUpdateUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

export const AppUpdateStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal(AppUpdateState.DISABLED) }),
  z.strictObject({ state: z.literal(AppUpdateState.CHECKING) }),
  z.strictObject({ state: z.literal(AppUpdateState.CURRENT) }),
  z.strictObject({ state: z.literal(AppUpdateState.AVAILABLE), version: AppUpdateVersionSchema }),
  z.strictObject({
    state: z.literal(AppUpdateState.DOWNLOADING),
    version: AppUpdateVersionSchema,
    percent: z.number().min(0).max(100),
  }),
  z.strictObject({ state: z.literal(AppUpdateState.READY), version: AppUpdateVersionSchema }),
  z.strictObject({ state: z.literal(AppUpdateState.RESTARTING), version: AppUpdateVersionSchema }),
  z.strictObject({
    state: z.literal(AppUpdateState.ERROR),
    phase: z.enum(AppUpdatePhase),
    version: AppUpdateVersionSchema.nullable(),
  }),
]);

export type AppUpdateStatus = z.infer<typeof AppUpdateStatusSchema>;

/** Monotonic revisions prevent a slow initial read from replacing a newer event. */
export const AppUpdateSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  status: AppUpdateStatusSchema,
});

export type AppUpdateSnapshot = z.infer<typeof AppUpdateSnapshotSchema>;

export const AppUpdateCommandSchema = z.strictObject({ kind: z.enum(AppUpdateCommand) });

export const AppUpdateReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), snapshot: AppUpdateSnapshotSchema }),
  z.strictObject({ kind: z.literal('failed'), reason: z.enum(AppUpdateFailure) }),
]);

export type AppUpdateReply = z.infer<typeof AppUpdateReplySchema>;
