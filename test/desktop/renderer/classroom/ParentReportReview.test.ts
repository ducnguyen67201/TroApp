// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReportStatus } from '#contracts/ClassroomInsights.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { ParentReportReview } from '../../../../src/desktop/renderer/classroom/ParentReportReview.js';
import {
  createParentReport,
  insightClassId,
  insightWindow,
} from '../../ClassroomInsightDesktopFixtures.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});

function panel(studentId = 'minh', studentName = 'Minh'): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(ParentReportReview, {
      userId: 'teacher',
      classId: insightClassId,
      studentId,
      studentName,
      window: insightWindow,
    }),
  });
}

it('keeps facts fixed, saves commentary into a new revision, and approves and exports that exact child', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  const report = {
    ...createParentReport(),
    status: ReportStatus.DRAFT,
    approvedBy: null,
    approvedAt: null,
  };
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroomInsights']>>()
    .mockImplementation((command) => {
      if (command.kind === 'edit-parent-report') {
        return Promise.resolve({
          kind: 'parent-report',
          report: { ...report, version: 3, commentary: command.commentary },
        });
      }
      if (command.kind === 'approve-parent-report') {
        return Promise.resolve({
          kind: 'parent-report',
          report: {
            ...report,
            version: 4,
            commentary: 'Encourage tracing a new loop.',
            status: ReportStatus.APPROVED,
            approvedBy: 'teacher',
            approvedAt: '2026-10-08T17:00:00.000Z',
          },
        });
      }
      return Promise.resolve({ kind: 'parent-report', report });
    });
  const exportReport = vi
    .fn<NonNullable<DesktopBridge['exportParentReport']>>()
    .mockResolvedValue({ saved: true, code: null });
  vi.stubGlobal('tro', { controlClassroomInsights: send, exportParentReport: exportReport });
  const view = render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Create report for Minh' }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Approve revision 2' })).toBeTruthy();
  });
  expect(screen.getByText(report.facts[0]?.text ?? '')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Teacher’s note to parent' }), {
    target: { value: 'Encourage tracing a new loop.' },
  });
  expect(screen.getByRole('button', { name: 'Approve revision 2' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(
    screen.getByRole('button', { name: 'Save approved report' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Approve revision 3' })).toBeTruthy();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve revision 3' }));
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Save approved report' }).hasAttribute('disabled'),
    ).toBe(false);
  });
  expect(
    send.mock.calls.some(
      ([command]) =>
        command.kind === 'approve-parent-report' &&
        command.expectedVersion === 3 &&
        command.id === report.id,
    ),
  ).toBe(true);
  view.rerender(panel('an', 'An'));
  expect(screen.getByText(/^Minh ·/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save approved report' }));
  await waitFor(() => {
    expect(exportReport).toHaveBeenCalledExactlyOnceWith({
      classId: insightClassId,
      reportId: report.id,
      expectedVersion: 4,
    });
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Teacher’s note to parent' }), {
    target: { value: 'Another note' },
  });
  expect(
    screen.getByRole('button', { name: 'Save approved report' }).hasAttribute('disabled'),
  ).toBe(true);
});
