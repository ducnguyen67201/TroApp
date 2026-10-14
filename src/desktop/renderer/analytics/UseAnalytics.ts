import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyticsScreen, AnalyticsStatus } from '#contracts/Analytics.js';

export const AnalyticsPreferenceFailure = { LOAD: 'load', SAVE: 'save' } as const;

type AnalyticsPreferenceFailure =
  (typeof AnalyticsPreferenceFailure)[keyof typeof AnalyticsPreferenceFailure];

export interface AnalyticsView {
  status: AnalyticsStatus | null;
  isLoading: boolean;
  isSaving: boolean;
  failure: AnalyticsPreferenceFailure | null;
  changeEnabled: (enabled: boolean) => Promise<void>;
  retry: () => Promise<void>;
}

/** Main owns the installation preference and delivery. This hook sends only a fixed
 * screen name when sharing is enabled, without route details or account identity. */
export function useAnalytics(screen: AnalyticsScreen | null): AnalyticsView {
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AnalyticsPreferenceFailure | null>(null);
  const generation = useRef(0);
  const isPending = useRef(false);
  const failedPreference = useRef<boolean | null>(null);
  const lastScreen = useRef<AnalyticsScreen | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (isPending.current) {
      return;
    }
    if (!window.tro.readAnalyticsStatus) {
      setStatus({ configured: false, enabled: false });
      setLoading(false);
      return;
    }
    const currentGeneration = ++generation.current;
    isPending.current = true;
    setLoading(true);
    setFailure(null);
    try {
      const reply = await window.tro.readAnalyticsStatus();
      if (currentGeneration !== generation.current) {
        return;
      }
      if (reply.kind === 'ok') {
        setStatus(reply.status);
      } else {
        setFailure(AnalyticsPreferenceFailure.LOAD);
      }
    } catch {
      if (currentGeneration === generation.current) {
        setFailure(AnalyticsPreferenceFailure.LOAD);
      }
    } finally {
      if (currentGeneration === generation.current) {
        isPending.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isPending.current = false;
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const changeEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!status?.configured || isPending.current || !window.tro.setAnalyticsEnabled) {
        return;
      }
      const currentGeneration = ++generation.current;
      isPending.current = true;
      failedPreference.current = enabled;
      setSaving(true);
      setFailure(null);
      try {
        const reply = await window.tro.setAnalyticsEnabled(enabled);
        if (currentGeneration !== generation.current) {
          return;
        }
        if (reply.kind === 'ok') {
          setStatus(reply.status);
          failedPreference.current = null;
        }
      } catch {
        /* Read main's current state below: opt-out stops collection even if
           saving the preference failed. It must not look enabled in this case. */
      }
      if (currentGeneration !== generation.current) {
        return;
      }
      if (failedPreference.current !== null) {
        try {
          const reply = await window.tro.readAnalyticsStatus?.();
          if (currentGeneration === generation.current && reply?.kind === 'ok') {
            setStatus(reply.status);
          }
        } catch {
          /* Keep the last known preference when both operations failed. */
        }
        if (currentGeneration === generation.current) {
          setFailure(AnalyticsPreferenceFailure.SAVE);
        }
      }
      if (currentGeneration === generation.current) {
        isPending.current = false;
        setSaving(false);
      }
    },
    [status?.configured],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (failedPreference.current !== null) {
      await changeEnabled(failedPreference.current);
    } else {
      await refresh();
    }
  }, [changeEnabled, refresh]);

  useEffect(() => {
    if (!status?.configured || !status.enabled) {
      lastScreen.current = null;
      return;
    }
    if (!screen || screen === lastScreen.current || !window.tro.trackScreenView) {
      return;
    }
    lastScreen.current = screen;
    void window.tro.trackScreenView(screen).catch(() => {});
  }, [screen, status?.configured, status?.enabled]);

  return { status, isLoading, isSaving, failure, changeEnabled, retry };
}
