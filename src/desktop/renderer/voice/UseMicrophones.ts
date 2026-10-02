import {
  readSavedMicrophoneRanking,
  moveMicrophone,
  orderMicrophones,
  microphoneRankingStorageKey,
} from './MicrophoneRanking.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultMicrophoneId,
  listMicrophones,
  microphoneStorageKey,
  readSavedMicrophone,
  recommendMicrophone,
  type Microphone,
} from './Microphones.js';

export interface MicrophoneView {
  microphones: Microphone[];
  hasCustomRanking: boolean;
  moveMicrophone: (deviceId: string, direction: -1 | 1) => void;
  resetRanking: () => void;
  selectedDeviceId: string;
  recommendedDeviceId: string | null;
  defaultLabel: string;
  isLoading: boolean;
  hasLoaded: boolean;
  hasError: boolean;
  isSaved: boolean;
  isSelectedUnavailable: boolean;
  refreshMicrophones: () => Promise<void>;
  selectMicrophone: (deviceId: string) => void;
}

/** DOM types assume MediaDevices exists; runtime environments may omit it. */
function readMediaDevices(): MediaDevices | undefined {
  return navigator.mediaDevices;
}

/** App-owned device inventory survives navigation and never opens an audio stream.
 * Preference is local to this installation, independent of the signed-in account. */
export function useMicrophones(isEnabled: boolean): MicrophoneView {
  const [ranking, setRanking] = useState(readSavedMicrophoneRanking);
  const [selectedDeviceId, setSelectedDeviceId] = useState(readSavedMicrophone);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [defaultLabel, setDefaultLabel] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isRankingSaved, setIsRankingSaved] = useState(true);
  const [isSaved, setIsSaved] = useState(true);
  const inventoryGeneration = useRef(0);
  const isInventoryActive = useRef(false);

  const refreshMicrophones = useCallback(async (): Promise<void> => {
    if (!isInventoryActive.current) {
      return;
    }
    const generation = ++inventoryGeneration.current;
    setIsLoading(true);
    setHasError(false);
    try {
      const mediaDevices = readMediaDevices();
      if (!mediaDevices) {
        throw new Error('Audio device inventory is unavailable.');
      }
      const devices = await mediaDevices.enumerateDevices();
      if (generation !== inventoryGeneration.current) {
        return;
      }
      setMicrophones(listMicrophones(devices));
      setDefaultLabel(
        devices.find(
          (device) => device.kind === 'audioinput' && device.deviceId === defaultMicrophoneId,
        )?.label ?? '',
      );
      setHasLoaded(true);
    } catch {
      if (generation === inventoryGeneration.current) {
        setHasError(true);
      }
    } finally {
      if (generation === inventoryGeneration.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isInventoryActive.current = isEnabled;
    if (!isEnabled) {
      setMicrophones([]);
      setDefaultLabel('');
      setHasLoaded(false);
      setHasError(false);
      setIsLoading(false);
      return;
    }
    const mediaDevices = readMediaDevices();
    const refresh = (): void => {
      void refreshMicrophones();
    };
    refresh();
    mediaDevices?.addEventListener('devicechange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      isInventoryActive.current = false;
      inventoryGeneration.current += 1;
      mediaDevices?.removeEventListener('devicechange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [isEnabled, refreshMicrophones]);

  function selectMicrophone(deviceId: string): void {
    const isListedMicrophone = microphones.some((microphone) => microphone.deviceId === deviceId);
    if (!isInventoryActive.current || (deviceId !== defaultMicrophoneId && !isListedMicrophone)) {
      return;
    }
    setSelectedDeviceId(deviceId);
    try {
      window.localStorage.setItem(microphoneStorageKey, deviceId);
      setIsSaved(true);
    } catch {
      setIsSaved(false);
    }
  }

  const hasSelectedMicrophone = microphones.some(
    (microphone) => microphone.deviceId === selectedDeviceId,
  );

  function saveRanking(updated: string[]): void {
    if (!isInventoryActive.current) {
      return;
    }
    setRanking(updated);
    try {
      window.localStorage.setItem(microphoneRankingStorageKey, JSON.stringify(updated));
      setIsRankingSaved(true);
    } catch {
      setIsRankingSaved(false);
    }
  }

  const orderedMicrophones = orderMicrophones(microphones, ranking);
  const preferredMicrophone = orderedMicrophones.find((microphone) =>
    ranking.includes(microphone.deviceId),
  );

  return {
    microphones: orderedMicrophones,
    hasCustomRanking: ranking.length > 0,
    moveMicrophone: (deviceId, direction) => {
      saveRanking(moveMicrophone(microphones, ranking, deviceId, direction));
    },
    resetRanking: () => {
      saveRanking([]);
    },
    selectedDeviceId,
    recommendedDeviceId:
      ranking.length > 0
        ? (preferredMicrophone?.deviceId ?? null)
        : (recommendMicrophone(microphones)?.deviceId ?? null),
    defaultLabel,
    isLoading,
    hasLoaded,
    hasError,
    isSaved: isSaved && isRankingSaved,
    isSelectedUnavailable:
      hasLoaded && !hasError && selectedDeviceId !== defaultMicrophoneId && !hasSelectedMicrophone,
    refreshMicrophones,
    selectMicrophone,
  };
}
