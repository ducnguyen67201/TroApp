import { DesktopLocale } from '#contracts/DesktopLocale.js';

interface PracticeMessages {
  scratchStructureFeedback: string;
  exactOutputFeedback: string;
}

const practiceMessages = {
  [DesktopLocale.ENGLISH]: {
    exactOutputFeedback:
      'Compared supplied evidence with the approved rule; program execution was not verified.',
    scratchStructureFeedback:
      'Checked the connected block chain from the approved event; the project was not executed.',
  },
  [DesktopLocale.VIETNAMESE]: {
    exactOutputFeedback:
      'So sánh bằng chứng đã cung cấp với quy tắc đã duyệt; không xác minh việc chạy chương trình.',
    scratchStructureFeedback: 'Kiểm tra chuỗi khối nối từ sự kiện đã duyệt; chưa chạy dự án.',
  },
} satisfies Record<DesktopLocale, PracticeMessages>;

/** Backend practice feedback copy, selected using the request locale. */
export function readPracticeMessages(locale: DesktopLocale): PracticeMessages {
  return practiceMessages[locale];
}
