// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClassroomInsightReply } from '#contracts/ClassroomInsights.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { ClassroomInsightsPanel } from '../../../../src/desktop/renderer/classroom/ClassroomInsightsPanel.js';
import { createStudentProgress, insightClassId } from '../../ClassroomInsightDesktopFixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function panel(userId = 'teacher'): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(ClassroomInsightsPanel, {
      userId,
      classId: insightClassId,
      teacher: true,
    }),
  });
}

it('keeps policy-disabled insights unavailable and never loads learning records', async () => {
  const send = vi.fn<NonNullable<DesktopBridge['controlClassroomInsights']>>().mockResolvedValue({
    kind: 'status',
    enabled: false,
    teacher: true,
    students: [],
    activities: [],
    plans: [],
    mappings: [],
  });
  vi.stubGlobal('tro', { controlClassroomInsights: send });
  render(panel());
  await waitFor(() => {
    expect(screen.getByText(/Collection permissions must be in place/)).toBeTruthy();
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: 'status', classId: insightClassId });
  expect(screen.queryByRole('button', { name: /Create report/ })).toBeNull();
});

it('does not show an old child’s reply after selection or account changes', async () => {
  let finishMinh: (reply: ClassroomInsightReply) => void = () => {};
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroomInsights']>>()
    .mockImplementation((command) => {
      if (command.kind === 'status') {
        return Promise.resolve({
          kind: 'status',
          enabled: true,
          teacher: true,
          students: [
            { id: 'minh', name: 'Minh' },
            { id: 'an', name: 'An' },
          ],
          activities: [],
          plans: [],
          mappings: [],
        });
      }
      if (command.kind === 'read-student-progress') {
        return command.studentId === 'minh'
          ? new Promise((resolve) => {
              finishMinh = resolve;
            })
          : Promise.resolve({
              kind: 'student-progress',
              progress: createStudentProgress('an', 'An'),
            });
      }
      return Promise.resolve({ kind: 'failed', code: 'forbidden' });
    });
  vi.stubGlobal('tro', { controlClassroomInsights: send });
  const view = render(panel());
  await waitFor(() => {
    expect(
      send.mock.calls.some(
        ([command]) => command.kind === 'read-student-progress' && command.studentId === 'minh',
      ),
    ).toBe(true);
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Student' }));
  fireEvent.click(screen.getByRole('option', { name: 'An' }));
  await waitFor(() => {
    expect(screen.getByText('An’s learning journey')).toBeTruthy();
  });
  await act(async () => {
    finishMinh({ kind: 'student-progress', progress: createStudentProgress() });
    await Promise.resolve();
  });
  expect(screen.queryByText('Minh’s learning journey')).toBeNull();
  view.rerender(panel('other-teacher'));
  expect(screen.queryByText('An’s learning journey')).toBeNull();
});

it('preserves existing classroom rendering when the optional bridge is absent', () => {
  vi.stubGlobal('tro', {});
  render(panel());
  expect(screen.getByText('Learning insights are unavailable in this app version.')).toBeTruthy();
});

it('keeps the insight panel unavailable when no preload bridge is installed', () => {
  vi.stubGlobal('tro', undefined);
  render(panel());
  expect(screen.getByText('Learning insights are unavailable in this app version.')).toBeTruthy();
});
