import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationSummary,
  type OrganizationCommand,
} from '#contracts/Organizations.js';
import type { OrganizationHome } from './UseTeam.js';

interface SetupState {
  accountId: string;
  home: OrganizationHome | null;
  failure: OrganizationFailure | null;
  isBusy: boolean;
}

export interface OrganizationSetupView {
  organization: OrganizationSummary | null;
  isAdmin: boolean;
  adminOrganizationId: string | null;
  selectAdminOrganization(organizationId: string | null): Promise<boolean>;
  organizations: readonly OrganizationSummary[];
  canCreateOrganization: boolean;
  canContinuePersonal: boolean;
  isBlocking: boolean;
  openChoice(): void;
  continuePersonal(): Promise<boolean>;
  isBusy: boolean;
  failure: OrganizationFailure | null;
  refresh(): Promise<void>;
  saveName(name: string): Promise<boolean>;
}

/** Server-owned setup survives reinstalls; account generations fence late reads and writes. */
export function useOrganizationSetup(accountId: string | null): OrganizationSetupView {
  const [state, setState] = useState<SetupState | null>(null);
  const [forcedChoice, setForcedChoice] = useState<string | null>(null);
  const currentAccount = useRef(accountId);
  const generation = useRef(0);
  const pending = useRef(false);
  currentAccount.current = accountId;
  const visible = state?.accountId === accountId ? state : null;
  const organization =
    visible?.home?.organizations.find((entry) => entry.isOwner && entry.isNameSet === false) ??
    null;
  const isAvailable = Boolean(window.tro.controlOrganizations);
  const canCreateOrganization =
    visible?.home?.canCreateOrganization === true &&
    !visible.home.organizations.some((entry) => entry.isOwner);
  const hasJoined =
    visible?.home?.organizations.some(
      (entry) => entry.role !== null && entry.isNameSet !== false,
    ) ?? false;
  const needsChoice =
    (forcedChoice === accountId && accountId !== null) ||
    (visible?.home?.hasChosenOrganization === false && (!hasJoined || canCreateOrganization));
  const needsName = organization !== null && visible?.home?.hasChosenOrganization !== true;

  const loadHome = useCallback(
    async (
      requestGeneration: number,
      previousFailure: OrganizationFailure | null,
    ): Promise<void> => {
      const control = window.tro.controlOrganizations;
      if (!control || !accountId) {
        return;
      }
      const isCurrent = (): boolean =>
        currentAccount.current === accountId && generation.current === requestGeneration;
      const saveFailure = (failure: OrganizationFailure): void => {
        if (isCurrent()) {
          setState((previous) => ({
            accountId,
            home: previous?.accountId === accountId ? previous.home : null,
            failure,
            isBusy: false,
          }));
        }
      };
      try {
        const reply = await control({
          expectedAccountId: accountId,
          command: { kind: OrganizationAction.HOME },
        });
        if (reply.kind !== 'home') {
          saveFailure(reply.kind === 'failed' ? reply.code : OrganizationFailure.UNAVAILABLE);
        } else if (isCurrent()) {
          setState({
            accountId,
            home: reply,
            failure: previousFailure,
            isBusy: false,
          });
        }
      } catch {
        saveFailure(OrganizationFailure.UNAVAILABLE);
      }
    },
    [accountId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!accountId || !window.tro.controlOrganizations || pending.current) {
      return;
    }
    const requestGeneration = ++generation.current;
    pending.current = true;
    setState((previous) =>
      previous?.accountId === accountId
        ? { ...previous, failure: null, isBusy: true }
        : { accountId, home: null, failure: null, isBusy: true },
    );
    await loadHome(requestGeneration, null);
    if (currentAccount.current === accountId && generation.current === requestGeneration) {
      pending.current = false;
    }
  }, [accountId, loadHome]);

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setState(null);
    setForcedChoice(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const refreshOnFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [refresh]);

  async function sendSetupCommand(command: OrganizationCommand): Promise<boolean> {
    const control = window.tro.controlOrganizations;
    if (!accountId || !control || !visible || pending.current) {
      return false;
    }
    const requestGeneration = ++generation.current;
    const isCurrent = (): boolean =>
      currentAccount.current === accountId && generation.current === requestGeneration;
    pending.current = true;
    setState({ ...visible, failure: null, isBusy: true });
    try {
      const reply = await control({
        expectedAccountId: accountId,
        command,
      });
      if (!isCurrent()) {
        return false;
      }
      const succeeded =
        reply.kind === 'ok' || reply.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION;
      if (succeeded) {
        setForcedChoice(null);
        if (reply.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION) {
          setState((previous) =>
            previous?.accountId === accountId && previous.home
              ? {
                  ...previous,
                  home: { ...previous.home, adminOrganizationId: reply.organization?.id ?? null },
                }
              : previous,
          );
        }
      }
      await loadHome(
        requestGeneration,
        succeeded ? null : reply.kind === 'failed' ? reply.code : OrganizationFailure.UNAVAILABLE,
      );
      return isCurrent() && succeeded;
    } catch {
      if (isCurrent()) {
        setState({ ...visible, failure: OrganizationFailure.UNAVAILABLE, isBusy: false });
      }
      return false;
    } finally {
      if (isCurrent()) {
        pending.current = false;
      }
    }
  }

  async function saveName(name: string): Promise<boolean> {
    if (organization) {
      return sendSetupCommand({
        kind: OrganizationAction.SET_NAME,
        organizationId: organization.id,
        name,
      });
    }
    return canCreateOrganization
      ? sendSetupCommand({ kind: OrganizationAction.CREATE_OWN_ORGANIZATION, name })
      : false;
  }

  return {
    isAdmin: visible?.home?.isAdmin === true,
    adminOrganizationId: visible?.home?.adminOrganizationId ?? null,
    selectAdminOrganization: (organizationId) =>
      sendSetupCommand({ kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION, organizationId }),
    organization,
    organizations: visible?.home?.organizations ?? [],
    canCreateOrganization,
    canContinuePersonal: Boolean(visible?.home),
    openChoice: () => {
      if (accountId) {
        setForcedChoice(accountId);
      }
    },
    continuePersonal: () => sendSetupCommand({ kind: OrganizationAction.CONTINUE_PERSONAL }),
    isBlocking: Boolean(accountId && isAvailable && (!visible?.home || needsChoice || needsName)),
    isBusy: visible?.isBusy ?? Boolean(accountId && isAvailable),
    failure: visible?.failure ?? null,
    refresh,
    saveName,
  };
}
