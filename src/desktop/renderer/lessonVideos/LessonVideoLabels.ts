import {
  LessonVideoStatus,
  LessonVideoStage,
  LessonVideoFailure,
  type LessonVideo,
} from '#contracts/LessonVideos.js';
import {
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '#contracts/LessonVisuals.js';

type Screen = LessonVideo['screens'][number];

/** Active work belongs to the API and continues independently of open dialogs. */
export function isLessonGenerating(lesson: LessonVideo): boolean {
  return lesson.status === LessonVideoStatus.RUNNING || lesson.status === LessonVideoStatus.QUEUED;
}

export function describeLesson(lesson: LessonVideo, vi: boolean): string {
  if (lesson.status === LessonVideoStatus.READY) {
    const notes = [vi ? 'Video sẵn sàng' : 'Video ready'];
    if (lesson.screens.some(usesStandardAnimationAfterDegradation)) {
      notes.push(
        vi ? 'một số cảnh dùng hoạt ảnh tiêu chuẩn' : 'some scenes use standard animation',
      );
    }
    if (lesson.screens.some((screen) => screen.silent)) {
      notes.push(vi ? 'một số cảnh chưa có giọng đọc' : 'some narration unavailable');
    }
    return notes.join(' · ');
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
  if (lesson.stage === LessonVideoStage.VISUAL) {
    const selected = lesson.screens.filter(
      (screen) =>
        screen.visual?.treatment === LessonVisualTreatment.CUSTOM ||
        screen.visual?.status === LessonVisualStatus.DEGRADED,
    );
    const completed = selected.filter(
      (screen) =>
        screen.visual?.status === LessonVisualStatus.SOURCE_SAVED ||
        screen.visual?.status === LessonVisualStatus.READY ||
        screen.visual?.status === LessonVisualStatus.DEGRADED,
    ).length;
    const current = Math.min(completed + 1, selected.length);
    return selected.length
      ? vi
        ? `Đang tạo hoạt ảnh ${String(current)}/${String(selected.length)}`
        : `Generating animation ${String(current)} of ${String(selected.length)}`
      : vi
        ? 'Đang chuẩn bị hoạt ảnh'
        : 'Preparing animation';
  }
  if (lesson.stage === LessonVideoStage.SPEECH) {
    return `${vi ? 'Đang tạo giọng đọc' : 'Creating narration'} ${String(lesson.screens.filter((screen) => screen.audioId).length)}/${String(lesson.screens.length)}`;
  }
  if (lesson.stage === LessonVideoStage.CLIP) {
    return `${vi ? 'Đang dựng video' : 'Rendering video'} ${String(lesson.screens.filter((screen) => screen.clipId).length)}/${String(lesson.screens.length)}`;
  }
  return vi ? 'Đang hoàn tất video' : 'Finishing video';
}

/** Older lessons without visual metadata use the maintained standard animation. */
export function describeScreenAnimation(screen: Screen, vi: boolean): string {
  if (usesStandardAnimationAfterDegradation(screen)) {
    return vi ? 'Dùng hoạt ảnh tiêu chuẩn' : 'Using standard animation';
  }
  if (screen.visual?.treatment !== LessonVisualTreatment.CUSTOM) {
    return vi ? 'Hoạt ảnh tiêu chuẩn' : 'Standard animation';
  }
  switch (screen.visual.status) {
    case LessonVisualStatus.DEGRADED:
      return vi ? 'Dùng hoạt ảnh tiêu chuẩn' : 'Using standard animation';
    case LessonVisualStatus.READY:
      return vi ? 'Hoạt ảnh riêng' : 'Custom animation';
    case LessonVisualStatus.SOURCE_SAVED:
      return vi ? 'Đã lưu hoạt ảnh riêng · chờ dựng' : 'Custom animation saved · awaiting render';
    case LessonVisualStatus.PENDING:
      return vi ? 'Đang chuẩn bị hoạt ảnh riêng' : 'Custom animation pending';
  }
}

export function describeScreenAnimationNote(screen: Screen, vi: boolean): string | null {
  if (!usesStandardAnimationAfterDegradation(screen)) {
    return null;
  }
  switch (screen.visual?.degradationReason) {
    case LessonVisualDegradation.EDITED:
      return vi
        ? 'Nội dung đã thay đổi. Cảnh này dùng hoạt ảnh tiêu chuẩn để thể hiện nội dung mới mà không gọi lại AI.'
        : 'The content changed. This scene uses standard animation for the updated content without another AI request.';
    case LessonVisualDegradation.BUDGET:
    case LessonVisualDegradation.INPUT_LIMIT:
    case LessonVisualDegradation.ATTEMPTS:
      return vi
        ? 'Đã đạt giới hạn tạo hoạt ảnh riêng. Cảnh này dùng hoạt ảnh tiêu chuẩn và giữ nguyên nội dung.'
        : 'The custom animation allowance was reached. This scene uses standard animation and keeps its lesson content.';
    case LessonVisualDegradation.INCOMPLETE:
    case LessonVisualDegradation.INVALID_SOURCE:
    case LessonVisualDegradation.CODE_ERROR:
      return vi
        ? 'Hoạt ảnh riêng chưa hoàn tất. Cảnh này dùng hoạt ảnh tiêu chuẩn và giữ nguyên nội dung.'
        : 'The custom animation could not be completed. This scene uses standard animation and keeps its lesson content.';
    default:
      return vi
        ? 'Hoạt ảnh riêng chưa khả dụng. Cảnh này dùng hoạt ảnh tiêu chuẩn và giữ nguyên nội dung.'
        : 'Custom animation was unavailable. This scene uses standard animation and keeps its lesson content.';
  }
}

function usesStandardAnimationAfterDegradation(screen: Screen): boolean {
  return screen.visual?.status === LessonVisualStatus.DEGRADED;
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
