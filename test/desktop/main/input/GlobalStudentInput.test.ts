import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { StudentActivity } from '#contracts/StudentActivity.js';
import { GlobalStudentInput } from '../../../../src/desktop/main/input/GlobalStudentInput.js';
import { acquirePhysicalInputHook } from '../../../../src/desktop/main/input/PhysicalInputHook.js';
const hook = vi.hoisted(() => ({ start: vi.fn<() => void>(), stop: vi.fn<() => void>() }));
const events = new EventEmitter();
vi.mock('uiohook-napi', () => ({
  uIOhook: {
    ...hook,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  },
}));
afterEach(() => {
  events.removeAllListeners();
  vi.clearAllMocks();
});
it('shares voice/input hook ownership and detaches lesson listeners without stopping voice', async () => {
  const voiceLease = await acquirePhysicalInputHook();
  const listener = new GlobalStudentInput(() => ({ x: 0, y: 0, width: 1000, height: 800 }));
  const received: StudentActivity[] = [];
  await listener.start((activity) => {
    received.push(activity);
  });
  expect(hook.start).toHaveBeenCalledTimes(1);
  events.emit('mousedown', { x: 100, y: 80, button: 1 });
  events.emit('mouseup', { x: 100, y: 80, button: 1 });
  events.emit('keydown', { keycode: 17 });
  expect(received).toEqual([
    { kind: 'press', point: { x: 0.1, y: 0.1 }, button: 1 },
    { kind: 'release', point: { x: 0.1, y: 0.1 }, button: 1 },
    { kind: 'key', point: null, button: null },
  ]);
  listener.stop();
  expect(hook.stop).not.toHaveBeenCalled();
  events.emit('mouseup', { x: 100, y: 80, button: 1 });
  expect(received).toHaveLength(3);
  voiceLease();
  expect(hook.stop).toHaveBeenCalledTimes(1);
});
it('reports other-display locations as unknown and cancels an asynchronous start', async () => {
  const listener = new GlobalStudentInput(() => ({ x: 0, y: 0, width: 1000, height: 800 }));
  const received: StudentActivity[] = [];
  const starting = listener.start((activity) => {
    received.push(activity);
  });
  listener.stop();
  await starting;
  events.emit('mousedown', { x: 1200, y: 80, button: 1 });
  expect(received).toEqual([]);
  await listener.start((activity) => {
    received.push(activity);
  });
  events.emit('mousedown', { x: 1200, y: 80, button: 1 });
  expect(received[0]?.point).toBeNull();
  listener.stop();
});
