import { createContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import {
  desktopLocales,
  isDesktopLocale,
  localeStorageKey,
  readSavedLocale,
  type DesktopLocale,
} from './Locale.js';
import type { TranslationCatalog } from './English.js';

export interface LocaleContextValue {
  locale: DesktopLocale;
  messages: TranslationCatalog;
  isLocaleSaved: boolean;
  changeLocale: (value: string) => void;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Only the language preference is persisted; task content stays in memory. */
export function LocaleProvider({ children }: { children: ReactNode }): ReactElement {
  const [locale, setLocale] = useState(readSavedLocale);
  const [isLocaleSaved, setIsLocaleSaved] = useState(true);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function changeLocale(value: string): void {
    if (!isDesktopLocale(value)) {
      return;
    }
    setLocale(value);
    try {
      window.localStorage.setItem(localeStorageKey, value);
      setIsLocaleSaved(true);
    } catch {
      setIsLocaleSaved(false);
    }
  }

  return (
    <LocaleContext.Provider
      value={{ locale, messages: desktopLocales[locale].messages, isLocaleSaved, changeLocale }}
    >
      {children}
    </LocaleContext.Provider>
  );
}
