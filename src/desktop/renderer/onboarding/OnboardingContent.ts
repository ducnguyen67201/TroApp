import { AccountRole } from '#contracts/AccountRole.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { OnboardingStep } from '#contracts/OnboardingValues.js';
import {
  resolveOnboardingContent,
  type OnboardingContent,
  type ResolvedOnboardingContent,
} from '../../onboarding/domain/OnboardingContent.js';
import { readOnboardingMedia } from './OnboardingMedia.js';

type LocalizedContent = Readonly<Record<DesktopLocale, OnboardingContent>>;
type RoleContent = Readonly<Record<AccountRole, LocalizedContent>>;

function addMedia(stem: string, content: LocalizedContent): LocalizedContent {
  return {
    [DesktopLocale.VIETNAMESE]: {
      ...content.vi,
      ...readOnboardingMedia(DesktopLocale.VIETNAMESE, stem),
    },
    [DesktopLocale.ENGLISH]: { ...content.en, ...readOnboardingMedia(DesktopLocale.ENGLISH, stem) },
  };
}

const workspace = addMedia('Workspace', {
  vi: {
    title: 'Bắt đầu từ điều bạn muốn học.',
    description:
      'Gõ một yêu cầu hoặc nhấn giữ phím tắt giọng nói để trò chuyện với Tro. Chọn cách bạn muốn được hỗ trợ.',
    takeaway: 'Chọn “Hướng dẫn tôi” để tự làm từng bước cùng Tro.',
  },
  en: {
    title: 'Start with what you want to learn.',
    description:
      'Type a request or hold the voice shortcut to talk to Tro. Choose how you would like help.',
    takeaway: 'Choose “Show me” to take each step yourself with Tro’s guidance.',
  },
});

const microphone = addMedia('Microphone', {
  vi: {
    title: 'Nói với Tro bằng micrô của bạn.',
    description:
      'Mở Micrô trên thanh điều hướng để chọn thiết bị. Giữ Command + Control trên Mac hoặc Control + Alt bên trái trên Windows để nói, rồi thả phím để gửi.',
    takeaway: 'Phím tắt đang dùng được hiển thị trong Cài đặt → Chung.',
  },
  en: {
    title: 'Talk to Tro with your microphone.',
    description:
      'Open Microphone in the navigation to choose a device. Hold Command + Control on Mac or Control + Left Alt on Windows to speak, then release to send.',
    takeaway: 'Your current shortcut is shown in Settings → General.',
  },
});

const pets = addMedia('Pets', {
  vi: {
    title: 'Một người bạn nhỏ trên màn hình.',
    description:
      'Vào Cài đặt → Thú cưng, chọn một bạn, đặt tên rồi nhận nuôi. Kéo để di chuyển và bật chế độ yên lặng khi cần tập trung.',
    takeaway: 'Bạn có thể ẩn thú cưng hoặc thay đổi tùy chọn bất cứ lúc nào.',
  },
  en: {
    title: 'A little companion on your screen.',
    description:
      'Open Settings → Pets, choose a companion, give it a name and adopt it. Drag to move it and turn on quiet mode when you need to focus.',
    takeaway: 'You can hide your pet or change its preferences whenever you like.',
  },
});

