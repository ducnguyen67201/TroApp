import { contextBridge, ipcRenderer } from 'electron';
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
};

contextBridge.exposeInMainWorld('tro', bridge);
