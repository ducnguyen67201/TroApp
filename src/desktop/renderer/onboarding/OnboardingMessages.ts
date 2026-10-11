import { DesktopLocale } from '#contracts/DesktopLocale.js';

const english = {
  title: 'Get to know Tro',
  welcomeTitle: 'A little help getting started.',
  welcomeBody:
    'Explore your workspace, classes, learning progress, lessons, microphone and pets. Watch the short introductions or follow the text at your own pace.',
  welcomeHint: 'You can skip and restart from Settings whenever you like.',
  start: 'Show me around',
  skip: 'Skip tour',
  close: 'Close onboarding',
  back: 'Back',
  next: 'Next',
  finish: 'Finish',
  transcript: 'Read transcript',
  videoUnavailable:
    'A video introduction is not available yet. You can follow the explanation below.',
  videoFailed: 'The video could not play. You can continue with the explanation below.',
  retryVideo: 'Retry video',
  videoLabel: 'Video introduction',
  captions: 'Captions',
  fallbackVideo: (language: string): string => `This recording is in ${language}.`,
  step: (current: number, total: number): string => `Step ${String(current)} of ${String(total)}`,
  completeTitle: 'Ready to explore Tro.',
  completeBody:
    'You’ve explored Tro’s main features. Replay the tour from Settings → General → Restart onboarding.',
  done: 'Explore Tro',
  settingsTitle: 'Getting started with Tro',
  settingsDescription:
    'Replay the introductions for this account on this device. Your classes, lessons, permissions and saved work stay as they are.',
  restart: 'Restart onboarding',
  unavailable: 'Sign in to replay onboarding.',
  error: 'Onboarding progress could not be loaded or saved. Reload progress to try again.',
  retry: 'Reload progress',
  completed: 'Tour completed',
};

type OnboardingMessages = { [Key in keyof typeof english]: (typeof english)[Key] };

const vietnamese: OnboardingMessages = {
  title: 'Làm quen với Tro',
  welcomeTitle: 'Cùng làm quen với Tro nhé.',
  welcomeBody:
    'Làm quen với không gian làm việc, lớp học, tiến độ, bài giảng, micrô và thú cưng. Xem video ngắn hoặc đọc hướng dẫn theo nhịp của bạn.',
  welcomeHint: 'Bạn có thể bỏ qua và bắt đầu lại trong Cài đặt bất cứ lúc nào.',
  start: 'Bắt đầu hướng dẫn',
  skip: 'Bỏ qua',
  close: 'Đóng hướng dẫn',
  back: 'Quay lại',
  next: 'Tiếp theo',
  finish: 'Hoàn tất',
  transcript: 'Đọc nội dung hướng dẫn',
  videoUnavailable: 'Video giới thiệu chưa có sẵn. Bạn có thể đọc phần hướng dẫn bên dưới.',
  videoFailed: 'Không thể phát video. Bạn có thể tiếp tục với phần hướng dẫn bên dưới.',
  retryVideo: 'Thử phát lại video',
  videoLabel: 'Video giới thiệu',
  captions: 'Phụ đề',
  fallbackVideo: (language: string): string => `Video này bằng ${language}.`,
  step: (current: number, total: number): string => `Bước ${String(current)} / ${String(total)}`,
  completeTitle: 'Sẵn sàng khám phá Tro.',
  completeBody:
    'Bạn đã làm quen với các tính năng chính của Tro. Xem lại trong Cài đặt → Chung → Bắt đầu lại hướng dẫn.',
  done: 'Khám phá Tro',
  settingsTitle: 'Làm quen với Tro',
  settingsDescription:
    'Xem lại hướng dẫn cho tài khoản này trên thiết bị này. Lớp học, bài giảng, quyền truy cập và dữ liệu đã lưu vẫn được giữ nguyên.',
  restart: 'Bắt đầu lại hướng dẫn',
  unavailable: 'Đăng nhập để xem lại hướng dẫn.',
  error: 'Không thể đọc hoặc lưu tiến trình hướng dẫn. Hãy tải lại tiến trình để thử lại.',
  retry: 'Tải lại tiến trình',
  completed: 'Đã hoàn tất hướng dẫn',
};

export const onboardingMessages = {
  [DesktopLocale.VIETNAMESE]: vietnamese,
  [DesktopLocale.ENGLISH]: english,
} satisfies Record<DesktopLocale, OnboardingMessages>;
