import { BrowserWindow, screen } from 'electron';
import {
  PetGeometry,
  PetOverlayAction,
  type PetSnapshot,
  type PetPlacement,
  type PetOverlayCommand,
} from '#contracts/Pet.js';
import { isTrustedFrameUrl } from '../TrustedFrame.js';
import { isPointerInsidePet, placePetOnDisplay, savePetPosition } from './PetPlacement.js';
import type { PetPresentation } from './PetController.js';

interface PetWindowOptions {
  preloadFile: string;
  rendererFile: string;
  documentUrl: string;
  developmentUrl: string | undefined;
  savePlacement: (placement: PetPlacement) => void;
  reportFailure: () => void;
}

/** Optional desktop presentation. Never focuses a window or starts native input hooks. */
export class PetWindow implements PetPresentation {
  private window: BrowserWindow | null = null;
  private snapshot: PetSnapshot | null = null;
  private loaded = false;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private dragTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastPlacement: PetPlacement | null = null;
  private readonly reposition = (): void => {
    this.restorePosition();
  };

  constructor(private readonly options: PetWindowOptions) {
    screen.on('display-removed', this.reposition);
    screen.on('display-metrics-changed', this.reposition);
  }

  showPet(snapshot: PetSnapshot): void {
    this.snapshot = snapshot;
    if (!this.window) {
      this.createWindow();
    }
    if (!this.loaded || !this.window) {
      return;
    }
    if (
      !this.window.isVisible() ||
      !hasSamePlacement(this.lastPlacement, snapshot.preferences.placement)
    ) {
      if (!this.dragTimer) {
        this.restorePosition();
      }
    }
    this.lastPlacement = snapshot.preferences.placement;
    this.window.webContents.send('tro:pet-snapshot', snapshot);
    this.window.showInactive();
  }

  hidePet(): void {
    if (this.snapshot && this.loaded) {
      this.window?.webContents.send('tro:pet-snapshot', { ...this.snapshot, isVisible: false });
    }
    this.snapshot = null;
    this.finishDrag(false);
    this.window?.hide();
  }

  isTrustedSender(event: { sender: unknown; senderFrame: { url: string } | null }): boolean {
    const window = this.window;
    return Boolean(
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url, this.options.documentUrl),
    );
  }

  receiveInteraction(command: PetOverlayCommand): void {
    if (!this.window || !this.snapshot?.isVisible) {
      return;
    }
    if (command.kind === PetOverlayAction.END_DRAG) {
      this.finishDrag(true);
      return;
    }
    const bounds = this.window.getBounds();
    const pointer = screen.getCursorScreenPoint();
    const inside = isPointerInsidePet(pointer, bounds);
    if (command.kind === PetOverlayAction.HOVER) {
      if (!this.dragTimer) {
        this.window.setIgnoreMouseEvents(!inside, { forward: true });
      }
    } else if (command.kind === PetOverlayAction.START_DRAG && inside) {
      this.startDrag(pointer, bounds);
    }
  }

  canReact(): boolean {
    return Boolean(
      this.window &&
      this.snapshot?.isVisible &&
      !this.dragTimer &&
      isPointerInsidePet(screen.getCursorScreenPoint(), this.window.getBounds()),
    );
  }

  closePet(): void {
    this.hidePet();
    const window = this.window;
    this.window = null;
    this.loaded = false;
    window?.destroy();
  }

  dispose(): void {
    this.closePet();
    screen.removeListener('display-removed', this.reposition);
    screen.removeListener('display-metrics-changed', this.reposition);
  }

  private createWindow(): void {
    const window = new BrowserWindow({
      width: PetGeometry.WIDTH,
      height: PetGeometry.HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: this.options.preloadFile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'tro-pet',
        additionalArguments: ['--tro-pet-overlay'],
      },
    });
    this.window = window;
    this.loaded = false;
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.webContents.on('render-process-gone', () => {
      this.failWindow(window);
    });
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null;
        this.loaded = false;
        this.finishDrag(false);
      }
    });
    const loading = this.options.developmentUrl
      ? window.loadURL(this.options.developmentUrl)
      : window.loadFile(this.options.rendererFile);
    void loading
      .then(() => {
        if (this.window !== window || window.isDestroyed()) {
          return;
        }
        this.loaded = true;
        if (this.snapshot) {
          this.showPet(this.snapshot);
        }
      })
      .catch(() => {
        this.failWindow(window);
      });
  }

  private failWindow(window: BrowserWindow): void {
    if (this.window !== window) {
      return;
    }
    console.warn('pet.presentation.failed', { stage: 'overlay' });
    this.window = null;
    this.loaded = false;
    this.finishDrag(false);
    window.destroy();
    this.options.reportFailure();
  }

  private restorePosition(): void {
    const placement = this.snapshot?.preferences.placement ?? null;
    const display =
      screen.getAllDisplays().find((candidate) => candidate.id === placement?.displayId) ??
      screen.getPrimaryDisplay();
    const position = placePetOnDisplay(display, placement);
    this.window?.setPosition(position.x, position.y);
  }

  private startDrag(pointer: { x: number; y: number }, bounds: { x: number; y: number }): void {
    this.finishDrag(false);
    const offset = { x: pointer.x - bounds.x, y: pointer.y - bounds.y };
    this.dragTimer = setInterval(() => {
      const window = this.window;
      if (!window) {
        return;
      }
      const currentPointer = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(currentPointer);
      const desiredPosition = { x: currentPointer.x - offset.x, y: currentPointer.y - offset.y };
      const position = placePetOnDisplay(display, savePetPosition(display, desiredPosition));
      window.setPosition(position.x, position.y);
    }, 16);
    /* A lost pointer-up must never leave an overlay chasing the pointer. */
    this.dragTimeout = setTimeout(() => {
      this.finishDrag(true);
    }, 10_000);
  }

  private finishDrag(save: boolean): void {
    if (!this.dragTimer) {
      return;
    }
    clearInterval(this.dragTimer);
    if (this.dragTimeout) {
      clearTimeout(this.dragTimeout);
    }
    this.dragTimer = null;
    this.dragTimeout = null;
    if (this.window) {
      this.window.setIgnoreMouseEvents(true, { forward: true });
      if (save) {
        const bounds = this.window.getBounds();
        const display = screen.getDisplayMatching(bounds);
        this.options.savePlacement(savePetPosition(display, bounds));
      }
    }
  }
}

function hasSamePlacement(first: PetPlacement | null, second: PetPlacement | null): boolean {
  return (
    first?.displayId === second?.displayId &&
    first?.horizontalRatio === second?.horizontalRatio &&
    first?.verticalRatio === second?.verticalRatio
  );
}
