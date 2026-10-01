import { useContext } from 'react';
import { LocaleContext, type LocaleContextValue } from './LocaleProvider.js';

/** Reads the selected locale and translation catalog from the desktop provider. */
export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error('LocaleProvider must wrap the desktop interface.');
  }

  return context;
}
