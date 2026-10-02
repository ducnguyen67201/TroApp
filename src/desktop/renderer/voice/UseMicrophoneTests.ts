import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicrophoneView } from './UseMicrophones.js';
import { MicrophoneTestCapture } from './MicrophoneTestCapture.js';
import { MicrophoneTestPhase, type MicrophoneTestResult } from './MicrophoneMeasurements.js';

interface ActiveMicrophoneTest {
  testId: string;
  deviceId: string;
  capture: MicrophoneTestCapture;
}

export interface MicrophoneTestsView {
  activeDeviceId: string | null;
  phase: MicrophoneTestPhase;
  secondsRemaining: number;
  results: MicrophoneTestResult[];
  hasError: boolean;
  startTest: (deviceId: string) => Promise<void>;
  cancelTest: () => void;
}

/** Browser declarations assume availability; permissions/runtime can omit this API. */
function readMediaDevices(): MediaDevices | undefined {
  return navigator.mediaDevices;
}

/** App-owned ephemeral measurements. Audio never enters the voice relay or local storage. */
export function useMicrophoneTests(
  isEnabled: boolean,
  microphones: MicrophoneView,
): MicrophoneTestsView {
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [phase, setPhase] = useState<MicrophoneTestPhase>(MicrophoneTestPhase.OPENING);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [results, setResults] = useState<MicrophoneTestResult[]>([]);
  const [hasError, setHasError] = useState(false);
  const active = useRef<ActiveMicrophoneTest | null>(null);
  const isAllowed = useRef(false);
  const currentMicrophones = useRef(microphones);
  currentMicrophones.current = microphones;

  const cancelTest = useCallback((): void => {
    const test = active.current;
    active.current = null;
    test?.capture.dispose();
    if (test) {
      void window.tro.controlMicrophoneTest({ kind: 'stop', testId: test.testId });
    }
    setActiveDeviceId(null);
  }, []);

  useEffect(() => {
    isAllowed.current = isEnabled;
    if (!isEnabled) {
      cancelTest();
      setResults([]);
      setHasError(false);
      return;
    }
    const unsubscribe = window.tro.subscribeMicrophoneTest((event) => {
      if (event.testId === active.current?.testId) {
        cancelTest();
        setHasError(true);
      }
    });
    const invalidateTests = (): void => {
      cancelTest();
      setResults([]);
    };
    const cancelHiddenTest = (): void => {
      if (document.hidden) {
        cancelTest();
      }
    };
    const mediaDevices = readMediaDevices();
    mediaDevices?.addEventListener('devicechange', invalidateTests);
    document.addEventListener('visibilitychange', cancelHiddenTest);
    return () => {
      isAllowed.current = false;
      unsubscribe();
      mediaDevices?.removeEventListener('devicechange', invalidateTests);
      document.removeEventListener('visibilitychange', cancelHiddenTest);
      cancelTest();
    };
  }, [isEnabled, cancelTest]);

  const startTest = useCallback(
    async (deviceId: string): Promise<void> => {
      if (
        !isAllowed.current ||
        active.current ||
        !currentMicrophones.current.microphones.some(
          (microphone) => microphone.deviceId === deviceId,
        )
      ) {
        return;
      }
      const testId = crypto.randomUUID();
      const isCurrentTest = (): boolean => active.current?.testId === testId;
      let firstSampleAt: number | undefined;
      let captureStartedAt = 0;
      const failTest = (): void => {
        if (isCurrentTest()) {
          cancelTest();
          setHasError(true);
        }
      };
      const capture = new MicrophoneTestCapture((event) => {
        if (!isCurrentTest()) {
          return;
        }
        firstSampleAt ??= performance.now();
        if (event.kind === 'progress') {
          setPhase(event.phase);
          setSecondsRemaining(event.secondsRemaining);
        } else {
          const result = {
            ...event.measurement,
            deviceId,
            startupMs: Math.round(firstSampleAt - captureStartedAt),
          };
          setResults((previous) => [
            ...previous.filter((measurement) => measurement.deviceId !== deviceId),
            result,
          ]);
          cancelTest();
        }
      }, failTest);
      active.current = { testId, deviceId, capture };
      setActiveDeviceId(deviceId);
      setPhase(MicrophoneTestPhase.OPENING);
      setSecondsRemaining(0);
      setHasError(false);
      setResults((previous) => previous.filter((result) => result.deviceId !== deviceId));
      try {
        const reply = await window.tro.controlMicrophoneTest({ kind: 'start', testId });
        if (!isCurrentTest()) {
          /* A late authorization reply must release its lease but never open audio. */
          void window.tro.controlMicrophoneTest({ kind: 'stop', testId });
          return;
        }
        if (reply.kind !== 'ok') {
          failTest();
          return;
        }
        captureStartedAt = performance.now();
        await capture.startTest(deviceId);
        if (isCurrentTest()) {
          void currentMicrophones.current.refreshMicrophones();
        }
      } catch {
        failTest();
      }
    },
    [cancelTest],
  );

  return { activeDeviceId, phase, secondsRemaining, results, hasError, startTest, cancelTest };
}
