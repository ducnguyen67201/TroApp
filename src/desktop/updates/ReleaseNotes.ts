import { DesktopLocale } from '#contracts/DesktopLocale.js';

export const ReleaseIllustration = {
  PRACTICE: 'practice',
  INSIGHTS: 'insights',
} as const;

export type ReleaseIllustration = (typeof ReleaseIllustration)[keyof typeof ReleaseIllustration];

interface ReleaseHighlightText {
  label: string;
  title: string;
  description: string;
}

export interface ReleaseHighlight {
  id: string;
  illustration: ReleaseIllustration;
  text: Record<DesktopLocale, ReleaseHighlightText>;
}

export interface AppReleaseNotes {
  id: string;
  version: string;
  highlights: readonly ReleaseHighlight[];
}

/** Newest first. Add an entry with the shipped package version only when a release
 * has meaningful highlights. Patch builds may retain the previous entry. Content
 * is bundled, never fetched from a feed or interpreted as HTML. */
export const appReleaseNotes: readonly AppReleaseNotes[] = [
  {
    id: '0.1.0',
    version: '0.1.0',
    highlights: [
      {
        id: 'practice-feedback',
        illustration: ReleaseIllustration.PRACTICE,
        text: {
          vi: {
            label: 'Kiểm tra bài làm',
            title: 'Một gợi ý, đúng lúc cần.',
            description:
              'Chọn cửa sổ bài làm, xem lại ảnh chụp rồi gửi để nhận góp ý. Học sinh có thể xin gợi ý và tự hoàn thành bước tiếp theo.',
          },
          en: {
            label: 'Practice feedback',
            title: 'A hint when it matters.',
            description:
              'Choose your work window, review the capture, then submit it for feedback. Students can ask for a hint and take the next step themselves.',
          },
        },
      },
      {
        id: 'learning-insights',
        illustration: ReleaseIllustration.INSIGHTS,
        text: {
          vi: {
            label: 'Tiến độ học tập',
            title: 'Hiểu lớp mình hơn mỗi ngày.',
            description:
              'Theo dõi hành trình học, xem kết quả bài thực hành và nhận ra những lúc học sinh cần thêm một chút hỗ trợ.',
          },
          en: {
            label: 'Learning insights',
            title: 'Know your class a little better.',
            description:
              'Follow learning journeys, review practice results, and spot the moments when a student needs a little more support.',
          },
        },
      },
    ],
  },
];

/** Unsupported/prerelease versions never trigger a stable-release popup. */
function readStableVersion(version: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return null;
  }
  return version.split('.').map(Number);
}

export function isNewerAppVersion(version: string, previousVersion: string): boolean {
  const current = readStableVersion(version);
  const previous = readStableVersion(previousVersion);
  if (!current || !previous) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const currentPart = current[index] ?? 0;
    const previousPart = previous[index] ?? 0;
    if (currentPart !== previousPart) {
      return currentPart > previousPart;
    }
  }
  return false;
}

/** Exclude future features even when a development or older build bundles notes. */
export function findInstalledReleaseNotes(
  installedVersion: string,
  releases: readonly AppReleaseNotes[] = appReleaseNotes,
): AppReleaseNotes | null {
  return (
    releases.find(
      (release) =>
        release.highlights.length > 0 &&
        (release.version === installedVersion ||
          isNewerAppVersion(installedVersion, release.version)),
    ) ?? null
  );
}
