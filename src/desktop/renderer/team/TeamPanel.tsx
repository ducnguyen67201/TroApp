import { useEffect, useRef, type ReactElement } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  NativeSelect,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { AccountRole } from '#contracts/AccountRole.js';
import { useLocale } from '../localization/UseLocale.js';
import { AddOrganizationMember } from './AddOrganizationMember.js';
import { AdminOrganizationPanel } from './AdminOrganizationPanel.js';
import { OwnerTeamPanel } from './OwnerTeamPanel.js';
import { teamMessages } from './TeamMessages.js';
import { useTeam } from './UseTeam.js';
import { OrganizationComputerPanel } from './OrganizationComputerPanel.js';
import { canUseStudentAccess } from '../accounts/StudentAccessAvailability.js';

interface TeamPanelProps {
  accountId: string;
  onChanged?: (() => void) | undefined;
  onCreateOrganization?: (() => void) | undefined;
  initialOrganizationId?: string | undefined;
}

export function TeamPanel({
  accountId,
  onChanged,
  onCreateOrganization,
  initialOrganizationId,
}: TeamPanelProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const view = useTeam(accountId, onChanged, initialOrganizationId);
  const panelRef = useRef<HTMLDivElement>(null);
  const didRevealLogo = useRef(false);
  const isBusy = view.isLoading || view.isSaving;
  const selected = view.home?.organizations.find(
    (organization) => organization.id === view.selectedOrganizationId,
  );
  const canManage = Boolean(
    selected &&
    (selected.isOwner || (view.home?.isAdmin && view.home.adminOrganizationId === selected.id)),
  );
  const canManageComputers = Boolean(
    selected &&
    (view.home?.isAdmin ? view.home.adminOrganizationId === selected.id : selected.isOwner),
  );
  const canCreateOrganization =
    view.home?.canCreateOrganization === true &&
    !view.home.organizations.some((organization) => organization.isOwner);
  useEffect(() => {
    if (
      !initialOrganizationId ||
      didRevealLogo.current ||
      view.team?.organization.id !== initialOrganizationId
    ) {
      return;
    }
    const controls = panelRef.current?.querySelector('[data-organization-logo]');
    if (controls) {
      controls.scrollIntoView({ block: 'start', inline: 'nearest' });
      didRevealLogo.current = true;
    }
  }, [initialOrganizationId, view.team]);
  return (
    <Stack gap="md" ref={panelRef}>
      <Group justify="space-between">
        <Title order={3}>{messages.title}</Title>
        <Button
          variant="subtle"
          size="compact-sm"
          disabled={isBusy || !view.isAvailable}
          onClick={() => {
            void view.refresh();
          }}
        >
          {messages.refresh}
        </Button>
      </Group>
      {!view.isAvailable && <Alert role="alert">{messages.unavailable}</Alert>}
      {view.failure && (
        <Alert role="alert" color="red">
          {messages.errors[view.failure]}
        </Alert>
      )}
      {isBusy && (
        <Text size="sm" c="dimmed" role="status">
          {view.isSaving ? messages.saving : messages.loading}
        </Text>
      )}
      {view.home && !view.home.isAdmin && view.home.organizations.length > 1 && (
        <NativeSelect
          label={messages.organization}
          value={view.selectedOrganizationId ?? ''}
          disabled={isBusy}
          data={view.home.organizations.map((organization) => ({
            value: organization.id,
            label: organization.isNameSet === false ? messages.pendingName : organization.name,
          }))}
          onChange={(event) => {
            void view.selectOrganization(event.currentTarget.value);
          }}
        />
      )}
      {selected ? (
        <>
          <Group>
            <Text fw={600}>
              {selected.isNameSet === false ? messages.pendingName : selected.name}
            </Text>
            {selected.isOwner && <Badge>{messages.owner}</Badge>}
            {selected.role && (
              <Text size="sm" c="dimmed">
                {messages.yourRole}:{' '}
                {selected.role === AccountRole.TEACHER ? messages.teacher : messages.student}
              </Text>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {messages.classroomAccessHint}
          </Text>
          {canManage && selected.isNameSet !== false && (
            <AddOrganizationMember key={selected.id} organizationId={selected.id} view={view} />
          )}
          {canManageComputers && selected.isNameSet !== false && canUseStudentAccess() && (
            <OrganizationComputerPanel
              key={`${accountId}:${selected.id}`}
              organizationId={selected.id}
            />
          )}
          {canManage && view.team?.organization.id === selected.id && (
            <OwnerTeamPanel
              key={selected.id}
              team={view.team}
              view={view}
              showLogoInitially={initialOrganizationId === selected.id}
            />
          )}
        </>
      ) : (
        view.home && (
          <Text size="sm" c="dimmed">
            {messages.noOrganizations}
          </Text>
        )
      )}
      {canCreateOrganization && onCreateOrganization && (
        <Button variant="default" onClick={onCreateOrganization} disabled={isBusy}>
          {messages.create}
        </Button>
      )}
      {view.home?.isAdmin && (
        <Accordion variant="separated">
          <Accordion.Item value="owners">
            <Accordion.Control>{messages.ownerApprovals}</Accordion.Control>
            <Accordion.Panel>
              <AdminOrganizationPanel key={view.selectedOrganizationId ?? 'new'} view={view} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Stack>
  );
}
