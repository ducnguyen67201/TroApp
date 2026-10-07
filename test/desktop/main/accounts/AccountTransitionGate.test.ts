import { expect, it } from 'vitest';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';

it('blocks a switch during authenticated requests and blocks requests during a switch', async () => {
  const gate = new AccountTransitionGate(
    () => false,
    () => false,
  );
  let finish: (result: string) => void = () => {};
  const request = gate.runRequest(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    'blocked',
  );
  expect((await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  finish('complete');
  expect(await request).toBe('complete');
  let finishSwitch: () => void = () => {};
  const change = gate.changeAccount(async () => {
    await new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    return { kind: 'signed-out' };
  });
  expect(await gate.runRequest(() => Promise.resolve('unsafe'), 'blocked')).toBe('blocked');
  expect((await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  finishSwitch();
  expect(await change).toEqual({ kind: 'signed-out' });
  expect(gate.isChanging()).toBe(false);
});

it('blocks active work and pending OAuth while allowing OAuth cancellation', async () => {
  const busy = new AccountTransitionGate(
    () => false,
    () => true,
  );
  expect((await busy.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  const pending = new AccountTransitionGate(
    () => true,
    () => false,
  );
  expect(await pending.runRequest(() => Promise.resolve('unsafe'), 'blocked')).toBe('blocked');
  expect((await pending.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  expect(await pending.changeAccount(() => Promise.resolve({ kind: 'signed-out' }), true)).toEqual({
    kind: 'signed-out',
  });
});

it('releases the transition gate after a failed operation', async () => {
  const gate = new AccountTransitionGate(
    () => false,
    () => false,
  );
  await expect(
    gate.changeAccount(() => Promise.reject(new Error('storage failed'))),
  ).rejects.toThrow();
  expect(await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).toEqual({
    kind: 'signed-out',
  });
});
