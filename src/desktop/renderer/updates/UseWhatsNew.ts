import { useCallback, useEffect, useRef, useState } from 'react';
import { WhatsNewReplyKind, type WhatsNewStatus } from '#contracts/WhatsNew.js';
import { appReleaseNotes, type AppReleaseNotes } from '../../updates/ReleaseNotes.js';

export interface WhatsNewView {
  release: AppReleaseNotes | null;
  hasUnseenRelease: boolean;
  shouldAutoShow: boolean;
  didFailToSave: boolean;
  markSeen: () => void;
}

/** Main owns installation/version state. A failed preference read never interrupts
 * startup. An unknown installed version never displays potentially future notes. */
export function useWhatsNew(): WhatsNewView {
  const [status, setStatus] = useState<WhatsNewStatus | null>(null);
  const [didFailToSave, setDidFailToSave] = useState(false);
  const hasMarkedSeen = useRef(false);
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    let isCurrent = true;
    void window.tro
      .readWhatsNew?.()
      .then((reply) => {
        if (isCurrent && !hasMarkedSeen.current && reply.kind === WhatsNewReplyKind.OK) {
          setStatus(reply.status);
        }
      })
      .catch(() => {});
    return () => {
      isCurrent = false;
      isMounted.current = false;
    };
  }, []);

  const markSeen = useCallback((): void => {
    if (hasMarkedSeen.current) {
      return;
    }
    hasMarkedSeen.current = true;
    setStatus((current) =>
      current ? { ...current, hasUnseenRelease: false, shouldAutoShow: false } : current,
    );
    void window.tro
      .markWhatsNewSeen?.()
      .then((reply) => {
        if (!isMounted.current) {
          return;
        }
        if (reply.kind === WhatsNewReplyKind.OK) {
          setStatus(reply.status);
        } else {
          setDidFailToSave(true);
        }
      })
      .catch(() => {
        if (isMounted.current) {
          setDidFailToSave(true);
        }
      });
  }, []);

  return {
    release: status
      ? (appReleaseNotes.find((release) => release.id === status.releaseId) ?? null)
      : null,
    hasUnseenRelease: status?.hasUnseenRelease ?? false,
    shouldAutoShow: status?.shouldAutoShow ?? false,
    didFailToSave,
    markSeen,
  };
}
