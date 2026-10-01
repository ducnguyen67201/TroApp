import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopPermissionStatus, PermissionArea } from '#contracts/DesktopPermissions.js';
import { useLocale } from './localization/UseLocale.js';

type PermissionMessageKey =
  | 'permissionVerifyError'
  | 'permissionSettingsHint'
  | 'permissionRequestError'
  | 'permissionOpenError';

export interface DesktopPermissionsController {
  status: DesktopPermissionStatus | null;
  isChecking: boolean;
  isRequesting: boolean;
  message: string | null;
  checkAgain: () => Promise<void>;
  requestPermissions: () => Promise<void>;
  openSettings: (area: PermissionArea) => Promise<void>;
}

/** A signed-in window reads daemon-owned grants and rechecks on return from
 * System Settings. Only a button click can raise an OS permission prompt. */
export function useDesktopPermissions(userId: string | null): DesktopPermissionsController {
  const { messages } = useLocale();
  const [status, setStatus] = useState<DesktopPermissionStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [messageKey, setMessageKey] = useState<PermissionMessageKey | null>(null);
  const latestRead = useRef(0);

  const checkAgain = useCallback(async (): Promise<void> => {
    if (!userId) return;
    const readNumber = ++latestRead.current;
    setIsChecking(true);
    try {
      const result = await window.tro.readDesktopPermissions();
      if (latestRead.current !== readNumber) return;
      setStatus(result);
      setMessageKey(null);
    } catch {
      if (latestRead.current !== readNumber) return;
      setStatus({ kind: 'unknown', accessibility: 'unknown', screenRecording: 'unknown' });
      setMessageKey('permissionVerifyError');
    } finally {
      if (latestRead.current === readNumber) setIsChecking(false);
    }
  }, [userId]);

  useEffect(() => {
    latestRead.current += 1;
    setStatus(null);
    setMessageKey(null);
    if (!userId) {
      setIsChecking(false);
      return;
    }
    void checkAgain();

    function recheckOnFocus(): void {
      void checkAgain();
    }

    window.addEventListener('focus', recheckOnFocus);
    return () => {
      latestRead.current += 1;
      window.removeEventListener('focus', recheckOnFocus);
    };
  }, [checkAgain, userId]);

  async function requestPermissions(): Promise<void> {
    setIsRequesting(true);
    setMessageKey(null);
    try {
      const result = await window.tro.requestDesktopPermissions();
      setMessageKey(result.kind === 'failed' ? 'permissionRequestError' : 'permissionSettingsHint');
    } catch {
      setMessageKey('permissionRequestError');
    } finally {
      setIsRequesting(false);
    }
  }

  async function openSettings(area: PermissionArea): Promise<void> {
    try {
      const result = await window.tro.openDesktopPermissionSettings(area);
      if (result.kind === 'failed') setMessageKey('permissionOpenError');
    } catch {
      setMessageKey('permissionOpenError');
    }
  }

  return {
    status,
    isChecking,
    isRequesting,
    message: messageKey ? messages[messageKey] : null,
    checkAgain,
    requestPermissions,
    openSettings,
  };
}
