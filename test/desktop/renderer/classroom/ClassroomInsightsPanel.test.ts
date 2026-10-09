// @vitest-environment happy-dom
import { type ReactNode, createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useLocale } from '../../../../src/desktop/renderer/localization/UseLocale.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClassroomInsightReply } from '#contracts/ClassroomInsights.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { ClassroomInsightsPanel } from '../../../../src/desktop/renderer/classroom/ClassroomInsightsPanel.js';
import {
  createInsightAssessment,
  createStudentProgress,
  insightClassId,
} from '../../ClassroomInsightDesktopFixtures.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

function render(view: ReactNode): ReturnType<typeof renderView> {
  window.localStorage.setItem('tro.desktop.locale', 'en');
  return renderView(view, { wrapper: LocaleProvider });
}

function LocaleSwitch(): ReactElement {
  const { changeLocale } = useLocale();
  return createElement(
    'button',
    {
      onClick: () => {
        changeLocale('en');
      },
    },
    'English',
  );
}

it('uses Vietnamese for student insights and switches to English without reloading learning records', async () => {
  window.localStorage.setItem('tro.desktop.locale', 'vi');
  const assessment = createInsightAssessment();
  const progress = {
    ...createStudentProgress(),
    coverageReason: 'Historical assignment and support coverage is unknown.',
    assessments: [assessment],
  };
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroomInsights']>>()
    .mockImplementation((command) => {
      if (command.kind === 'status') {
        return Promise.resolve({
          kind: 'status',
          enabled: true,
          teacher: false,
          students: [{ id: 'minh', name: 'Minh' }],
          activities: [],
          plans: [],
          mappings: [],
        });
      }
      if (command.kind === 'read-student-progress') {
        return Promise.resolve({ kind: 'student-progress', progress });
      }
      return Promise.resolve({ kind: 'failed', code: 'forbidden' });
    });
  vi.stubGlobal('tro', { controlClassroomInsights: send });
  renderView(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: [
          createElement(LocaleSwitch, { key: 'locale' }),
          createElement(ClassroomInsightsPanel, {
            key: 'panel',
            userId: 'minh',
            classId: insightClassId,
            teacher: false,
          }),
        ],
      }),
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Hành trình học tập của Minh' })).toBeTruthy();
  });
  expect(screen.getByLabelText('Từ ngày').getAttribute('lang')).toBe('vi');
  expect(screen.getByText('Bài đã nộp')).toBeTruthy();
  expect(
    screen.getByText(
      'Lịch sử chưa đầy đủ: Chưa rõ mức độ đầy đủ của dữ liệu giao bài và hỗ trợ trước đây.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Kỹ năng thể hiện theo buổi học' })).toBeTruthy();
  expect(
    screen.getByRole('button', {
      name: new RegExp(
        new Date(progress.sessions[0]?.observedAt ?? '').toLocaleDateString('vi') + ': 2 đạt',
      ),
    }),
  ).toBeTruthy();
  expect(screen.getByText('Bài tập tiếp theo')).toBeTruthy();
  expect(screen.getByText('Countdown challenge')).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Bài làm gần đây' })).getAllByText(/: Đạt$/),
  ).toHaveLength(2);
  expect(screen.getByText(/Giáo viên xác nhận không có hỗ trợ/)).toBeTruthy();
  const requestCount = send.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Minh’s learning journey' })).toBeTruthy();
  });
  expect(screen.getByText('Tasks handed in')).toBeTruthy();
  expect(screen.getByLabelText('From').getAttribute('lang')).toBe('en');
  expect(send).toHaveBeenCalledTimes(requestCount);
});
