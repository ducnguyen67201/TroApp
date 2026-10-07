import { DesktopLocale } from '#contracts/DesktopLocale.js';

interface ClassroomMessages {
  errorClassroomTeachMode: string;
  errorClassroomContextChanged: string;
}

const classroomMessages = {
  [DesktopLocale.ENGLISH]: {
    errorClassroomTeachMode: 'In class, choose Show me so you perform the learning actions.',
    errorClassroomContextChanged: 'The class context changed. Send your request again.',
  },
  [DesktopLocale.VIETNAMESE]: {
    errorClassroomTeachMode: 'Trong lớp học, hãy chọn “Chỉ cho tôi” để tự thực hiện bài tập.',
    errorClassroomContextChanged: 'Nội dung buổi học đã thay đổi. Hãy gửi lại yêu cầu.',
  },
} satisfies Record<DesktopLocale, ClassroomMessages>;

/** Shared desktop copy for main-process failures and renderer locale catalogs. */
export function readClassroomMessages(locale: DesktopLocale): ClassroomMessages {
  return classroomMessages[locale];
}
