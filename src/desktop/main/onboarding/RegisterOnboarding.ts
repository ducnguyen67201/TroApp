import {
  OnboardingReadSchema,
  OnboardingReplySchema,
  OnboardingRestartSchema,
  OnboardingUpdateSchema,
  type OnboardingReply,
} from '#contracts/Onboarding.js';
import { OnboardingAction, OnboardingFailure } from '#contracts/OnboardingValues.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import type { OnboardingService } from '../../onboarding/application/OnboardingService.js';
import type { AccountTransitionGate } from '../accounts/AccountTransitionGate.js';

export interface OnboardingAccess<Event> {
  isTrustedSender(event: Event): boolean;
  readSession(): Promise<AuthResult>;
  gate: AccountTransitionGate;
}

/** Validates both directions and holds the account transition gate throughout authenticated disk access. */
export function registerOnboardingHandlers<Event>(
  ipc: {
    handle(
      channel: string,
      listener: (event: Event, raw: unknown) => Promise<OnboardingReply>,
    ): void;
  },
  access: OnboardingAccess<Event>,
  service: OnboardingService,
): void {
  async function authorize(
    event: Event,
    expectedAccountId: string,
    operation: (accountId: string) => Promise<OnboardingReply>,
  ): Promise<OnboardingReply> {
    const unavailable: OnboardingReply = { kind: 'failed', reason: OnboardingFailure.UNAVAILABLE };
    if (!access.isTrustedSender(event)) {
      return unavailable;
    }
    return access.gate.runRequest(async () => {
      try {
        const session = await access.readSession();
        if (
          !access.isTrustedSender(event) ||
          session.kind !== 'signed-in' ||
          session.user.id !== expectedAccountId
        ) {
          return unavailable;
        }
        const reply = await operation(session.user.id);
        return access.isTrustedSender(event) ? OnboardingReplySchema.parse(reply) : unavailable;
      } catch {
        console.warn('onboarding.access.failed', { stage: 'authorize' });
        return unavailable;
      }
    }, unavailable);
  }

  ipc.handle('tro:onboarding-read', (event, raw: unknown): Promise<OnboardingReply> => {
    const parsed = OnboardingReadSchema.safeParse(raw);
    return parsed.success
      ? authorize(event, parsed.data.expectedAccountId, (accountId) =>
          service.readProgress(accountId),
        )
      : Promise.resolve({ kind: 'failed', reason: OnboardingFailure.INVALID });
  });
  ipc.handle('tro:onboarding-update', (event, raw: unknown): Promise<OnboardingReply> => {
    const parsed = OnboardingUpdateSchema.safeParse(raw);
    return parsed.success
      ? authorize(event, parsed.data.expectedAccountId, (accountId) =>
          service.changeProgress(accountId, parsed.data.expectedRevision, parsed.data.action),
        )
      : Promise.resolve({ kind: 'failed', reason: OnboardingFailure.INVALID });
  });
  ipc.handle('tro:onboarding-restart', (event, raw: unknown): Promise<OnboardingReply> => {
    const parsed = OnboardingRestartSchema.safeParse(raw);
    return parsed.success
      ? authorize(event, parsed.data.expectedAccountId, (accountId) =>
          service.changeProgress(accountId, parsed.data.expectedRevision, OnboardingAction.RESTART),
        )
      : Promise.resolve({ kind: 'failed', reason: OnboardingFailure.INVALID });
  });
}
