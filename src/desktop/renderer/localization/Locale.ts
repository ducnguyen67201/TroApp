import { english, type TranslationCatalog } from './English.js';
import { vietnamese } from './Vietnamese.js';

export const DesktopLocale = { VIETNAMESE: 'vi', ENGLISH: 'en' } as const;

export type DesktopLocale = (typeof DesktopLocale)[keyof typeof DesktopLocale];

export const defaultLocale = DesktopLocale.VIETNAMESE;

export const localeStorageKey = 'tro.desktop.locale';

/** This registry owns both the settings options and the available catalogs. */
export const desktopLocales = {
  [DesktopLocale.VIETNAMESE]: { label: 'Tiếng Việt', messages: vietnamese },
  [DesktopLocale.ENGLISH]: { label: 'English', messages: english },
} satisfies Record<DesktopLocale, { label: string; messages: TranslationCatalog }>;

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return typeof value === 'string' && Object.hasOwn(desktopLocales, value);
}

/** A missing, unsupported or unreadable local preference uses Vietnamese. */
export function readSavedLocale(): DesktopLocale {
  try {
    const savedLocale = window.localStorage.getItem(localeStorageKey);
    return isDesktopLocale(savedLocale) ? savedLocale : defaultLocale;
  } catch {
    return defaultLocale;
  }
}
