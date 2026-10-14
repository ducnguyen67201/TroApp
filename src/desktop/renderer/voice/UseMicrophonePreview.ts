import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneCaptureMode, microphonePreviewRenewalMs } from '#contracts/MicrophoneTest.js';
import { MicrophonePreviewCapture } from './MicrophonePreviewCapture.js';
import { defaultMicrophoneId } from './Microphones.js';
import type { MicrophoneView } from './UseMicrophones.js';

interface ActiveMicrophonePreview {
  testId: string;
  deviceId: string;
  capture: MicrophonePreviewCapture;
  renewalTimer: ReturnType<typeof setInterval> | undefined;
  isRenewing: boolean;
}

export interface MicrophonePreviewView {
  activeDeviceId: string | null;
  inputLevelDb: number | null;
  isStarting: boolean;
  hasError: boolean;
  stopPreview: () => Promise<void>;
}

/** DOM declarations assume availability; permissions/runtime can omit this API. */
function readMediaDevices(): MediaDevices | undefined {
  return navigator.mediaDevices;
}

/** Dialog-scoped scalar levels only. Capture never enters transcription or storage. */
export function useMicrophonePreview(
  isEnabled: boolean,
  microphones: MicrophoneView,
): MicrophonePreviewView {
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [inputLevelDb, setInputLevelDb] = useState<number | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isVisible, setIsVisible] = useState(() => !document.hidden);
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const [hasDeviceRefreshError, setHasDeviceRefreshError] = useState(false);
  const [deviceRefreshVersion, setDeviceRefreshVersion] = useState(0);
  const active = useRef<ActiveMicrophonePreview | null>(null);
  const pendingReleases = useRef<Promise<void>>(Promise.resolve());
  const isMounted = useRef(false);
  const currentEnabled = useRef(isEnabled);
  const currentMicrophones = useRef(microphones);
  const deviceRefreshGeneration = useRef(0);
  currentEnabled.current = isEnabled;
  currentMicrophones.current = microphones;

  const releaseLease = useCallback((testId: string): Promise<void> => {
    const release = pendingReleases.current.then(async () => {
      try {
        await window.tro.controlMicrophoneTest({ kind: 'stop', testId });
      } catch {
        /* Main still bounds a lost release by its expiring exclusive lease. */
      }
    });
    pendingReleases.current = release;
    return release;
  }, []);

  const stopPreview = useCallback((): Promise<void> => {
    const preview = active.current;
    active.current = null;
    if (preview) {
      clearInterval(preview.renewalTimer);
      preview.capture.dispose();
    }
    if (isMounted.current) {
      setActiveDeviceId(null);
      setInputLevelDb(null);
      setIsStarting(false);
    }
    return preview ? releaseLease(preview.testId) : pendingReleases.current;
  }, [releaseLease]);

  useEffect(() => {
    isMounted.current = true;
    const unsubscribe = window.tro.subscribeMicrophoneTest((event) => {
      if (event.testId === active.current?.testId) {
        void stopPreview();
        setHasError(true);
      }
    });
    const updateVisibility = (): void => {
      if (document.hidden) {
        void stopPreview();
      }
      setIsVisible(!document.hidden);
    };
    const refreshDevices = (): void => {
      if (!currentEnabled.current) {
        return;
      }
      void stopPreview();
      setIsRefreshingDevices(true);
      setHasDeviceRefreshError(false);
      const generation = ++deviceRefreshGeneration.current;
      void currentMicrophones.current
        .refreshMicrophones()
        .catch(() => {
          if (isMounted.current && generation === deviceRefreshGeneration.current) {
            setHasDeviceRefreshError(true);
            setHasError(true);
          }
        })
        .finally(() => {
          if (isMounted.current && generation === deviceRefreshGeneration.current) {
            setIsRefreshingDevices(false);
            setDeviceRefreshVersion((previous) => previous + 1);
          }
        });
    };
    const mediaDevices = readMediaDevices();
    document.addEventListener('visibilitychange', updateVisibility);
    mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      isMounted.current = false;
      deviceRefreshGeneration.current += 1;
      unsubscribe();
      document.removeEventListener('visibilitychange', updateVisibility);
      mediaDevices?.removeEventListener('devicechange', refreshDevices);
      void stopPreview();
    };
  }, [stopPreview]);

  useEffect(() => {
    setHasDeviceRefreshError(false);
    if (!isEnabled) {
      deviceRefreshGeneration.current += 1;
      setIsRefreshingDevices(false);
    }
  }, [isEnabled, microphones.selectedDeviceId, microphones.isLoading]);

  useEffect(() => {
    void stopPreview();
    const inventory = currentMicrophones.current;
    const hasSelectedDevice =
      inventory.selectedDeviceId === defaultMicrophoneId ||
      inventory.microphones.some(
        (microphone) => microphone.deviceId === inventory.selectedDeviceId,
      );
    if (
      !isEnabled ||
      !isVisible ||
      document.hidden ||
      isRefreshingDevices ||
      hasDeviceRefreshError ||
      inventory.isLoading ||
      !inventory.hasLoaded ||
      inventory.hasError ||
      inventory.isSelectedUnavailable ||
      !hasSelectedDevice
    ) {
      if (!isEnabled) {
        setHasError(false);
      }
      return;
    }

    const deviceId = inventory.selectedDeviceId;
    const testId = crypto.randomUUID();
    const isCurrentPreview = (): boolean =>
      active.current?.testId === testId &&
      currentEnabled.current &&
      !document.hidden &&
      currentMicrophones.current.selectedDeviceId === deviceId;
    const failPreview = (): void => {
      if (isCurrentPreview()) {
        void stopPreview();
        setHasError(true);
      }
    };
    const capture = new MicrophonePreviewCapture((levelDb) => {
      if (isCurrentPreview()) {
        setInputLevelDb(levelDb);
      }
    }, failPreview);
    const preview: ActiveMicrophonePreview = {
      testId,
      deviceId,
      capture,
      renewalTimer: undefined,
      isRenewing: false,
    };
    active.current = preview;
    setActiveDeviceId(deviceId);
    setIsStarting(true);
    setHasError(false);

    const renewLease = async (): Promise<void> => {
      if (!isCurrentPreview() || preview.isRenewing) {
        return;
      }
      preview.isRenewing = true;
      try {
        const reply = await window.tro.controlMicrophoneTest({ kind: 'renew', testId });
        if (reply.kind !== 'ok') {
          failPreview();
        }
      } catch {
        failPreview();
      } finally {
        preview.isRenewing = false;
      }
    };
    const startPreview = async (): Promise<void> => {
      await pendingReleases.current;
      if (!isCurrentPreview()) {
        return;
      }
      try {
        const reply = await window.tro.controlMicrophoneTest({
          kind: 'start',
          testId,
          mode: MicrophoneCaptureMode.PREVIEW,
        });
        if (!isCurrentPreview()) {
          /* Stop pending authorization immediately; a late grant remains fenced. */
          void releaseLease(testId);
          return;
        }
        if (reply.kind !== 'ok') {
          failPreview();
          return;
        }
        preview.renewalTimer = setInterval(() => {
          void renewLease();
        }, microphonePreviewRenewalMs);
        await capture.startPreview(deviceId);
        if (isCurrentPreview()) {
          setIsStarting(false);
        }
      } catch {
        failPreview();
      }
    };
    void startPreview();
    return () => {
      void stopPreview();
    };
  }, [
    isEnabled,
    microphones.selectedDeviceId,
    microphones.hasLoaded,
    microphones.hasError,
    microphones.isSelectedUnavailable,
    microphones.isLoading,
    isVisible,
    isRefreshingDevices,
    hasDeviceRefreshError,
    deviceRefreshVersion,
    releaseLease,
    stopPreview,
  ]);

  return { activeDeviceId, inputLevelDb, isStarting, hasError, stopPreview };
}
