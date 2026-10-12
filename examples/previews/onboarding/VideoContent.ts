/** Editorial content only: no React, Remotion, network calls or playback state. */
export const VideoTopic = {
  CLASSES: 'classes',
  INSIGHTS: 'insights',
  LESSONS: 'lessons',
  MICROPHONE: 'microphone',
  PETS: 'pets',
} as const;

export type VideoTopic = (typeof VideoTopic)[keyof typeof VideoTopic];

export const ShotKind = {
  INTRO: 'intro',
  SCREEN: 'screen',
  KEYBOARD: 'keyboard',
  PET: 'pet',
} as const;

export interface ShotDefinition {
  topic: VideoTopic;
  kind: (typeof ShotKind)[keyof typeof ShotKind];
  title: string;
  detail: string;
  screen: string | null;
  crop: { x: number; y: number; width: number; height: number };
  pointer: { x: number; y: number };
  action: string;
}

const fullCrop = { x: 0, y: 0, width: 1280, height: 800 };

export const videoTopics = {
  classes: {
    title: 'Lớp học',
    chapter: '01',
    icon: 'school',
    takeaway: 'Chọn lớp. Mở tài liệu. Học cùng nhau.',
  },
  insights: {
    title: 'Tiến độ học tập',
    chapter: '02',
    icon: 'chart',
    takeaway: 'Hiểu bài làm, rồi chọn bước tiếp theo.',
  },
  lessons: {
    title: 'Bài giảng hướng dẫn',
    chapter: '03',
    icon: 'play',
    takeaway: 'Xem từng phần. Học theo nhịp của bạn.',
  },
  microphone: {
    title: 'Micrô',
    chapter: '04',
    icon: 'microphone',
    takeaway: 'Giữ để nói. Thả để gửi.',
  },
  pets: {
    title: 'Thú cưng',
    chapter: '05',
    icon: 'paw',
    takeaway: 'Một người bạn nhỏ. Theo cách của bạn.',
  },
} as const;

