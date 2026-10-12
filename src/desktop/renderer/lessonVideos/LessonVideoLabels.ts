import {
  LessonVideoStatus,
  LessonVideoStage,
  LessonVideoFailure,
  type LessonVideo,
} from '#contracts/LessonVideos.js';

export function describeLesson(lesson: LessonVideo, vi: boolean): string {
  if (lesson.status === LessonVideoStatus.READY) {
    return lesson.screens.some((screen) => screen.silent)
      ? vi
        ? 'Video sẵn sàng · một số cảnh chưa có giọng đọc'
        : 'Video ready · some narration unavailable'
      : vi
        ? 'Video sẵn sàng'
        : 'Video ready';
  }
  if (lesson.status === LessonVideoStatus.CANCELLED) {
    return vi ? 'Đã hủy · đã lưu nội dung' : 'Cancelled · content saved';
  }
  if (lesson.status === LessonVideoStatus.STOPPED) {
    return lesson.screens.length
      ? vi
        ? 'Đã có nội dung · video chưa hoàn tất'
        : 'Content ready · video unfinished'
      : vi
        ? 'Chưa tạo được nội dung'
        : 'Content generation stopped';
  }
  if (lesson.status === LessonVideoStatus.QUEUED) {
    return vi ? 'Đang chờ tạo video' : 'Waiting to create video';
  }
  if (lesson.stage === LessonVideoStage.CONTENT) {
    return vi ? 'Đang viết bài giảng' : 'Writing your lesson';
  }
  if (lesson.stage === LessonVideoStage.SPEECH) {
    return `${vi ? 'Đang tạo giọng đọc' : 'Creating narration'} ${String(lesson.screens.filter((screen) => screen.audioId).length)}/${String(lesson.screens.length)}`;
  }
  if (lesson.stage === LessonVideoStage.CLIP) {
    return `${vi ? 'Đang dựng video' : 'Rendering video'} ${String(lesson.screens.filter((screen) => screen.clipId).length)}/${String(lesson.screens.length)}`;
  }
  return vi ? 'Đang hoàn tất video' : 'Finishing video';
}

export function describeLessonFailure(
  code: (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure],
  vi: boolean,
): string {
  switch (code) {
    case LessonVideoFailure.BUDGET:
      return vi
        ? 'Đã đạt giới hạn sử dụng. Nội dung đã lưu vẫn có thể xem.'
        : 'Usage limit reached. Saved content remains available.';
    case LessonVideoFailure.INVALID:
      return vi
        ? 'Kiểm tra nội dung và độ dài. Chọn ít tài liệu hơn nếu cần.'
        : 'Check the content and length. Select fewer materials if needed.';
    case LessonVideoFailure.STALE:
      return vi
        ? 'Bài giảng đã thay đổi. Hãy tải lại trước khi thử tiếp.'
        : 'The lesson changed. Refresh before trying again.';
    case LessonVideoFailure.FORBIDDEN:
      return vi ? 'Bạn cần quyền giáo viên của lớp này.' : 'You need teacher access to this class.';
    case LessonVideoFailure.CONTENT:
      return vi
        ? 'Chưa lưu được kịch bản. Tạo lượt mới có thể phát sinh phí.'
        : 'No script was saved. Creating a new lesson may incur charges.';
    default:
      return vi
        ? 'Tạm thời chưa thể hoàn tất. Tiếp tục từ nội dung đã lưu hoặc kiểm tra dịch vụ dựng video.'
        : 'Unable to finish now. Continue from saved content or check the renderer service.';
  }
}
