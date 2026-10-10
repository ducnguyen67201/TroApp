// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { GuidedLessonReadAction, type GuidedLessonReply } from '#contracts/GuidedLessons.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { useGuidedLessonBridge } from '../../../../src/desktop/renderer/guidedLessons/UseGuidedLessonBridge.js';

function createDeferredReply() {
  let resolveReply: (reply: GuidedLessonReply) => void = () => {};
  const promise = new Promise<GuidedLessonReply>((resolve) => {
    resolveReply = resolve;
  });
  return { promise, resolve: resolveReply };
}

function wrapLocale({ children }: { children: ReactNode }) {
  return createElement(LocaleProvider, { children });
}

function installBridge(readGuidedLessons: NonNullable<DesktopBridge['readGuidedLessons']>): void {
  const bridge = { readGuidedLessons } satisfies Pick<DesktopBridge, 'readGuidedLessons'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
}

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('discards a lesson reply that belongs to a previous account or class', async () => {
  const deferred = createDeferredReply();
  const read = vi
    .fn<NonNullable<DesktopBridge['readGuidedLessons']>>()
    .mockReturnValue(deferred.promise);
  installBridge(read);
  const { result, rerender } = renderHook(({ scope }) => useGuidedLessonBridge(scope), {
    initialProps: { scope: 'account-a:class-a' },
    wrapper: wrapLocale,
  });
  const pending = result.current.read({ action: GuidedLessonReadAction.LIST });
  rerender({ scope: 'account-b:class-a' });
  await act(async () => {
    deferred.resolve({ kind: 'list', classes: [], lessons: [] });
    expect(await pending).toBeNull();
  });
  expect(result.current.error).toBeNull();
});

it('accepts only the latest read in the same protected channel', async () => {
  const old = createDeferredReply();
  const latest = createDeferredReply();
  const read = vi
    .fn<NonNullable<DesktopBridge['readGuidedLessons']>>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise);
  installBridge(read);
  const { result } = renderHook(() => useGuidedLessonBridge('account-a:class-a'), {
    wrapper: wrapLocale,
  });
  const first = result.current.read({ action: GuidedLessonReadAction.LIST }, 'library');
  const second = result.current.read({ action: GuidedLessonReadAction.LIST }, 'library');
  await act(async () => {
    latest.resolve({ kind: 'list', classes: [], lessons: [] });
    expect(await second).toMatchObject({ kind: 'list' });
  });
  await act(async () => {
    old.resolve({ kind: 'list', classes: [], lessons: [] });
    expect(await first).toBeNull();
  });
});

it('keeps unavailable bridge methods visible as a recoverable error', async () => {
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: {} satisfies Pick<DesktopBridge, 'readGuidedLessons'>,
  });
  const { result } = renderHook(() => useGuidedLessonBridge('account-a:class-a'), {
    wrapper: wrapLocale,
  });
  await act(async () => {
    expect(await result.current.read({ action: GuidedLessonReadAction.LIST })).toBeNull();
  });
  expect(result.current.error).toBe('Guided lessons are unavailable in this app version.');
});
