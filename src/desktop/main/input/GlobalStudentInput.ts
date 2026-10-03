import { StudentActivityKind, type StudentActivity } from '#contracts/StudentActivity.js';
import type { UiohookMouseEvent } from 'uiohook-napi';
import { acquirePhysicalInputHook } from './PhysicalInputHook.js';

export interface StudentInputPort {
  start(receive: (activity: StudentActivity) => void): Promise<void>;
  stop(): void;
}
interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Active lessons only. Normalize physical pointer locations against the primary
 * display; other displays produce unknown points, never misleading coordinates. */
export class GlobalStudentInput implements StudentInputPort {
  private cleanup: (() => void) | null = null;
  private generation = 0;
  constructor(private readonly readBounds: () => DisplayBounds) {}

  async start(receive: (activity: StudentActivity) => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const { uIOhook } = await import('uiohook-napi');
    const release = await acquirePhysicalInputHook();
    if (generation !== this.generation) {
      release();
      return;
    }
    let heldButton: number | null = null;
    let lastDragAt = 0;
    let pressedAt: { x: number; y: number } | null = null;
    const point = (event: { x: number; y: number }): StudentActivity['point'] => {
      const bounds = this.readBounds();
      const x = (event.x - bounds.x) / bounds.width;
      const y = (event.y - bounds.y) / bounds.height;
      return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1
        ? { x, y }
        : null;
    };
    const button = (event: UiohookMouseEvent): number | null =>
      typeof event.button === 'number' &&
      Number.isInteger(event.button) &&
      event.button >= 1 &&
      event.button <= 5
        ? event.button
        : null;
    const down = (event: UiohookMouseEvent): void => {
      heldButton = button(event);
      pressedAt = { x: event.x, y: event.y };
      receive({ kind: StudentActivityKind.PRESS, point: point(event), button: heldButton });
    };
    const up = (event: UiohookMouseEvent): void => {
      receive({ kind: StudentActivityKind.RELEASE, point: point(event), button: button(event) });
      heldButton = null;
      pressedAt = null;
    };
    const move = (event: UiohookMouseEvent): void => {
      if (
        heldButton !== null &&
        pressedAt !== null &&
        Math.hypot(event.x - pressedAt.x, event.y - pressedAt.y) >= 5 &&
        performance.now() - lastDragAt >= 50
      ) {
        lastDragAt = performance.now();
        receive({ kind: StudentActivityKind.DRAG, point: point(event), button: heldButton });
      }
    };
    const key = (): void => {
      receive({ kind: StudentActivityKind.KEY, point: null, button: null });
    };
    const scroll = (): void => {
      receive({ kind: StudentActivityKind.SCROLL, point: null, button: null });
    };
    uIOhook.on('mousedown', down);
    uIOhook.on('mouseup', up);
    uIOhook.on('mousemove', move);
    uIOhook.on('keydown', key);
    uIOhook.on('keyup', key);
    uIOhook.on('wheel', scroll);
    this.cleanup = () => {
      uIOhook.removeListener('mousedown', down);
      uIOhook.removeListener('mouseup', up);
      uIOhook.removeListener('mousemove', move);
      uIOhook.removeListener('keydown', key);
      uIOhook.removeListener('keyup', key);
      uIOhook.removeListener('wheel', scroll);
      release();
    };
  }

  stop(): void {
    this.generation += 1;
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.();
  }
}
