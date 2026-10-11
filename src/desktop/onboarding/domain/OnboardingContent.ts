import type { DesktopLocale } from '#contracts/DesktopLocale.js';

export interface OnboardingVideo {
  source: string;
  poster?: string;
  captions?: string;
}

export interface OnboardingContent {
  title: string;
  description: string;
  takeaway: string;
  transcript?: string;
  video?: OnboardingVideo;
}

export interface ResolvedOnboardingContent {
  copy: OnboardingContent;
  video: OnboardingVideo | null;
  videoLocale: DesktopLocale | null;
  transcript: string | null;
}

/** Exact-locale copy is always available. A fallback recording is explicitly labelled by the UI. */
export function resolveOnboardingContent(
  variants: Readonly<Record<DesktopLocale, OnboardingContent>>,
  locale: DesktopLocale,
  fallbackLocale: DesktopLocale,
): ResolvedOnboardingContent {
  const copy = variants[locale];
  const video = copy.video ?? variants[fallbackLocale].video ?? null;
  return {
    copy,
    video,
    videoLocale: copy.video ? locale : video ? fallbackLocale : null,
    transcript: copy.transcript?.trim() || null,
  };
}
