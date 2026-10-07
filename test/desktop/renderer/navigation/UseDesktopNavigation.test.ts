// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ClassView } from '../../../../src/desktop/renderer/navigation/DesktopRoute.js';
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
