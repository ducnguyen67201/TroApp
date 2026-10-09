import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  PracticeCaptureController,
  type PracticeWindowCapturePort,
} from '../../../../src/desktop/main/classroom/PracticeCaptureController.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';

function fixture() {
  const context = createTeachingContext();
  let now = Date.now();
  const base64 = Buffer.from([255, 216, 255, 1]).toString('base64');
  const captureWindow = vi
    .fn<PracticeWindowCapturePort['captureWindow']>()
    .mockResolvedValue({ base64, width: 800, height: 600 });
  const controller = new PracticeCaptureController(
    {
      listWindows: () => Promise.resolve([{ id: 'native:secret', name: 'Scratch' }]),
      captureWindow,
    },
    () => context,
    () => now,
  );
  return {
    controller,
    context,
    captureWindow,
    base64,
    expire: () => {
      now += 120001;
    },
  };
}

it('uses opaque window tokens and returns immutable, expiring drafts bound to lesson progress', async () => {
  const f = fixture();
  expect(await f.controller.execute({ kind: 'capture' })).toEqual({
    kind: 'failed',
    code: 'invalid',
  });
  const windows = await f.controller.execute({ kind: 'list' });
  if (windows.kind !== 'windows') {
    throw new Error('Missing windows');
  }
  const id = windows.windows[0]?.id;
  expect(id).not.toBe('native:secret');
  const result = await f.controller.execute({ kind: 'capture', windowId: id });
  if (result.kind !== 'captured' || result.evidence.kind !== 'image' || !result.evidence.capture) {
    throw new Error('Missing image');
  }
  expect(f.captureWindow).toHaveBeenCalledWith('native:secret');
  expect(result.evidence.capture.digest).toBe(
    createHash('sha256').update(Buffer.from(f.base64, 'base64')).digest('hex'),
  );
  expect(f.controller.validatesEvidence([result.evidence])).toBe(true);
  const captureId = result.evidence.capture.id;
  result.evidence.base64 = 'changed';
  expect(f.controller.validatesEvidence([result.evidence])).toBe(false);
  const read = await f.controller.execute({ kind: 'read', captureId });
  expect(read).toMatchObject({ kind: 'captured', evidence: { base64: f.base64 } });
  f.expire();
  expect(await f.controller.execute({ kind: 'read', captureId })).toEqual({
    kind: 'failed',
    code: 'stale',
  });
});

it('rejects native IDs, forged digests, and drafts from a previous activity version', async () => {
  const f = fixture();
  expect(await f.controller.execute({ kind: 'capture', windowId: 'native:secret' })).toEqual({
    kind: 'failed',
    code: 'invalid',
  });
  const windows = await f.controller.execute({ kind: 'list' });
  if (windows.kind !== 'windows') {
    throw new Error('Missing windows');
  }
  const result = await f.controller.execute({ kind: 'capture', windowId: windows.windows[0]?.id });
  if (result.kind !== 'captured' || result.evidence.kind !== 'image' || !result.evidence.capture) {
    throw new Error('Missing image');
  }
  const forged = structuredClone(result.evidence);
  forged.capture = { ...result.evidence.capture, digest: '0'.repeat(64) };
  expect(f.controller.validatesEvidence([forged])).toBe(false);
  f.context.attempt.progressVersion += 1;
  expect(f.controller.validatesEvidence([result.evidence])).toBe(false);
});

it('discards in-flight captures after cancellation or context changes', async () => {
  const f = fixture();
  const windows = await f.controller.execute({ kind: 'list' });
  if (windows.kind !== 'windows') {
    throw new Error('Missing windows');
  }
  let resolve: (
    value: Awaited<ReturnType<PracticeWindowCapturePort['captureWindow']>>,
  ) => void = () => {};
  f.captureWindow.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.controller.execute({ kind: 'capture', windowId: windows.windows[0]?.id });
  expect(await f.controller.execute({ kind: 'capture' })).toEqual({
    kind: 'failed',
    code: 'unavailable',
  });
  await f.controller.execute({ kind: 'discard' });
  resolve({ base64: f.base64, width: 800, height: 600 });
  expect(await pending).toEqual({ kind: 'failed', code: 'stale' });
});
