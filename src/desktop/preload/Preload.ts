import { contextBridge, ipcRenderer } from 'electron';
import {
  AuthStateSchema,
  DesktopOperationResultSchema,
  StartSignInResultSchema,
  type AuthState,
  type DesktopOperationResult,
  type StartSignInResult,
} from '#contracts/Auth.js';
import {
  SystemStatusResultSchema,
  type DesktopBridge,
  type SystemStatusResult,
} from '#contracts/SystemStatus.js';

/* Expose only the status capability, and validate IPC data before it enters
   the renderer even though the response came from our own main process. */
const bridge: DesktopBridge = {
  async readServiceStatus(): Promise<SystemStatusResult> {
    try {
      return SystemStatusResultSchema.parse(await ipcRenderer.invoke('tro:read-service-status'));
    } catch {
      return { success: false, message: 'Could not read service status.' };
    }
  },
  async readAuthState(): Promise<DesktopOperationResult> {
    try {
      return DesktopOperationResultSchema.parse(await ipcRenderer.invoke('tro:read-auth-state'));
    } catch {
      return { success: false, message: 'Could not read your sign-in state.' };
    }
  },
  async startGoogleSignIn(): Promise<StartSignInResult> {
    try {
      return StartSignInResultSchema.parse(await ipcRenderer.invoke('tro:start-google-sign-in'));
    } catch {
      return { success: false, message: 'Could not start Google sign-in.' };
    }
  },
  async createWorkspace(displayName: string): Promise<DesktopOperationResult> {
    try {
      return DesktopOperationResultSchema.parse(
        await ipcRenderer.invoke('tro:create-workspace', displayName),
      );
    } catch {
      return { success: false, message: 'Could not create the workspace.' };
    }
  },
  async logout(): Promise<DesktopOperationResult> {
    try {
      return DesktopOperationResultSchema.parse(await ipcRenderer.invoke('tro:logout'));
    } catch {
      return { success: false, message: 'Could not sign out.' };
    }
  },
  onAuthStateChanged(listener: (state: AuthState) => void): () => void {
    const receiveState = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = AuthStateSchema.safeParse(value);

      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:auth-state-changed', receiveState);

    return () => {
      ipcRenderer.removeListener('tro:auth-state-changed', receiveState);
    };
  },
};

contextBridge.exposeInMainWorld('tro', bridge);
