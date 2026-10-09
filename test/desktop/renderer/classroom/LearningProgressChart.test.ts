// @vitest-environment happy-dom
import { type ReactNode, createElement } from 'react';
import { cleanup, fireEvent, render as renderView, screen } from '@testing-library/react';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { afterEach, expect, it, vi } from 'vitest';
import { LearningProgressChart } from '../../../../src/desktop/renderer/classroom/LearningProgressChart.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('shows criterion counts and accessible lesson selection without inventing an ability score', () => {
  const select = vi.fn<(sessionId: string) => void>();
  render(
    createElement(LearningProgressChart, {
      lessons: [
        {
          sessionId: 'lesson-2',
          title: 'Lesson 2',
          met: 1,
          needsPractice: 1,
          unknown: 1,
          conflicting: 0,
          denominator: 3,
          comparable: false,
        },
        {
          sessionId: 'lesson-3',
          title: 'Lesson 3',
          met: 2,
          needsPractice: 1,
          unknown: 0,
          conflicting: 0,
          denominator: 3,
          comparable: false,
        },
      ],
      selectedSessionId: 'lesson-2',
      onSelect: select,
    }),
  );
  const lesson = screen.getByRole('button', { name: /Lesson 3: 2 met, 1 need practice/ });
  fireEvent.click(lesson);
  expect(select).toHaveBeenCalledExactlyOnceWith('lesson-3');
  expect(screen.getByText('Criteria · 0–3')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Lesson 2: 1 met/ }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByText(/mastery|100%/i)).toBeNull();
});

function render(view: ReactNode): ReturnType<typeof renderView> {
  window.localStorage.setItem('tro.desktop.locale', 'en');
  return renderView(view, { wrapper: LocaleProvider });
}
