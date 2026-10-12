import type { VideoTopic } from './VideoContent.js';

/** One concise Vietnamese narration per ten-second composition. */
export const videoNarration = {
  classes: {
    file: 'ClassesNarration.mp3',
    text: 'Chọn lớp để xem tài liệu và hoạt động. Chưa có lớp? Nhập mã giáo viên chia sẻ để tham gia.',
  },
  insights: {
    file: 'InsightsNarration.mp3',
    text: 'Chọn lớp và khoảng thời gian để xem tiến độ. Cùng giáo viên nhìn lại bài làm, rồi chọn phần cần luyện thêm.',
  },
  lessons: {
    file: 'LessonsNarration.mp3',
    text: 'Mở bài giảng giáo viên đã phát hành để tự học. Chưa hiểu phần nào? Gửi yêu cầu giải thích thêm cho giáo viên.',
  },
  microphone: {
    file: 'MicrophoneNarration.mp3',
    text: 'Chọn micrô muốn dùng. Trên Mac, giữ Command và Control để nói, thả để gửi. Trên Windows, dùng Control và Alt bên trái.',
  },
  pets: {
    file: 'PetsNarration.mp3',
    text: 'Vào Cài đặt, chọn Thú cưng, đặt tên rồi nhận nuôi. Kéo để di chuyển; bật chế độ yên lặng khi cần tập trung.',
  },
} satisfies Record<VideoTopic, { file: string; text: string }>;

export const onboardingSpeechProfile = {
  model: 'gpt-4o-mini-tts',
  voice: 'marin',
  speed: 1.05,
  instructions:
    'Speak only the provided text in fluent, natural Vietnamese. Warm, clear and friendly onboarding narration, with crisp diction and a light conversational energy. Brief natural pauses. Finish within nine seconds without sounding rushed. Pronounce Tro as Trò; read keyboard key names clearly. Do not add an introduction, commentary, music or sound effects.',
} as const;
