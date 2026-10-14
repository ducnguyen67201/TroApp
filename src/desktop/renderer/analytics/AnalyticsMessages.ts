import { DesktopLocale } from '#contracts/DesktopLocale.js';

const english = {
  title: 'Share app usage',
  description:
    'Share feature usage, outcomes and app version with PostHog to help improve Tro. Names, emails, screenshots, audio and student work are not included.',
  scope:
    'On by default. You can turn it off here. This choice applies to all accounts on this installation.',
  unavailable: 'Usage sharing is not configured for this installation.',
  loading: 'Loading usage preference…',
  saving: 'Saving usage preference…',
  loadFailed: 'Could not load the usage preference. Try again.',
  saveFailed: 'Could not save this preference. Retry to keep your choice after restarting.',
  retry: 'Retry',
};

type AnalyticsMessages = Record<keyof typeof english, string>;

export const analyticsMessages = {
  [DesktopLocale.ENGLISH]: english,
  [DesktopLocale.VIETNAMESE]: {
    title: 'Chia sẻ dữ liệu sử dụng',
    description:
      'Chia sẻ việc sử dụng tính năng, kết quả và phiên bản ứng dụng với PostHog để cải thiện Tro. Không gửi tên, email, ảnh màn hình, âm thanh hay bài làm của học sinh.',
    scope:
      'Mặc định bật. Bạn có thể tắt tại đây. Lựa chọn này áp dụng cho mọi tài khoản trên bản cài đặt này.',
    unavailable: 'Bản cài đặt này chưa được cấu hình để chia sẻ dữ liệu sử dụng.',
    loading: 'Đang tải tùy chọn chia sẻ…',
    saving: 'Đang lưu tùy chọn chia sẻ…',
    loadFailed: 'Không thể tải tùy chọn chia sẻ. Hãy thử lại.',
    saveFailed: 'Không thể lưu tùy chọn này. Hãy thử lại để giữ lựa chọn sau khi khởi động lại.',
    retry: 'Thử lại',
  },
} satisfies Record<DesktopLocale, AnalyticsMessages>;
