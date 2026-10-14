import { useState, type ReactElement } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { AccountRole, AccountRoleSchema } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  type OrganizationMember,
  type OrganizationEmailMember,
} from '#contracts/Organizations.js';
import { useLocale } from '../localization/UseLocale.js';
import { OrganizationClassesPanel } from './OrganizationClassesPanel.js';
import { OrganizationLogoPanel } from './OrganizationLogoPanel.js';
import { OrganizationNameForm } from './OrganizationNameForm.js';
import { teamMessages } from './TeamMessages.js';
import type { OrganizationTeam, TeamView } from './UseTeam.js';

interface OwnerTeamPanelProps {
  team: OrganizationTeam;
  view: TeamView;
  showLogoInitially?: boolean;
}

interface MemberRowProps extends OwnerTeamPanelProps {
  member: OrganizationMember;
}

function MemberRow({ member, team, view }: MemberRowProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [isConfirmingRemoval, setConfirmingRemoval] = useState(false);
  const isOwner = team.organization.ownerUserId === member.userId;
  const isBusy = view.isSaving || view.isLoading;
  return (
    <Paper
      withBorder
      p="sm"
      component="section"
      aria-label={member.name || member.email || member.userId}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={500}>{member.name || member.email || member.userId}</Text>
            <Text size="sm" c="dimmed">
              {member.email}
            </Text>
          </div>
          {isOwner && <Badge>{messages.owner}</Badge>}
        </Group>
        <Group align="flex-end">
          <NativeSelect
            aria-label={`${messages.role}: ${member.name || member.email || member.userId}`}
            w={150}
            value={member.role}
            disabled={isBusy}
            data={[
              { value: AccountRole.STUDENT, label: messages.student },
              { value: AccountRole.TEACHER, label: messages.teacher },
            ]}
            onChange={(event) => {
              const role = AccountRoleSchema.safeParse(event.currentTarget.value);
              if (role.success) {
                void view.sendCommand({
                  kind: OrganizationAction.CHANGE_ROLE,
                  organizationId: team.organization.id,
                  userId: member.userId,
                  role: role.data,
                });
              }
            }}
          />
          {!isOwner && (
            <Button
              variant="subtle"
              color="red"
              disabled={isBusy}
              onClick={() => {
                setConfirmingRemoval(true);
              }}
            >
              {messages.remove}
            </Button>
          )}
        </Group>
        {isConfirmingRemoval && (
          <Alert color="red" role="alert">
            <Text size="sm">{messages.removeConfirmation}</Text>
            <Group mt="sm">
              <Button
                color="red"
                disabled={isBusy}
                onClick={() => {
                  void view.sendCommand({
                    kind: OrganizationAction.REMOVE_MEMBER,
                    organizationId: team.organization.id,
                    userId: member.userId,
                  });
                }}
              >
                {messages.confirmRemove}
              </Button>
              <Button
                variant="default"
                disabled={isBusy}
                onClick={() => {
                  setConfirmingRemoval(false);
                }}
              >
                {messages.cancel}
              </Button>
            </Group>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

function EmailMemberRow({
  member,
  team,
  view,
}: OwnerTeamPanelProps & { member: OrganizationEmailMember }): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [isConfirmingRemoval, setConfirmingRemoval] = useState(false);
  const isBusy = view.isLoading || view.isSaving;
  return (
    <Paper withBorder p="sm" component="section" aria-label={member.email}>
      <Stack gap="sm">
        <div>
          <Text fw={500}>{member.email}</Text>
          <Text size="xs" c="dimmed">
            {messages.joinsOnSignIn}
          </Text>
        </div>
        <Group>
          <NativeSelect
            aria-label={`${messages.role}: ${member.email}`}
            w={150}
            value={member.role}
            disabled={isBusy}
            data={[
              { value: AccountRole.STUDENT, label: messages.student },
              { value: AccountRole.TEACHER, label: messages.teacher },
            ]}
            onChange={(event) => {
              const role = AccountRoleSchema.safeParse(event.currentTarget.value);
              if (role.success) {
                void view.sendCommand({
                  kind: OrganizationAction.CHANGE_EMAIL_ROLE,
                  organizationId: team.organization.id,
                  email: member.email,
                  role: role.data,
                });
              }
            }}
          />
          <Button
            variant="subtle"
            color="red"
            disabled={isBusy}
            onClick={() => {
              setConfirmingRemoval(true);
            }}
          >
            {messages.remove}
          </Button>
        </Group>
        {isConfirmingRemoval && (
          <Alert color="red" role="alert">
            <Text size="sm">{messages.removeConfirmation}</Text>
            <Group mt="sm">
              <Button
                color="red"
                disabled={isBusy}
                onClick={() => {
                  void view.sendCommand({
                    kind: OrganizationAction.REMOVE_EMAIL_MEMBER,
                    organizationId: team.organization.id,
                    email: member.email,
                  });
                }}
              >
                {messages.confirmRemove}
              </Button>
              <Button
                variant="default"
                disabled={isBusy}
                onClick={() => {
                  setConfirmingRemoval(false);
                }}
              >
                {messages.cancel}
              </Button>
            </Group>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

/** Membership controls are rendered only after the owner-only team read succeeds. */
export function OwnerTeamPanel({
  team,
  view,
  showLogoInitially,
}: OwnerTeamPanelProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const isBusy = view.isLoading || view.isSaving;
  if (team.organization.isNameSet === false) {
    return (
      <OrganizationNameForm
        organizationId={team.organization.id}
        isBusy={isBusy}
        onSave={(name) =>
          view.sendCommand({
            kind: OrganizationAction.SET_NAME,
            organizationId: team.organization.id,
            name,
          })
        }
      />
    );
  }
  return (
    <Stack gap="lg">
      <section aria-label={messages.members}>
        <Group mb="sm">
          <Title order={4}>{messages.members}</Title>
          <Badge variant="light">{team.members.length + (team.emailMembers?.length ?? 0)}</Badge>
        </Group>
        <Stack gap="sm">
          {team.members.map((member) => (
            <MemberRow key={member.userId} member={member} team={team} view={view} />
          ))}
          {team.emailMembers?.map((member) => (
            <EmailMemberRow key={member.email} member={member} team={team} view={view} />
          ))}
        </Stack>
      </section>
      {team.classes !== undefined && (
        <Accordion variant="separated">
          <Accordion.Item value="classes">
            <Accordion.Control>{messages.classes}</Accordion.Control>
            <Accordion.Panel>
              <OrganizationClassesPanel team={team} view={view} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      <Accordion defaultValue={showLogoInitially ? 'logo' : null} variant="separated">
        <Accordion.Item value="logo">
          <Accordion.Control>{messages.logoTitle}</Accordion.Control>
          <Accordion.Panel>
            <OrganizationLogoPanel organization={team.organization} view={view} showTitle={false} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
