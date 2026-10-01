import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { AgentResultSchema, type AgentResult } from '#contracts/AgentSession.js';
import { AuthResultSchema, type AuthResult } from '#contracts/AuthSession.js';
import {
  DesktopPermissionStatusSchema,
  PermissionActionResultSchema,
  type DesktopPermissionStatus,
  type PermissionActionResult,
  type PermissionArea,
} from '#contracts/DesktopPermissions.js';

/* Expose named session operations, not generic IPC or direct computer tools.
   Validate IPC data before it enters the renderer. */
const bridge: DesktopBridge = {
  async readAuthSession(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'status' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not check your sign-in.' };
    }
  },
  async signInWithGoogle(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'sign-in-google' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open Google sign-in.' };
    }
  },
  async signOut(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'sign-out' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
  },
  async readDesktopPermissions(): Promise<DesktopPermissionStatus> {
    try {
      return DesktopPermissionStatusSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'status' }),
      );
    } catch {
      return { kind: 'unknown', accessibility: 'unknown', screenRecording: 'unknown' };
    }
  },
  async requestDesktopPermissions(): Promise<PermissionActionResult> {
    try {
      return PermissionActionResultSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'request' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open macOS permission setup.' };
    }
  },
  async openDesktopPermissionSettings(area: PermissionArea): Promise<PermissionActionResult> {
    try {
      return PermissionActionResultSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'open-settings', area }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open System Settings.' };
    }
  },
  async startAgentSession(): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'start' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not start the agent session.' };
    }
  },
  async sendAgentMessage(sessionId: string, message: string): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'turn', sessionId, message }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not send the message to the agent.' };
    }
  },
  async stopAgentSession(sessionId: string): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'stop', sessionId }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not stop the agent session.' };
    }
  },
};

contextBridge.exposeInMainWorld('tro', bridge);
