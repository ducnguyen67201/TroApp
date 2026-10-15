import { DesktopLocale } from '#contracts/DesktopLocale.js';

export const ReleaseIllustration = {
  QR_LOGIN: 'qr-login',
  TEAM: 'team',
  ORGANIZATION_LOGO: 'organization-logo',
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
        id: 'qr-login',
        illustration: ReleaseIllustration.QR_LOGIN,
        text: {
          vi: {
            label: 'Đăng nhập bằng QR',
            title: 'Quét thẻ, bắt đầu học.',
            description:
              'Học sinh dùng thẻ QR để đăng nhập trên máy tính đã được tổ chức kích hoạt. Không cần email hay tài khoản Google; bài làm vẫn được lưu cho lần học tiếp theo.',
          },
          en: {
            label: 'QR login',
            title: 'Scan your card. Start learning.',
            description:
              'Students can sign in with a QR card on a computer authorized by their organization. No email or Google account needed, and saved work is ready for the next session.',
          },
        },
      },
      {
        id: 'organization-team',
        illustration: ReleaseIllustration.TEAM,
        text: {
          vi: {
            label: 'Quản lý đội nhóm',
            title: 'Phân quyền, phân công lớp.',
            description:
              'Trong Cài đặt → Đội nhóm, chủ tổ chức có thể thêm thành viên, đặt quyền Giáo viên hoặc Học sinh và phân công giáo viên cho từng lớp. Một lớp có thể có nhiều giáo viên.',
          },
          en: {
            label: 'Team management',
            title: 'Set roles. Assign classes.',
            description:
              'In Settings → Team, organization owners can add members, set Teacher or Student permissions, and assign teachers to each class. A class can have multiple teachers.',
          },
        },
      },
      {
        id: 'organization-logo',
        illustration: ReleaseIllustration.ORGANIZATION_LOGO,
        text: {
          vi: {
            label: 'Logo tổ chức',
            title: 'Dấu ấn riêng của tổ chức.',
            description:
              'Chủ tổ chức có thể tải lên hoặc thay logo trong Cài đặt → Đội nhóm. Logo hiển thị trên thanh bên, giúp thành viên dễ nhận ra tổ chức của mình.',
          },
          en: {
            label: 'Organization logo',
            title: 'Make your organization feel at home.',
            description:
              'Owners can upload or change their organization’s logo in Settings → Team. It appears in the sidebar so members can recognize their organization at a glance.',
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
