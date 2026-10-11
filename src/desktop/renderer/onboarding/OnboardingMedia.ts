import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type {
  OnboardingContent,
  OnboardingVideo,
} from '../../onboarding/domain/OnboardingContent.js';

/* Only build-owned assets become media URLs. No remote manifest, user path or IPC URL is accepted. */
const mediaFiles = import.meta.glob<unknown>('../../assets/onboarding/*/*.{mp4,png,vtt}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const transcriptFiles = import.meta.glob<unknown>('../../assets/onboarding/*/*.txt', {
  eager: true,
  query: '?raw',
  import: 'default',
});

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A locale/stem names an optional bundled recording and its independently optional text assets. */
export function readOnboardingMedia(
  locale: DesktopLocale,
  stem: string,
): Pick<OnboardingContent, 'video' | 'transcript'> {
  const base = `../../assets/onboarding/${locale}/${stem}`;
  const source = readText(mediaFiles[`${base}.mp4`]);
  const poster = readText(mediaFiles[`${base}.png`]);
  const captions = readText(mediaFiles[`${base}.vtt`]);
  const transcript = readText(transcriptFiles[`${base}.txt`]);
  const video: OnboardingVideo | undefined = source
    ? {
        source,
        ...(poster ? { poster } : {}),
        ...(captions ? { captions } : {}),
      }
    : undefined;
  return {
    ...(video ? { video } : {}),
    ...(transcript ? { transcript } : {}),
  };
}
