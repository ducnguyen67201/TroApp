// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOnboardingPosition } from '../../../../src/desktop/renderer/onboarding/UseOnboardingPosition.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('measures the visible modal content rather than its zero-height wrapper and keeps it inside the minimum viewport', () => {
  vi.stubGlobal('innerWidth', 680);
  vi.stubGlobal('innerHeight', 520);
  const anchor = document.createElement('button');
  Object.defineProperty(anchor, 'scrollIntoView', {
    value: vi.fn<HTMLElement['scrollIntoView']>(),
  });
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 116, 76, 66));
  const root = document.createElement('div');
  const content = document.createElement('div');
  content.setAttribute('data-modal-content', 'true');
  Object.defineProperty(root, 'offsetHeight', { value: 0 });
  Object.defineProperty(content, 'offsetHeight', { configurable: true, value: 488 });
  root.append(content);
  const { result } = renderHook(() => useOnboardingPosition(anchor, root));
  expect(result.current).toMatchObject({ left: 104, top: 16, width: 438 });
  Object.defineProperty(content, 'offsetHeight', { value: 300 });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current?.top).toBe(108);
});
