import { expect, it, vi } from 'vitest';
import { MaterialPreviewController } from '../../../../src/desktop/main/classroom/MaterialPreviewController.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';
import type { MaterialApiClient } from '../../../../src/desktop/main/classroom/MaterialApiClient.js';

const command = {
  kind: 'download' as const,
  classId: '11111111-1111-4111-8111-111111111111',
  materialId: '22222222-2222-4222-8222-222222222222',
};

function fixture() {
  const execute = vi.fn<MaterialApiClient['execute']>().mockResolvedValue({
    kind: 'download',
    name: 'Lesson.pdf',
    data: 'cGRm',
  });
  const accounts = new AccountTransitionGate(
    () => false,
    () => false,
  );
  return { execute, accounts, controller: new MaterialPreviewController({ execute }, accounts) };
}

it('rejects untrusted senders, arbitrary paths and mutations before reading an original', async () => {
  const { execute, controller } = fixture();
  expect(await controller.readOriginal(command, () => false)).toEqual({
    kind: 'failed',
    code: 'forbidden',
  });
  expect(
    await controller.readOriginal({ ...command, materialId: '/private/file.pdf' }, () => true),
  ).toEqual({ kind: 'failed', code: 'invalid' });
  expect(
    await controller.readOriginal({ kind: 'read', classId: command.classId }, () => true),
  ).toEqual({ kind: 'failed', code: 'invalid' });
  expect(execute).not.toHaveBeenCalled();
});

it('uses the backend download authorization and propagates denied student access', async () => {
  const { execute, controller } = fixture();
  expect(await controller.readOriginal(command, () => true)).toEqual({
    kind: 'download',
    name: 'Lesson.pdf',
    data: 'cGRm',
  });
  expect(execute).toHaveBeenCalledExactlyOnceWith(command);
  execute.mockResolvedValueOnce({ kind: 'failed', code: 'forbidden' });
  expect(await controller.readOriginal(command, () => true)).toEqual({
    kind: 'failed',
    code: 'forbidden',
  });
});

it('blocks account switches during a preview fetch and drops data if the frame navigates', async () => {
  const { execute, accounts, controller } = fixture();
  let finish: (value: Awaited<ReturnType<MaterialApiClient['execute']>>) => void = () => {};
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let trusted = true;
  const preview = controller.readOriginal(command, () => trusted);
  expect((await accounts.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  trusted = false;
  finish({ kind: 'download', name: 'Lesson.pdf', data: 'cGRm' });
  expect(await preview).toEqual({ kind: 'failed', code: 'unavailable' });
  expect(await accounts.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).toEqual({
    kind: 'signed-out',
  });
});
