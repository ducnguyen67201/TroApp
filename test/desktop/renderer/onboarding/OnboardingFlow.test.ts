// @vitest-environment happy-dom
import { createElement, createRef } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { OnboardingAction, OnboardingStatus, OnboardingStep } from '#contracts/OnboardingValues.js';
import { createOnboardingProgress } from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';
import type { ResolvedOnboardingContent } from '../../../../src/desktop/onboarding/domain/OnboardingContent.js';
import type { readOnboardingContent } from '../../../../src/desktop/renderer/onboarding/OnboardingContent.js';
import {
  OnboardingFlow,
  type OnboardingAnchors,
} from '../../../../src/desktop/renderer/onboarding/OnboardingFlow.js';
import type { OnboardingView } from '../../../../src/desktop/renderer/onboarding/UseOnboarding.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { localeStorageKey } from '../../../../src/desktop/renderer/localization/Locale.js';

const doubles = vi.hoisted(() => ({ readContent: vi.fn<typeof readOnboardingContent>() }));
vi.mock('../../../../src/desktop/renderer/onboarding/OnboardingContent.js', () => ({
  readOnboardingContent: doubles.readContent,
}));

const anchors: OnboardingAnchors = {
  [OnboardingStep.WORKSPACE]: createRef<HTMLButtonElement>(),
  [OnboardingStep.CLASSES]: createRef<HTMLButtonElement>(),
  [OnboardingStep.INSIGHTS]: createRef<HTMLButtonElement>(),
  [OnboardingStep.GUIDED_LESSONS]: createRef<HTMLButtonElement>(),
  [OnboardingStep.MICROPHONE]: createRef<HTMLButtonElement>(),
  [OnboardingStep.PETS]: createRef<HTMLButtonElement>(),
};

function createView(): OnboardingView {
  return {
    progress: { ...createOnboardingProgress(), status: OnboardingStatus.IN_PROGRESS },
    isAvailable: true,
    isLoading: false,
    isSaving: false,
    hasError: false,
    showCompletion: false,
    refresh: vi.fn<OnboardingView['refresh']>().mockResolvedValue(),
    sendAction: vi.fn<OnboardingView['sendAction']>().mockResolvedValue(true),
    restart: vi.fn<OnboardingView['restart']>().mockResolvedValue(true),
    closeCompletion: vi.fn<OnboardingView['closeCompletion']>(),
  };
}

function renderFlow(view = createView(), canPresent = true) {
  return render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(OnboardingFlow, {
          view,
          anchors,
          role: AccountRole.STUDENT,
          canPresent,
        }),
      }),
    }),
  );
}

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  doubles.readContent.mockReturnValue({
    copy: { title: 'Your workspace', description: 'Ask a question.', takeaway: 'Try Show me.' },
    video: null,
    videoLocale: null,
    transcript: null,
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('hides the transcript control when absent and keeps text and navigation usable without media', async () => {
  const view = createView();
  renderFlow(view);
  await screen.findByRole('dialog', { name: 'Get to know Tro' });
  expect(screen.queryByText('Read transcript')).toBeNull();
  expect(screen.getByText('Ask a question.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(view.sendAction).toHaveBeenCalledWith(OnboardingAction.NEXT);
  expect(doubles.readContent).toHaveBeenCalledWith(
    OnboardingStep.WORKSPACE,
    DesktopLocale.ENGLISH,
    AccountRole.STUDENT,
  );
});

it('renders only an available transcript and supports explicit playback with labelled fallback', async () => {
  const selected: ResolvedOnboardingContent = {
    copy: { title: 'Your workspace', description: 'Ask a question.', takeaway: 'Try Show me.' },
    video: { source: '/vi/Workspace.mp4', captions: '/vi/Workspace.vtt' },
    videoLocale: DesktopLocale.VIETNAMESE,
    transcript: 'Optional English transcript.',
  };
  doubles.readContent.mockReturnValue(selected);
  renderFlow();
  await screen.findByText('Read transcript');
  expect(screen.getByText('This recording is in Tiếng Việt.')).toBeTruthy();
  const video = screen.getByLabelText('Video introduction');
  expect(video.getAttribute('autoplay')).toBeNull();
  expect(video.querySelector('track')?.getAttribute('src')).toBe('/vi/Workspace.vtt');
  fireEvent.error(video);
  await screen.findByRole('alert');
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('onboarding.video.failed', {
    stage: 'playback',
    stepId: OnboardingStep.WORKSPACE,
    locale: DesktopLocale.VIETNAMESE,
  });
  expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
  expect(screen.getByText('Optional English transcript.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry video' }));
  expect(screen.getByLabelText('Video introduction')).toBeTruthy();
});

it('defers presentation during busy work and another dialog, then resumes the same guide', async () => {
  const busy = renderFlow(createView(), false);
  expect(screen.queryByRole('dialog')).toBeNull();
  busy.unmount();
  const other = document.createElement('div');
  other.setAttribute('role', 'dialog');
  document.body.append(other);
  renderFlow();
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Get to know Tro' })).toBeNull();
  });
  other.remove();
  await screen.findByRole('dialog', { name: 'Get to know Tro' });
  expect(screen.getByText('Step 1 of 6')).toBeTruthy();
});

it('dismisses the tour with Escape', async () => {
  const view = createView();
  renderFlow(view);
  await screen.findByRole('dialog');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), { key: 'Escape' });
  await waitFor(() => {
    expect(view.sendAction).toHaveBeenCalledWith(OnboardingAction.DISMISS);
  });
});
