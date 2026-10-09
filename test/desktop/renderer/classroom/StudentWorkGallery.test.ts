// @vitest-environment happy-dom
import { type ReactNode, createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { StudentWorkGallery } from '../../../../src/desktop/renderer/classroom/StudentWorkGallery.js';
import {
  createInsightAssessment,
  createStudentProgress,
  insightClassId,
  insightSessionId,
} from '../../ClassroomInsightDesktopFixtures.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it('groups observations of one task and fetches actual saved evidence only on request', async () => {
  const assessment = createInsightAssessment();
  const progress = {
    ...createStudentProgress(),
    assessments: [
      assessment,
      {
        ...assessment,
        id: crypto.randomUUID(),
        method: 'model' as const,
        unaidedConfirmed: false,
        assistance: 'unknown' as const,
      },
    ],
  };
  const send = vi.fn<NonNullable<DesktopBridge['controlClassroomInsights']>>().mockResolvedValue({
    kind: 'evidence',
    evidence: [
      {
        kind: 'text',
        id: crypto.randomUUID(),
        name: 'Saved countdown',
        text: 'while count > 0:\n    count -= 1',
      },
    ],
  });
  vi.stubGlobal('tro', { controlClassroomInsights: send });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(StudentWorkGallery, {
        userId: 'teacher',
        progress,
        selectedSessionId: insightSessionId,
      }),
    }),
  );
  expect(screen.getAllByRole('heading', { name: 'Countdown challenge' })).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  const button = screen.getAllByRole('button', { name: 'View saved work' })[0];
  if (!button) {
    throw new Error('Missing saved work action');
  }
  fireEvent.click(button);
  await waitFor(() => {
    expect(screen.getByText(/while count > 0:/)).toBeTruthy();
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: 'read-evidence',
    classId: insightClassId,
    studentId: 'minh',
    assessmentId: assessment.id,
  });
});

function render(view: ReactNode): ReturnType<typeof renderView> {
  window.localStorage.setItem('tro.desktop.locale', 'en');
  return renderView(view, { wrapper: LocaleProvider });
}

it.each(['application/pdf', 'application/x.scratch.sb3'] as const)(
  'offers the original %s artifact without trying to render it as an image',
  async (mediaType) => {
    const progress = createStudentProgress();
    progress.assessments = [createInsightAssessment()];
    const name = mediaType === 'application/pdf' ? 'Work.pdf' : 'Work.sb3';
    const base64 = Buffer.from('original bytes').toString('base64');
    const send = vi.fn<NonNullable<DesktopBridge['controlClassroomInsights']>>().mockResolvedValue({
      kind: 'evidence',
      evidence: [{ id: crypto.randomUUID(), kind: 'document', name, mediaType, base64 }],
    });
    vi.stubGlobal('tro', { controlClassroomInsights: send });
    render(
      createElement(MantineProvider, {
        env: 'test',
        children: createElement(StudentWorkGallery, {
          userId: 'teacher',
          progress,
          selectedSessionId: null,
        }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View saved work' }));
    const download = await screen.findByRole('link', { name: 'Save original file' });
    expect(download.getAttribute('download')).toBe(name);
    expect(download.getAttribute('href')).toBe(`data:${mediaType};base64,${base64}`);
    expect(screen.queryByRole('img', { name })).toBeNull();
  },
);
