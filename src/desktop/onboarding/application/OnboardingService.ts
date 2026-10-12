import type { OnboardingReply } from '#contracts/Onboarding.js';
import { OnboardingFailure, type OnboardingAction } from '#contracts/OnboardingValues.js';
import { applyOnboardingAction } from '../domain/OnboardingProgress.js';
import type { OnboardingStore } from './OnboardingStore.js';

/** Serializes read/compare/write through a port. No Electron, filesystem, React or media dependencies. */
export class OnboardingService {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: OnboardingStore) {}

  readProgress(accountId: string): Promise<OnboardingReply> {
    return this.enqueue(async () => ({
      kind: 'ok',
      progress: await this.store.readProgress(accountId),
    }));
  }

  changeProgress(
    accountId: string,
    expectedRevision: number,
    action: OnboardingAction,
  ): Promise<OnboardingReply> {
    return this.enqueue(async () => {
      const current = await this.store.readProgress(accountId);
      if (current.revision !== expectedRevision) {
        return { kind: 'failed', reason: OnboardingFailure.CONFLICT };
      }
      const next = applyOnboardingAction(current, action);
      if (!next) {
        return { kind: 'failed', reason: OnboardingFailure.INVALID };
      }
      await this.store.saveProgress(accountId, next);
      return { kind: 'ok', progress: next };
    });
  }

  private enqueue(operation: () => Promise<OnboardingReply>): Promise<OnboardingReply> {
    const result = this.pending.then(operation).catch((): OnboardingReply => ({
      kind: 'failed',
      reason: OnboardingFailure.STORAGE,
    }));
    this.pending = result;
    return result;
  }
}
