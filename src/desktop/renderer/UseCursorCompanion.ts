import { useEffect, useState } from 'react';
import type { TranslationKey } from './localization/English.js';
import { useLocale } from './localization/UseLocale.js';
import { resolveBridgeError } from './localization/BridgeErrors.js';

/** Request local following after permission setup; main deduplicates startup.
 * Task mode affects active demonstrations, not the idle companion's visibility. */
export function useCursorCompanion(userId: string | null, isReady: boolean): string | null {
  const { messages } = useLocale();
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    setErrorKey(null);
    if (!userId || !isReady) return;
    let active = true;

    async function startFollowing(): Promise<void> {
      try {
        const result = await window.tro.startCursorCompanion();
        if (active) {
          setErrorKey(
            result.kind === 'failed'
              ? resolveBridgeError(result.message, 'errorCompanionUnavailable')
              : null,
          );
        }
      } catch {
        if (active) setErrorKey('errorCompanionUnavailable');
      }
    }

    function restartFollowingOnFocus(): void {
      void startFollowing();
    }

    void startFollowing();
    window.addEventListener('focus', restartFollowingOnFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', restartFollowingOnFocus);
    };
  }, [userId, isReady]);

  return errorKey ? messages[errorKey] : null;
}
