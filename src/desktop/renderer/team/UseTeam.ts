import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationCommand,
  type OrganizationReply,
} from '#contracts/Organizations.js';

export type OrganizationHome = Extract<OrganizationReply, { kind: 'home' }>;

export type OrganizationTeam = Extract<OrganizationReply, { kind: 'team' }>;

export interface TeamView {
  home: OrganizationHome | null;
  team: OrganizationTeam | null;
  selectedOrganizationId: string | null;
  isAvailable: boolean;
  isLoading: boolean;
  isSaving: boolean;
  failure: OrganizationFailure | null;
  refresh(): Promise<void>;
  selectOrganization(organizationId: string): Promise<void>;
  sendCommand(command: OrganizationCommand): Promise<boolean>;
}

interface TeamState {
  accountId: string;
  home: OrganizationHome | null;
  team: OrganizationTeam | null;
  selectedOrganizationId: string | null;
}

/** Account generations keep late roster replies and mutations within their initiating account. */
export function useTeam(
  accountId: string,
  onChanged?: () => void,
  initialOrganizationId?: string,
): TeamView {
  const [state, setState] = useState<TeamState | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [failure, setFailure] = useState<OrganizationFailure | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentAccount = useRef(accountId);
  const currentState = useRef(state);
  const currentOnChanged = useRef(onChanged);
  currentAccount.current = accountId;
  currentState.current = state;
  currentOnChanged.current = onChanged;
  const visibleState = state?.accountId === accountId ? state : null;
  const isAvailable = Boolean(window.tro.controlOrganizations);

  const loadOrganizations = useCallback(
    async (requestGeneration: number, selectedOrganizationId: string | null): Promise<void> => {
      const control = window.tro.controlOrganizations;
      if (!control) {
        return;
      }
      const isCurrent = (): boolean =>
        currentAccount.current === accountId && generation.current === requestGeneration;
      let home: OrganizationReply;
      try {
        home = await control({
          expectedAccountId: accountId,
          command: { kind: OrganizationAction.HOME },
        });
      } catch {
        if (isCurrent()) {
          setState({ accountId, home: null, team: null, selectedOrganizationId });
          setFailure(OrganizationFailure.UNAVAILABLE);
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (home.kind !== 'home') {
        setState({ accountId, home: null, team: null, selectedOrganizationId });
        setFailure(home.kind === 'failed' ? home.code : OrganizationFailure.UNAVAILABLE);
        return;
      }
      const selected =
        home.organizations.find(
          (organization) =>
            organization.id === (home.adminOrganizationId ?? selectedOrganizationId),
        ) ?? home.organizations[0];
      const nextState: TeamState = {
        accountId,
        home,
        team: null,
        selectedOrganizationId: selected?.id ?? null,
      };
      setState(nextState);
      if (
        !selected ||
        (!selected.isOwner && !(home.isAdmin && home.adminOrganizationId === selected.id))
      ) {
        return;
      }
      let team: OrganizationReply;
      try {
        team = await control({
          expectedAccountId: accountId,
          command: { kind: OrganizationAction.TEAM, organizationId: selected.id },
        });
      } catch {
        if (isCurrent()) {
          setFailure(OrganizationFailure.UNAVAILABLE);
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (team.kind === 'team' && team.organization.id === selected.id) {
        setState({ ...nextState, team });
      } else {
        setFailure(team.kind === 'failed' ? team.code : OrganizationFailure.UNAVAILABLE);
      }
    },
    [accountId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.tro.controlOrganizations || pending.current) {
      return;
    }
    const requestGeneration = ++generation.current;
    const previous = currentState.current;
    pending.current = true;
    setLoading(true);
    setFailure(null);
    setState((loaded) => (loaded ? { ...loaded, team: null } : null));
    try {
      await loadOrganizations(
        requestGeneration,
        previous?.accountId === accountId
          ? previous.selectedOrganizationId
          : (initialOrganizationId ?? null),
      );
    } catch {
      if (currentAccount.current === accountId && generation.current === requestGeneration) {
        setState(null);
        setFailure(OrganizationFailure.UNAVAILABLE);
      }
    } finally {
      if (currentAccount.current === accountId && generation.current === requestGeneration) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [accountId, loadOrganizations, initialOrganizationId]);

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setState(null);
    setLoading(false);
    setSaving(false);
    setFailure(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [accountId, refresh]);

  const selectOrganization = async (organizationId: string): Promise<void> => {
    if (pending.current || !visibleState?.home) {
      return;
    }
    const selected = visibleState.home.organizations.find(
      (organization) => organization.id === organizationId,
    );
    if (!selected) {
      return;
    }
    const requestGeneration = ++generation.current;
    pending.current = true;
    setLoading(true);
    setFailure(null);
    setState({
      ...visibleState,
      selectedOrganizationId: selected.id,
      team: null,
    });
    try {
      await loadOrganizations(requestGeneration, selected.id);
    } catch {
      if (currentAccount.current === accountId && generation.current === requestGeneration) {
        setFailure(OrganizationFailure.UNAVAILABLE);
      }
    } finally {
      if (currentAccount.current === accountId && generation.current === requestGeneration) {
        pending.current = false;
        setLoading(false);
      }
    }
  };

  const sendCommand = async (command: OrganizationCommand): Promise<boolean> => {
    const control = window.tro.controlOrganizations;
    if (!control || pending.current) {
      return false;
    }
    const requestGeneration = ++generation.current;
    pending.current = true;
    setSaving(true);
    setFailure(null);
    setState((loaded) => (loaded ? { ...loaded, team: null } : null));
    const isCurrent = (): boolean =>
      currentAccount.current === accountId && generation.current === requestGeneration;
    try {
      const reply = await control({ expectedAccountId: accountId, command });
      if (!isCurrent()) {
        return false;
      }
      const succeeded = reply.kind === 'ok';
      if (succeeded) {
        currentOnChanged.current?.();
      }
      if (!succeeded) {
        setFailure(reply.kind === 'failed' ? reply.code : OrganizationFailure.UNAVAILABLE);
      }
      await loadOrganizations(requestGeneration, visibleState?.selectedOrganizationId ?? null);
      return isCurrent() && succeeded;
    } catch {
      if (isCurrent()) {
        setState(null);
        setFailure(OrganizationFailure.UNAVAILABLE);
      }
      return false;
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setSaving(false);
      }
    }
  };

  return {
    home: visibleState?.home ?? null,
    team: visibleState?.team ?? null,
    selectedOrganizationId: visibleState?.selectedOrganizationId ?? null,
    isAvailable,
    isLoading,
    isSaving,
    failure,
    refresh,
    selectOrganization,
    sendCommand,
  };
}