const content: Readonly<Record<OnboardingStep, RoleContent>> = {
  [OnboardingStep.MICROPHONE]: {
    [AccountRole.STUDENT]: microphone,
    [AccountRole.TEACHER]: microphone,
  },
  [OnboardingStep.PETS]: {
    [AccountRole.STUDENT]: pets,
    [AccountRole.TEACHER]: pets,
  },
  [OnboardingStep.WORKSPACE]: {
    [AccountRole.STUDENT]: workspace,
    [AccountRole.TEACHER]: workspace,
  },
  [OnboardingStep.CLASSES]: {
    [AccountRole.STUDENT]: addMedia('StudentClasses', {
      vi: {
        title: 'Lớp học, tài liệu và hoạt động.',
        description:
          'Mở lớp đã tham gia để xem tài liệu và hoạt động. Khi giáo viên bắt đầu buổi học, bạn có thể chủ động tham gia.',
        takeaway: 'Dùng mã mời từ giáo viên để tham gia một lớp mới.',
      },
      en: {
        title: 'Your class, materials and activities.',
        description:
          'Open an enrolled class to find materials and activities. When your teacher starts a session, choose to join.',
        takeaway: 'Join a new class using an invitation code from your teacher.',
      },
    }),
    [AccountRole.TEACHER]: addMedia('TeacherClasses', {
      vi: {
        title: 'Chuẩn bị lớp học của bạn.',
        description:
          'Tạo lớp, thêm tài liệu và chuẩn bị hoạt động. Xem lại và duyệt nội dung trước khi dùng trong buổi học.',
        takeaway: 'Chia sẻ mã mời để học sinh tham gia lớp.',
      },
      en: {
        title: 'Prepare your classroom.',
        description:
          'Create a class, add materials and prepare activities. Review and approve content before using it in a session.',
        takeaway: 'Share an invitation code so students can join.',
      },
    }),
  },
  [OnboardingStep.INSIGHTS]: {
    [AccountRole.STUDENT]: addMedia('StudentInsights', {
      vi: {
        title: 'Nhìn lại hành trình của bạn.',
        description: 'Chọn một lớp để xem quá trình học từ những hoạt động đã thực hiện.',
        takeaway: 'Dùng thông tin này để trao đổi với giáo viên về phần cần luyện thêm.',
      },
      en: {
        title: 'See how far you’ve come.',
        description: 'Choose a class to review your learning through your classroom activities.',
        takeaway: 'Talk with your teacher about what you would like to practice next.',
      },
    }),
    [AccountRole.TEACHER]: addMedia('TeacherInsights', {
      vi: {
        title: 'Hiểu quá trình học của từng em.',
        description:
          'Chọn một lớp để xem hành trình học sinh, tổng quan lớp và báo cáo từ hoạt động trong lớp.',
        takeaway: 'Đối chiếu hoạt động đã lưu khi xem tiến độ của học sinh.',
      },
      en: {
        title: 'Understand each learner’s progress.',
        description:
          'Choose a class to review student journeys, class summaries and reports from classroom activities.',
        takeaway: 'Review the saved activities behind a student’s progress.',
      },
    }),
  },
  [OnboardingStep.GUIDED_LESSONS]: {
    [AccountRole.STUDENT]: addMedia('StudentGuidedLessons', {
      vi: {
        title: 'Xem, thử, rồi tự mình hiểu.',
        description:
          'Học theo nhịp riêng từ bài giảng giáo viên đã phát hành. Trả lời câu hỏi, nhờ trợ giúp và lưu ghi chú riêng theo bài.',
        takeaway:
          'Bạn có thể học ở nhà mà không cần buổi học trực tiếp. Tính năng đang thử nghiệm.',
      },
      en: {
        title: 'Watch, try, then make it yours.',
        description:
          'Study lessons released by your teacher at your own pace. Answer questions, ask for help and keep private notes.',
        takeaway: 'Study at home without a live classroom session. This feature is in beta.',
      },
    }),
    [AccountRole.TEACHER]: addMedia('TeacherGuidedLessons', {
      vi: {
        title: 'Tạo bài giảng để học sinh tự học.',
        description:
          'Chọn nội dung đã duyệt, xác nhận ví dụ được hỗ trợ và bắt đầu tạo bài giảng. Duyệt kịch bản, xem bản xem trước riêng rồi phát hành.',
        takeaway:
          'Tạo bài giảng có thể phát sinh chi phí; chỉ bắt đầu khi bạn chọn. Tính năng đang thử nghiệm.',
      },
      en: {
        title: 'Prepare lessons for independent study.',
        description:
          'Choose approved material, confirm a supported example and start generation. Approve the script, review a private preview, then release.',
        takeaway:
          'Generation may incur charges and starts only when you choose. This feature is in beta.',
      },
    }),
  },
};

export function readOnboardingContent(
  stepId: OnboardingStep,
  locale: DesktopLocale,
  role: AccountRole,
): ResolvedOnboardingContent {
  return resolveOnboardingContent(content[stepId][role], locale, DesktopLocale.VIETNAMESE);
}
