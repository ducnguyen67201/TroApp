import { expect, it } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  resolveOnboardingContent,
  type OnboardingContent,
} from '../../../../src/desktop/onboarding/domain/OnboardingContent.js';

const variants: Record<DesktopLocale, OnboardingContent> = {
  vi: {
    title: 'Tiếng Việt',
    description: 'Giới thiệu',
    takeaway: 'Bắt đầu',
    video: { source: '/vi/Workspace.mp4' },
    transcript: 'Bản chép lời',
  },
  en: { title: 'English', description: 'Introduction', takeaway: 'Start' },
};

it('selects the matching clip and transcript without changing guide progress', () => {
  const en = {
    ...variants.en,
    video: { source: '/en/Workspace.mp4' },
    transcript: 'English transcript',
  };
  expect(
    resolveOnboardingContent({ ...variants, en }, DesktopLocale.ENGLISH, DesktopLocale.VIETNAMESE),
  ).toMatchObject({
    copy: en,
    video: en.video,
    videoLocale: DesktopLocale.ENGLISH,
    transcript: 'English transcript',
  });
});

it('keeps requested-language text and labels the fallback clip language; absent transcripts stay absent', () => {
  expect(
    resolveOnboardingContent(variants, DesktopLocale.ENGLISH, DesktopLocale.VIETNAMESE),
  ).toMatchObject({
    copy: variants.en,
    video: variants.vi.video,
    videoLocale: DesktopLocale.VIETNAMESE,
    transcript: null,
  });
  expect(
    resolveOnboardingContent(
      { ...variants, en: { ...variants.en, transcript: '  \n ' } },
      DesktopLocale.ENGLISH,
      DesktopLocale.VIETNAMESE,
    ).transcript,
  ).toBeNull();
});

it('supports text-only onboarding with no recording or transcript', () => {
  expect(
    resolveOnboardingContent(
      { vi: variants.en, en: variants.en },
      DesktopLocale.VIETNAMESE,
      DesktopLocale.VIETNAMESE,
    ),
  ).toMatchObject({ video: null, videoLocale: null, transcript: null });
});
