import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import {
  createPetPreferences,
  PetOverlayAction,
  PetReaction,
  type PetPlacement,
  type PetSnapshot,
} from '#contracts/Pet.js';
import { PetWindow } from '../../../../src/desktop/main/pets/PetWindow.js';

const doubles = vi.hoisted(() => {
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } };
  const contentsListeners = new Map<string, () => void>();
  const screenListeners = new Map<string, () => void>();
  const mainFrame = { url: 'file:///app/Pet.html' };
  const contents = {
    mainFrame,
    send: vi.fn<(channel: string, snapshot: PetSnapshot) => void>(),
    setWindowOpenHandler: vi.fn(),
    on: (name: string, callback: () => void) => {
      contentsListeners.set(name, callback);
    },
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  };
  return {
    display,
    contents,
    contentsListeners,
    screenListeners,
    options: { value: null as BrowserWindowConstructorOptions | null },
    pointer: { x: 0, y: 0 },
    bounds: { x: 0, y: 0, width: 144, height: 160 },
    visible: false,
    destroyed: false,
    loadFile: vi.fn<(file: string) => Promise<void>>().mockResolvedValue(),
    showInactive: vi.fn(),
    ignore: vi.fn<(ignore: boolean, options: { forward: boolean }) => void>(),
    save: vi.fn<(placement: PetPlacement) => void>(),
    failure: vi.fn<() => void>(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = doubles.contents;
    constructor(options: BrowserWindowConstructorOptions) {
      doubles.options.value = options;
    }
    on() {}
    loadFile = doubles.loadFile;
    loadURL = doubles.loadFile;
    setIgnoreMouseEvents = doubles.ignore;
    showInactive() {
      doubles.visible = true;
      doubles.showInactive();
    }
    hide() {
      doubles.visible = false;
    }
    destroy() {
      doubles.destroyed = true;
    }
    isDestroyed() {
      return doubles.destroyed;
    }
    isVisible() {
      return doubles.visible;
    }
    getBounds() {
      return doubles.bounds;
    }
    setPosition(x: number, y: number) {
      doubles.bounds = { ...doubles.bounds, x, y };
    }
  },
  screen: {
    on: (name: string, callback: () => void) => {
      doubles.screenListeners.set(name, callback);
    },
    removeListener: (name: string) => {
      doubles.screenListeners.delete(name);
    },
    getAllDisplays: () => [doubles.display],
    getPrimaryDisplay: () => doubles.display,
    getCursorScreenPoint: () => doubles.pointer,
    getDisplayNearestPoint: () => doubles.display,
    getDisplayMatching: () => doubles.display,
  },
}));

const snapshot: PetSnapshot = {
  revision: 1,
  preferences: { ...createPetPreferences(), enabled: true },
  reaction: PetReaction.IDLE,
  isVisible: true,
  hasPresentationError: false,
  encouragement: false,
};

function createWindow() {
  return new PetWindow({
    preloadFile: '/app/Preload.cjs',
    rendererFile: '/app/Pet.html',
    documentUrl: 'file:///app/Pet.html',
    developmentUrl: undefined,
    savePlacement: doubles.save,
    reportFailure: doubles.failure,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  doubles.contentsListeners.clear();
  doubles.screenListeners.clear();
  doubles.visible = false;
  doubles.destroyed = false;
  doubles.loadFile.mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pet desktop adapter', () => {
  it('keeps the window unfocusable and trusts only its exact main frame', async () => {
    const window = createWindow();
    window.showPet(snapshot);
    await Promise.resolve();
    expect(doubles.options.value).toMatchObject({
      focusable: false,
      transparent: true,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--tro-pet-overlay'],
      },
    });
    expect(doubles.showInactive).toHaveBeenCalledOnce();
    expect(
      window.isTrustedSender({ sender: doubles.contents, senderFrame: doubles.contents.mainFrame }),
    ).toBe(true);
    expect(window.isTrustedSender({ sender: {}, senderFrame: doubles.contents.mainFrame })).toBe(
      false,
    );
    expect(
      window.isTrustedSender({
        sender: doubles.contents,
        senderFrame: { url: 'file:///app/Pet.html' },
      }),
    ).toBe(false);
    window.dispose();
    expect(doubles.screenListeners.size).toBe(0);
  });

  it('does not resurrect an overlay hidden during a pending load', async () => {
    let completeLoad: (() => void) | undefined;
    doubles.loadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeLoad = resolve;
        }),
    );
    const window = createWindow();
    window.showPet(snapshot);
    window.hidePet();
    completeLoad?.();
    await Promise.resolve();
    expect(doubles.showInactive).not.toHaveBeenCalled();
    window.dispose();
  });

  it('enables interaction only over the bounded hit area and fences drag timers on hide', async () => {
    const window = createWindow();
    window.showPet(snapshot);
    await Promise.resolve();
    doubles.pointer = { x: doubles.bounds.x + 72, y: doubles.bounds.y + 100 };
    window.receiveInteraction({ kind: PetOverlayAction.HOVER });
    expect(doubles.ignore).toHaveBeenLastCalledWith(false, { forward: true });
    window.receiveInteraction({ kind: PetOverlayAction.START_DRAG });
    doubles.pointer = { x: -100, y: -100 };
    vi.advanceTimersByTime(16);
    expect(doubles.bounds).toMatchObject({ x: 0, y: 0 });
    window.hidePet();
    expect(vi.getTimerCount()).toBe(0);
    expect(doubles.save).not.toHaveBeenCalled();
    window.dispose();
  });

  it('reports a failed load once and destroys the unusable window', async () => {
    doubles.loadFile.mockRejectedValueOnce(new Error('missing packaged asset'));
    const window = createWindow();
    window.showPet(snapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(doubles.failure).toHaveBeenCalledOnce();
    expect(doubles.destroyed).toBe(true);
    window.dispose();
  });
});
