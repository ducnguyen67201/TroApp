import { ClassroomPhase } from '#contracts/Classroom.js';
export type ClassroomTranslate = (english: string, vietnamese: string) => string;

export function formatPhaseLabel(
  phase: (typeof ClassroomPhase)[keyof typeof ClassroomPhase],
  t: (english: string, vietnamese: string) => string,
): string {
  switch (phase) {
    case ClassroomPhase.EXPLANATION:
      return t('Explanation', 'Giải thích');
    case ClassroomPhase.PRACTICE:
      return t('Practice', 'Thực hành');
    case ClassroomPhase.SUBMISSION:
      return t(
        'Legacy submission stage · choose Practice',
        'Giai đoạn nộp bài cũ · chọn Thực hành',
      );
    case ClassroomPhase.REVIEW:
      return t('Review', 'Nhận xét');
  }
}

/** Translate generated source-location labels while preserving source names and line numbers. */
export function formatMaterialLocation(location: string, t: ClassroomTranslate): string {
  const prefixes = [
    ['Page ', 'Trang '],
    ['Slide ', 'Trang trình chiếu '],
    ['Lines ', 'Dòng '],
    ['Stage: ', 'Sân khấu: '],
    ['Sprite: ', 'Nhân vật: '],
  ];
  for (const [english, vietnamese] of prefixes) {
    if (english && vietnamese && location.startsWith(english)) {
      return t(location, vietnamese + location.slice(english.length));
    }
  }
  return location === 'Link' ? t('Link', 'Đường dẫn') : location;
}
