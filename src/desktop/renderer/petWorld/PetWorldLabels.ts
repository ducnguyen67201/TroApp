import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { PetRecognitionCategory } from '#contracts/PetWorld.js';

export type PetWorldTranslate = (english: string, vietnamese: string) => string;

/** Format arbitrary-size point strings without converting them to floating point. */
export function formatPoints(points: string, locale: DesktopLocale): string {
  return new Intl.NumberFormat(locale === DesktopLocale.VIETNAMESE ? 'vi-VN' : 'en-US').format(
    BigInt(points),
  );
}

export function formatPetWorldDate(value: string, locale: DesktopLocale): string {
  return new Intl.DateTimeFormat(locale === DesktopLocale.VIETNAMESE ? 'vi-VN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function describeRecognitionCategory(
  category: PetRecognitionCategory,
  t: PetWorldTranslate,
): string {
  switch (category) {
    case PetRecognitionCategory.CURIOSITY:
      return t('Curiosity', 'Tò mò');
    case PetRecognitionCategory.PERSISTENCE:
      return t('Persistence', 'Kiên trì');
    case PetRecognitionCategory.EXPLANATION:
      return t('Explanation', 'Giải thích');
    case PetRecognitionCategory.CONTRIBUTION:
      return t('Contribution', 'Đóng góp');
    case PetRecognitionCategory.OTHER:
      return t('Another good moment', 'Khoảnh khắc tốt khác');
  }
}