export const onboardingShots = {
  ClassesIntro: {
    topic: VideoTopic.CLASSES,
    kind: ShotKind.INTRO,
    title: 'Học cùng lớp.\nBắt đầu ở đây.',
    detail: 'Tài liệu và hoạt động,\ntrong một nơi quen thuộc.',
    screen: 'Classes.png',
    crop: fullCrop,
    pointer: { x: 48, y: 252 },
    action: 'Mở Lớp học',
  },
  ClassesPick: {
    topic: VideoTopic.CLASSES,
    kind: ShotKind.SCREEN,
    title: 'Chọn lớp\ncủa bạn.',
    detail: 'Mỗi lớp có tài liệu\nvà hoạt động riêng.',
    screen: 'Classes.png',
    crop: { x: 115, y: 190, width: 740, height: 450 },
    pointer: { x: 262, y: 460 },
    action: 'Chọn một lớp học',
  },
  ClassesCode: {
    topic: VideoTopic.CLASSES,
    kind: ShotKind.SCREEN,
    title: 'Có mã mời?\nVào lớp nhé.',
    detail: 'Nhập mã giáo viên chia sẻ,\nrồi chọn Vào lớp.',
    screen: 'ClassCode.png',
    crop: { x: 134, y: 524, width: 695, height: 220 },
    pointer: { x: 414, y: 675 },
    action: 'Nhập mã → Vào lớp',
  },
  ClassesReady: {
    topic: VideoTopic.CLASSES,
    kind: ShotKind.SCREEN,
    title: 'Tài liệu.\nHoạt động.',
    detail: 'Giáo viên chuẩn bị nội dung.\nBạn chủ động tham gia buổi học.',
    screen: 'Classes.png',
    crop: { x: 123, y: 82, width: 745, height: 510 },
    pointer: { x: 433, y: 163 },
    action: 'Tài liệu · Hoạt động',
  },
  InsightsIntro: {
    topic: VideoTopic.INSIGHTS,
    kind: ShotKind.INTRO,
    title: 'Nhìn lại.\nHiểu mình hơn.',
    detail: 'Tiến độ bắt đầu từ\nnhững hoạt động đã làm.',
    screen: 'Insights.png',
    crop: fullCrop,
    pointer: { x: 49, y: 330 },
    action: 'Mở Tiến độ học tập',
  },
  InsightsChoose: {
    topic: VideoTopic.INSIGHTS,
    kind: ShotKind.SCREEN,
    title: 'Chọn lớp.\nChọn thời gian.',
    detail: 'Chọn lớp, rồi chọn\nkhoảng thời gian muốn xem.',
    screen: 'Insights.png',
    crop: { x: 128, y: 138, width: 1095, height: 253 },
    pointer: { x: 594, y: 347 },
    action: 'Chọn lớp → Chọn thời gian',
  },
  InsightsRead: {
    topic: VideoTopic.INSIGHTS,
    kind: ShotKind.SCREEN,
    title: 'Đọc kết quả.\nXem ngữ cảnh.',
    detail: 'Bài đã nộp và tiêu chí\nđược ghi nhận trong lớp.',
    screen: 'Insights.png',
    crop: { x: 151, y: 390, width: 1058, height: 263 },
    pointer: { x: 678, y: 536 },
    action: 'Xem các hoạt động đã lưu',
  },
  InsightsNext: {
    topic: VideoTopic.INSIGHTS,
    kind: ShotKind.SCREEN,
    title: 'Biết cần\nluyện gì tiếp.',
    detail: 'Cùng giáo viên nhìn lại\nphần bạn muốn luyện thêm.',
    screen: 'InsightDetail.png',
    crop: { x: 155, y: 180, width: 1050, height: 480 },
    pointer: { x: 986, y: 247 },
    action: 'Trao đổi bước học tiếp theo',
  },
  LessonsIntro: {
    topic: VideoTopic.LESSONS,
    kind: ShotKind.INTRO,
    title: 'Học theo\nnhịp của bạn.',
    detail: 'Bài giảng hướng dẫn.\nĐang thử nghiệm.',
    screen: 'Lessons.png',
    crop: fullCrop,
    pointer: { x: 49, y: 400 },
    action: 'Mở Bài giảng hướng dẫn',
  },
  LessonsPick: {
    topic: VideoTopic.LESSONS,
    kind: ShotKind.SCREEN,
    title: 'Chọn bài\nđã phát hành.',
    detail: 'Chọn lớp trước,\nrồi mở bài giáo viên chia sẻ.',
    screen: 'Lessons.png',
    crop: { x: 120, y: 75, width: 1110, height: 455 },
    pointer: { x: 282, y: 426 },
    action: 'Chọn lớp → Mở bài giảng',
  },
  LessonsPace: {
    topic: VideoTopic.LESSONS,
    kind: ShotKind.SCREEN,
    title: 'Chưa rõ?\nCứ hỏi thêm.',
    detail: 'Viết điều bạn muốn\nđược giải thích rõ hơn.',
    screen: 'LessonHelp.png',
    crop: { x: 420, y: 40, width: 440, height: 323 },
    pointer: { x: 623, y: 205 },
    action: 'Nói rõ phần bạn cần giúp',
  },
  LessonsHelp: {
    topic: VideoTopic.LESSONS,
    kind: ShotKind.SCREEN,
    title: 'Xem lại.\nRồi mới gửi.',
    detail: 'Giáo viên nhận yêu cầu.\nGhi chú riêng không gửi kèm.',
    screen: 'LessonConfirm.png',
    crop: { x: 420, y: 40, width: 440, height: 323 },
    pointer: { x: 640, y: 328 },
    action: 'Xác nhận → Gửi yêu cầu',
  },
  MicrophoneIntro: {
    topic: VideoTopic.MICROPHONE,
    kind: ShotKind.INTRO,
    title: 'Bạn nói.\nTro lắng nghe.',
    detail: 'Một cách khác\nđể gửi yêu cầu.',
    screen: 'Microphone.png',
    crop: fullCrop,
    pointer: { x: 48, y: 519 },
    action: 'Mở Micrô',
  },
  MicrophoneChoose: {
    topic: VideoTopic.MICROPHONE,
    kind: ShotKind.SCREEN,
    title: 'Chọn đúng\nchiếc mic.',
    detail: 'Dùng mic tích hợp,\nUSB hoặc thiết bị của bạn.',
    screen: 'MicrophoneCompare.png',
    crop: { x: 340, y: 175, width: 600, height: 285 },
    pointer: { x: 376, y: 324 },
    action: 'Chọn thiết bị thu âm',
  },
  MicrophoneTest: {
    topic: VideoTopic.MICROPHONE,
    kind: ShotKind.SCREEN,
    title: 'Thử trước.\nNói rõ hơn.',
    detail: 'So sánh mic trong\ncùng một môi trường.',
    screen: 'MicrophoneCompare.png',
    crop: { x: 340, y: 560, width: 600, height: 190 },
    pointer: { x: 421, y: 733 },
    action: 'Bài thử âm thanh cục bộ',
  },
  MicrophoneSpeak: {
    topic: VideoTopic.MICROPHONE,
    kind: ShotKind.KEYBOARD,
    title: 'Giữ để nói.\nThả để gửi.',
    detail: 'Mac: Command + Control\nWindows: Control + Alt trái',
    screen: null,
    crop: fullCrop,
    pointer: { x: 0, y: 0 },
    action: 'Giữ → Nói → Thả',
  },
  PetsIntro: {
    topic: VideoTopic.PETS,
    kind: ShotKind.INTRO,
    title: 'Một người bạn\nnhỏ bên cạnh.',
    detail: 'Mèo hoặc cáo,\nbạn thích ai hơn?',
    screen: 'Pets.png',
    crop: fullCrop,
    pointer: { x: 278, y: 277 },
    action: 'Cài đặt → Thú cưng',
  },
  PetsChoose: {
    topic: VideoTopic.PETS,
    kind: ShotKind.SCREEN,
    title: 'Chọn bạn.\nĐặt một cái tên.',
    detail: 'Chọn mèo hoặc cáo,\nrồi nhận nuôi bạn ấy.',
    screen: 'Pets.png',
    crop: { x: 395, y: 325, width: 680, height: 315 },
    pointer: { x: 899, y: 600 },
    action: 'Đặt tên → Nhận nuôi',
  },
  PetsMove: {
    topic: VideoTopic.PETS,
    kind: ShotKind.PET,
    title: 'Đặt bạn ấy\nở nơi bạn thích.',
    detail: 'Kéo để di chuyển.\nNhấp để xem biểu cảm.',
    screen: null,
    crop: fullCrop,
    pointer: { x: 0, y: 0 },
    action: 'Kéo · Thả · Vuốt ve',
  },
  PetsQuiet: {
    topic: VideoTopic.PETS,
    kind: ShotKind.SCREEN,
    title: 'Vui vừa đủ.\nTập trung hơn.',
    detail: 'Yên lặng, giảm chuyển động\nhoặc ẩn khi bạn muốn.',
    screen: 'PetPreferences.png',
    crop: { x: 400, y: 399, width: 670, height: 215 },
    pointer: { x: 424, y: 522 },
    action: 'Tùy chỉnh theo cách của bạn',
  },
} satisfies Record<string, ShotDefinition>;

export type ShotId = keyof typeof onboardingShots;

export const shotIds = Object.keys(onboardingShots).filter(
  (key): key is ShotId => key in onboardingShots,
);
