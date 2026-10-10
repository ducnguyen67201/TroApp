// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  ClassView,
  DesktopPage,
} from '../../../../src/desktop/renderer/navigation/DesktopRoute.js';
import { useDesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';

afterEach(cleanup);

it('restores a deep class page and follows history hash changes without losing the selected view', async () => {
  const classId = '11111111-1111-4111-8111-111111111111';
  window.location.hash = `#/classroom/${classId}/settings`;
  const { result } = renderHook(useDesktopNavigation);
  expect(result.current.route).toMatchObject({ classId, classView: ClassView.SETTINGS });
  act(() => {
    result.current.openClass(classId, ClassView.MATERIALS);
  });
  expect(window.location.hash).toBe(`#/classroom/${classId}/materials`);
  act(() => {
    window.location.hash = `#/classroom/${classId}/settings`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await waitFor(() => {
    expect(result.current.route.classView).toBe(ClassView.SETTINGS);
  });
  act(() => {
    result.current.openClassroom();
  });
  expect(result.current.route.classId).toBeNull();
});

it('opens insights directly from navigation and returns to classes', () => {
  const { result } = renderHook(useDesktopNavigation);
  act(() => {
    result.current.openClassroom(true);
  });
  expect(result.current.route.page).toBe(DesktopPage.INSIGHTS);
  expect(window.location.hash).toBe('#/insights');
  act(() => {
    result.current.openClassroom();
  });
  expect(result.current.route.page).toBe(DesktopPage.CLASSROOM);
});

it('navigates to guided lessons without replacing classroom history', () => {
  const classId = '11111111-1111-4111-8111-111111111111';
  const { result } = renderHook(useDesktopNavigation);
  act(() => {
    result.current.openGuidedLessons(classId);
  });
  expect(result.current.route).toMatchObject({
    page: DesktopPage.GUIDED_LESSONS,
    classId,
  });
  act(() => {
    result.current.openClassroom();
  });
  expect(result.current.route.page).toBe(DesktopPage.CLASSROOM);
});
