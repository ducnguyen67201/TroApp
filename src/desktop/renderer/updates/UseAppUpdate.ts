import { useEffect, useRef, useState } from 'react';
import {
  AppUpdateFailure,
  AppUpdatePhase,
  AppUpdateState,
  type AppUpdateSnapshot,
  type AppUpdateStatus,
} from '#contracts/AppUpdate.js';
import { useLocale } from '../localization/UseLocale.js';

export interface AppUpdateView {
  status: AppUpdateStatus;
  isRequesting: boolean;
  message: string | null;
  applyUpdate(): Promise<void>;
}

/** Subscribe before reading so a cached snapshot cannot overwrite live progress. */
export function useAppUpdate(): AppUpdateView {
  const { messages } = useLocale();
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot>({
    revision: 0,
    status: { state: AppUpdateState.DISABLED },
  });
  const [isRequesting, setIsRequesting] = useState(false);
  const [failure, setFailure] = useState<
    keyof Pick<typeof messages, 'updateBusy' | 'updateUnavailable'> | null
  >(null);
  const latestRevision = useRef(-1);
  const isMounted = useRef(false);
  const actionPending = useRef(false);

  useEffect(() => {
    let isCurrent = true;
    isMounted.current = true;
    const receive = (next: AppUpdateSnapshot): void => {
      if (isCurrent && next.revision >= latestRevision.current) {
        latestRevision.current = next.revision;
        setSnapshot(next);
      }
    };
    const unsubscribe = window.tro.subscribeAppUpdate(receive);
    void window.tro
      .readAppUpdate()
      .then(receive)
      .catch(() => {});
    return () => {
      isCurrent = false;
      isMounted.current = false;
      unsubscribe();
    };
  }, []);

  async function applyUpdate(): Promise<void> {
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setIsRequesting(true);
    setFailure(null);
    try {
      const { status } = snapshot;
      const shouldRestart =
        status.state === AppUpdateState.READY ||
        (status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.INSTALL);
      const shouldCheck =
        status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.CHECK;
      const reply = await (shouldRestart
        ? window.tro.restartForAppUpdate()
        : shouldCheck
          ? window.tro.checkAppUpdate()
          : window.tro.downloadAppUpdate());
      if (!isMounted.current) {
        return;
      }
      if (reply.kind === 'ok') {
        if (reply.snapshot.revision >= latestRevision.current) {
          latestRevision.current = reply.snapshot.revision;
          setSnapshot(reply.snapshot);
        }
      } else {
        setFailure(reply.reason === AppUpdateFailure.BUSY ? 'updateBusy' : 'updateUnavailable');
      }
    } catch {
      if (isMounted.current) {
        setFailure('updateUnavailable');
      }
    } finally {
      actionPending.current = false;
      if (isMounted.current) {
        setIsRequesting(false);
      }
    }
  }

  return {
    status: snapshot.status,
    isRequesting,
    message: failure ? messages[failure] : null,
    applyUpdate,
  };
}
