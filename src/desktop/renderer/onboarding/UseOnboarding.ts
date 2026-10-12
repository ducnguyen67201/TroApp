import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OnboardingProgress,
  OnboardingReply,
  OnboardingUpdate,
} from '#contracts/Onboarding.js';
import { OnboardingAction, OnboardingStatus } from '#contracts/OnboardingValues.js';

export interface OnboardingView {
  progress: OnboardingProgress | null;
  isAvailable: boolean;
  isLoading: boolean;
  isSaving: boolean;
  hasError: boolean;
  showCompletion: boolean;
  refresh: () => Promise<void>;
  sendAction: (action: OnboardingUpdate['action']) => Promise<boolean>;
  restart: () => Promise<boolean>;
  closeCompletion: () => void;
}

interface AccountProgress {
  accountId: string;
  progress: OnboardingProgress;
}

/** Renderer coordination only. Main owns durable state; generations fence late reads and saves. */
export function useOnboarding(accountId: string | null): OnboardingView {
  const [loaded, setLoaded] = useState<AccountProgress | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [hasError, setError] = useState(false);
  const [showCompletion, setCompletion] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const isAvailable = Boolean(
    window.tro.readOnboardingProgress &&
    window.tro.updateOnboardingProgress &&
    window.tro.restartOnboarding,
  );
  const progress = loaded?.accountId === accountId ? loaded.progress : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!accountId || !window.tro.readOnboardingProgress || pending.current) {
      return;
    }
    const currentGeneration = ++generation.current;
    pending.current = true;
    setLoading(true);
    setError(false);
    try {
      const reply = await window.tro.readOnboardingProgress({ expectedAccountId: accountId });
      if (currentAccount.current !== accountId || generation.current !== currentGeneration) {
        return;
      }
      if (reply.kind === 'ok') {
        setLoaded({ accountId, progress: reply.progress });
      } else {
        setError(true);
      }
    } catch {
      if (currentAccount.current === accountId && generation.current === currentGeneration) {
        setError(true);
      }
    } finally {
      if (currentAccount.current === accountId && generation.current === currentGeneration) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [accountId]);

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setLoaded(null);
    setLoading(false);
    setSaving(false);
    setError(false);
    setCompletion(false);
    if (isAvailable) {
      void refresh();
    }
    return () => {
      generation.current += 1;
    };
  }, [accountId, isAvailable, refresh]);

  const changeProgress = useCallback(
    async (action: OnboardingAction): Promise<boolean> => {
      if (
        !accountId ||
        !progress ||
        pending.current ||
        !window.tro.updateOnboardingProgress ||
        !window.tro.restartOnboarding
      ) {
        return false;
      }
      const currentGeneration = generation.current;
      pending.current = true;
      setSaving(true);
      setError(false);
      try {
        const identity = { expectedAccountId: accountId, expectedRevision: progress.revision };
        const reply: OnboardingReply =
          action === OnboardingAction.RESTART
            ? await window.tro.restartOnboarding(identity)
            : await window.tro.updateOnboardingProgress({ ...identity, action });
        if (currentAccount.current !== accountId || generation.current !== currentGeneration) {
          return false;
        }
        if (reply.kind !== 'ok') {
          setError(true);
          return false;
        }
        setLoaded({ accountId, progress: reply.progress });
        setCompletion(
          action === OnboardingAction.NEXT && reply.progress.status === OnboardingStatus.COMPLETED,
        );
        return true;
      } catch {
        if (currentAccount.current === accountId && generation.current === currentGeneration) {
          setError(true);
        }
        return false;
      } finally {
        if (currentAccount.current === accountId && generation.current === currentGeneration) {
          pending.current = false;
          setSaving(false);
        }
      }
    },
    [accountId, progress],
  );

  return {
    progress,
    isAvailable,
    isLoading,
    isSaving,
    hasError,
    showCompletion: Boolean(progress && showCompletion),
    refresh,
    sendAction: changeProgress,
    restart: () => changeProgress(OnboardingAction.RESTART),
    closeCompletion: () => {
      setCompletion(false);
    },
  };
}
