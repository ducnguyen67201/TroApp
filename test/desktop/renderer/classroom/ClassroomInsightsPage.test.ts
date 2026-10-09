// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { ClassroomHome } from '#contracts/Classroom.js';
import { ClassroomInsightsPage } from '../../../../src/desktop/renderer/classroom/ClassroomInsightsPage.js';
import type { ClassroomInsightsPanel } from '../../../../src/desktop/renderer/classroom/ClassroomInsightsPanel.js';

vi.mock('../../../../src/desktop/renderer/classroom/ClassroomInsightsPanel.js', () => ({
  ClassroomInsightsPanel: (props: ComponentProps<typeof ClassroomInsightsPanel>) =>
    createElement(
      'div',
      { 'data-testid': 'insights', 'data-teacher': props.teacher },
      props.classId,
    ),
}));

afterEach(cleanup);

const firstClassId = '11111111-1111-4111-8111-111111111111';
const secondClassId = '22222222-2222-4222-8222-222222222222';
const home: ClassroomHome = {
  role: AccountRole.TEACHER,
  courses: [],
  classes: [
    {
      schoolClass: {
        id: firstClassId,
        teacherId: 'teacher',
        name: 'Class A',
        courseRevisionId: firstClassId,
      },
      meetings: [],
    },
    {
      schoolClass: {
        id: secondClassId,
        teacherId: 'other',
        name: 'Class B',
        courseRevisionId: secondClassId,
      },
      meetings: [],
    },
  ],
};

function showPage(classId: string | null, classes = home.classes): void {
  render(
    createElement(
      MantineProvider,
      {},
      createElement(ClassroomInsightsPage, {
        home: { ...home, classes },
        userId: 'teacher',
        classId,
        context: null,
        t: (english: string) => english,
      }),
    ),
  );
}

it('opens the first class without a live session and permits a navbar class selection', () => {
  showPage(null);
  expect(screen.getByTestId('insights').textContent).toBe(firstClassId);
  expect(screen.getByTestId('insights').getAttribute('data-teacher')).toBe('true');
  fireEvent.click(screen.getByRole('combobox', { name: 'Class' }));
  fireEvent.click(screen.getByRole('option', { name: 'Class B' }));
  expect(window.location.hash).toBe(`#/insights/${secondClassId}`);
});

it('uses student presentation for an enrolled class owned by another teacher', () => {
  showPage(secondClassId);
  expect(screen.getByTestId('insights').getAttribute('data-teacher')).toBe('false');
});

it('shows how to get started when the account has no classes', () => {
  showPage(null, []);
  expect(screen.getByText('Create or join a class to view learning insights.')).toBeTruthy();
  expect(screen.queryByTestId('insights')).toBeNull();
});
