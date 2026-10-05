import { ipcRenderer } from 'electron';
import {
  PetOverlayCommandSchema,
  PetSnapshotSchema,
  type PetOverlayBridge,
} from '#contracts/Pet.js';

/** Deliberately separate from the workspace's agent, auth, audio and OS bridge. */
export const petOverlayBridge: PetOverlayBridge = {
  async readPet() {
    const value: unknown = await ipcRenderer.invoke('tro:pet-overlay-read');
    return PetSnapshotSchema.parse(value);
  },
  subscribePet(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = PetSnapshotSchema.safeParse(value);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:pet-snapshot', receive);
    return () => {
      ipcRenderer.removeListener('tro:pet-snapshot', receive);
    };
  },
  interactWithPet(command) {
    ipcRenderer.send('tro:pet-overlay-command', PetOverlayCommandSchema.parse(command));
  },
};
