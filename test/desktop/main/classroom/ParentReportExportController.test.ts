import { expect, it, vi } from 'vitest';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';
import { ParentReportExportController } from '../../../../src/desktop/main/classroom/ParentReportExportController.js';
import type { ClassroomInsightApiClient } from '../../../../src/desktop/main/classroom/ClassroomInsightApiClient.js';
import type { ReportFileWriter } from '../../../../src/desktop/main/classroom/AtomicReportFile.js';
import { createParentReport, insightClassId } from '../../ClassroomInsightDesktopFixtures.js';

function fixture() {
  const report = createParentReport();
  const execute = vi
    .fn<ClassroomInsightApiClient['execute']>()
    .mockResolvedValue({ kind: 'export', report, acceptedAt: '2026-10-08T17:00:00.000Z' });
  const save = vi.fn<ReportFileWriter['save']>().mockResolvedValue(true);
  const choose = vi.fn<() => Promise<string | null>>().mockResolvedValue('/native/Report.html');
  const accounts = new AccountTransitionGate(
    () => false,
    () => false,
  );
  const controller = new ParentReportExportController(
    { execute },
    accounts,
    { choose },
    { save },
    () => 'cookie',
  );
  const command = { classId: insightClassId, reportId: report.id, expectedVersion: report.version };
  return { report, execute, save, choose, accounts, controller, command };
}

it('opens the native dialog before exact-revision acceptance and writes escaped approved content', async () => {
  const { report, execute, save, choose, controller, command } = fixture();
  report.studentName = '<script>child</script>';
  report.commentary = '<img src=x onerror=alert(1)> & “Keep trying”';
  const order: string[] = [];
  choose.mockImplementation(() => {
    order.push('dialog');
    return Promise.resolve('/native/Report.html');
  });
  execute.mockImplementation(() => {
    order.push('accept');
    return Promise.resolve({ kind: 'export', report, acceptedAt: '2026-10-08T17:00:00.000Z' });
  });
  expect(await controller.export(command, () => true)).toEqual({ saved: true, code: null });
  expect(order).toEqual(['dialog', 'accept']);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    kind: 'export-parent-report',
    id: report.id,
    expectedVersion: 2,
  });
  const content = save.mock.calls[0]?.[1] ?? '';
  expect(content).toContain('&lt;script&gt;child&lt;/script&gt;');
  expect(content).toContain('&lt;img src=x onerror=alert(1)&gt; &amp;');
  expect(content).not.toContain('<script>');
  expect(content).not.toContain('<img');
  expect(content).toContain('Approved revision 2');
  expect(content).not.toContain('https://');
});

it('cancels without accepting or writing, and rejects arbitrary renderer paths', async () => {
  const { choose, execute, save, controller, command } = fixture();
  choose.mockResolvedValue(null);
  expect(await controller.export(command, () => true)).toEqual({ saved: false, code: null });
  expect(execute).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(await controller.export({ ...command, destination: '/private/file' }, () => true)).toEqual(
    { saved: false, code: 'invalid' },
  );
  expect(choose).toHaveBeenCalledOnce();
});

it('blocks voluntary account switches and forced disposal while a dialog is open', async () => {
  const { choose, execute, save, controller, command, accounts } = fixture();
  let finish: (path: string | null) => void = () => {};
  choose.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const exporting = controller.export(command, () => true);
  expect((await accounts.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  controller.dispose();
  finish('/native/Report.html');
  expect(await exporting).toEqual({ saved: false, code: 'stale' });
  expect(execute).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it('rejects source revocation, foreign snapshots and changed credentials before writing', async () => {
  const { execute, save, controller, command, report } = fixture();
  execute.mockResolvedValueOnce({ kind: 'failed', code: 'stale' });
  expect(await controller.export(command, () => true)).toEqual({ saved: false, code: 'stale' });
  execute.mockResolvedValueOnce({
    kind: 'export',
    report: { ...report, version: 3 },
    acceptedAt: '2026-10-08T17:00:00.000Z',
  });
  expect(await controller.export(command, () => true)).toEqual({ saved: false, code: 'invalid' });
  expect(save).not.toHaveBeenCalled();
  let cookie: string | null = 'first';
  const expired = new ParentReportExportController(
    { execute },
    new AccountTransitionGate(
      () => false,
      () => false,
    ),
    {
      choose: () => {
        cookie = null;
        return Promise.resolve('/native/Report.html');
      },
    },
    { save },
    () => cookie,
  );
  expect(await expired.export(command, () => true)).toEqual({ saved: false, code: 'stale' });
  expect(save).not.toHaveBeenCalled();
});

it('reports failed atomic writes without claiming the report was saved', async () => {
  const { controller, save, command } = fixture();
  save.mockResolvedValue(false);
  expect(await controller.export(command, () => true)).toEqual({
    saved: false,
    code: 'unavailable',
  });
});
