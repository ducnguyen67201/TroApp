import { z } from 'zod';

export const AuthStatus = {
  SIGNED_OUT: 'signed_out',
  NEEDS_WORKSPACE: 'needs_workspace',
  AUTHENTICATED: 'authenticated',
} as const;

export const WorkspaceRole = { OWNER: 'owner', MEMBER: 'member' } as const;

export const GoogleProfileSchema = z.strictObject({
  email: z.email(),
  displayName: z.string().min(1).max(120).nullable(),
  avatarUrl: z.url().nullable(),
});

export const WorkspaceSummarySchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string().min(1).max(80),
  role: z.enum(WorkspaceRole),
});

export const AuthStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal(AuthStatus.SIGNED_OUT) }),
  z.strictObject({
    status: z.literal(AuthStatus.NEEDS_WORKSPACE),
    profile: GoogleProfileSchema,
  }),
  z.strictObject({
    status: z.literal(AuthStatus.AUTHENTICATED),
    profile: GoogleProfileSchema,
    workspace: WorkspaceSummarySchema,
  }),
]);

export type AuthState = z.infer<typeof AuthStateSchema>;

export const DesktopOperationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), state: AuthStateSchema }),
  z.strictObject({ success: z.literal(false), message: z.string().min(1) }),
]);

export type DesktopOperationResult = z.infer<typeof DesktopOperationResultSchema>;

export const StartSignInResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true) }),
  z.strictObject({ success: z.literal(false), message: z.string().min(1) }),
]);

export type StartSignInResult = z.infer<typeof StartSignInResultSchema>;

export const GoogleSignInStartSchema = z.strictObject({ authorizeUrl: z.url() });

export const HandoffExchangeRequestSchema = z.strictObject({ code: z.string().min(32).max(512) });

export const HandoffExchangeResponseSchema = z.strictObject({
  sessionToken: z.string().min(32),
  state: AuthStateSchema,
});

export const WorkspaceCreateRequestSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(80),
});

/** Renderer capabilities. Session credentials never cross this bridge. */
export interface DesktopAuthBridge {
  readAuthState(): Promise<DesktopOperationResult>;
  startGoogleSignIn(): Promise<StartSignInResult>;
  createWorkspace(displayName: string): Promise<DesktopOperationResult>;
  logout(): Promise<DesktopOperationResult>;
  onAuthStateChanged(listener: (state: AuthState) => void): () => void;
}
