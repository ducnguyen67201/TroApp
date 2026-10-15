import { useEffect, useRef, useState } from 'react';
import {
  AppUpdateFailure,
  AppUpdatePhase,
  AppUpdateState,
  type AppUpdateSnapshot,
  type AppUpdateStatus,
  type AppUpdateReply,
} from '#contracts/AppUpdate.js';
import { useLocale } from '../localization/UseLocale.js';

export interface AppUpdateView {
  status: AppUpdateStatus;
  isRequesting: boolean;
  message: string | null;
  checkForUpdates(): Promise<void>;
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
    keyof Pick<typeof messages, 'updateBusy' | 'updateUnavailable' | 'updateCheckFailed'> | null
  >(null);
  const latestRevision = useRef(-1);
  const isMounted = useRef(false);
  const actionPending = useRef(false);

  useEffect(() => {
    let isCurrent = true;
    isMounted.current = true;
    const receive = (next: AppUpdateSnapshot): void => {
      if (isCurrent && next.revision >= latestRevision.current) {
        if (next.revision > latestRevision.current) {
          setFailure(null);
        }
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

  async function requestUpdate(
    command: () => Promise<AppUpdateReply>,
    failureMessage: 'updateUnavailable' | 'updateCheckFailed',
  ): Promise<void> {
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setIsRequesting(true);
    setFailure(null);
    try {
      const reply = await command();
      if (!isMounted.current) {
        return;
      }
      if (reply.kind === 'ok') {
        if (reply.snapshot.revision >= latestRevision.current) {
          latestRevision.current = reply.snapshot.revision;
          setSnapshot(reply.snapshot);
        }
      } else {
        setFailure(reply.reason === AppUpdateFailure.BUSY ? 'updateBusy' : failureMessage);
      }
    } catch {
      if (isMounted.current) {
        setFailure(failureMessage);
      }
    } finally {
      actionPending.current = false;
      if (isMounted.current) {
        setIsRequesting(false);
      }
    }
  }

  function checkForUpdates(): Promise<void> {
    return requestUpdate(() => window.tro.checkAppUpdate(), 'updateCheckFailed');
  }

  function applyUpdate(): Promise<void> {
    const { status } = snapshot;
    const shouldRestart =
      status.state === AppUpdateState.READY ||
      (status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.INSTALL);
    const shouldCheck =
      status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.CHECK;
    if (shouldCheck) {
      return checkForUpdates();
    }
    return requestUpdate(
      () => (shouldRestart ? window.tro.restartForAppUpdate() : window.tro.downloadAppUpdate()),
      'updateUnavailable',
    );
  }

  return {
    status: snapshot.status,
    isRequesting,
    message: failure ? messages[failure] : null,
    checkForUpdates,
    applyUpdate,
  };
}
