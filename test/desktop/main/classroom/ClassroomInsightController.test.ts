import { expect, it, vi } from 'vitest';
import type { ClassroomInsightReply } from '#contracts/ClassroomInsights.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';
import { ClassroomInsightController } from '../../../../src/desktop/main/classroom/ClassroomInsightController.js';
import type { ClassroomInsightApiClient } from '../../../../src/desktop/main/classroom/ClassroomInsightApiClient.js';
import type { ClassroomSessionController } from '../../../../src/desktop/main/classroom/ClassroomSessionController.js';
import { insightClassId, createParentReport } from '../../ClassroomInsightDesktopFixtures.js';

function fixture() {
  const execute = vi
    .fn<ClassroomInsightApiClient['execute']>()
    .mockResolvedValue({ kind: 'failed', code: 'forbidden' });
  const executeInsights = vi
    .fn<ClassroomSessionController['executeInsights']>()
    .mockImplementation((command, send) => send(command));
  const accounts = new AccountTransitionGate(
    () => false,
    () => false,
  );
  return {
    execute,
    executeInsights,
    accounts,
    controller: new ClassroomInsightController({ execute }, accounts, { executeInsights }),
  };
}

it('rejects untrusted, malformed and generic export commands before any network request', async () => {
  const { controller, execute } = fixture();
  expect(
    await controller.execute({ kind: 'status', classId: insightClassId }, () => false),
  ).toEqual({ kind: 'failed', code: 'forbidden' });
  expect(
    await controller.execute(
      { kind: 'status', classId: insightClassId, filePath: '/private' },
      () => true,
    ),
  ).toEqual({ kind: 'failed', code: 'invalid' });
  const report = createParentReport();
  expect(
    await controller.execute(
      {
        kind: 'export-parent-report',
        classId: insightClassId,
        requestId: report.id,
        id: report.id,
        expectedVersion: 2,
      },
      () => true,
    ),
  ).toEqual({ kind: 'failed', code: 'invalid' });
  expect(execute).not.toHaveBeenCalled();
});

it('fences replies on disposal and blocks voluntary account switches while requests are pending', async () => {
  const { controller, execute, accounts } = fixture();
  let finish: (reply: ClassroomInsightReply) => void = () => {};
  execute.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = controller.execute({ kind: 'status', classId: insightClassId }, () => true);
  expect((await accounts.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  controller.dispose();
  finish({
    kind: 'status',
    enabled: false,
    teacher: true,
    students: [],
    activities: [],
    plans: [],
    mappings: [],
  });
  expect(await result).toEqual({ kind: 'failed', code: 'stale' });
  expect(await accounts.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).toEqual({
    kind: 'signed-out',
  });
});
