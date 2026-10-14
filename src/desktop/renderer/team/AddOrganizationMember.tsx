import { useState, type ReactElement } from 'react';
import { Button, Group, NativeSelect, Paper, Stack, TextInput } from '@mantine/core';
import { IconUserPlus } from '@tabler/icons-react';
import { AccountRole, AccountRoleSchema } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationCommandSchema,
  OrganizationLimits,
} from '#contracts/Organizations.js';
import { useLocale } from '../localization/UseLocale.js';
import { teamMessages } from './TeamMessages.js';
import type { TeamView } from './UseTeam.js';

interface AddOrganizationMemberProps {
  organizationId: string;
  view: TeamView;
}

/** The draft stays mounted while the roster refreshes, so a failed add keeps the entered email. */
export function AddOrganizationMember({
  organizationId,
  view,
}: AddOrganizationMemberProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [isAdding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>(AccountRole.STUDENT);
  const isBusy = view.isLoading || view.isSaving;
  const command = {
    kind: OrganizationAction.ADD_MEMBER,
    organizationId,
    email: email.trim(),
    role,
  };
  if (!isAdding) {
    return (
      <Group justify="flex-end">
        <Button
          leftSection={<IconUserPlus size={16} aria-hidden="true" />}
          disabled={isBusy}
          onClick={() => {
            setAdding(true);
          }}
        >
          {messages.addMember}
        </Button>
      </Group>
    );
  }
  return (
    <Paper
      component="form"
      withBorder
      p="md"
      aria-label={messages.addMember}
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy || !OrganizationCommandSchema.safeParse(command).success) {
          return;
        }
        void view.sendCommand(command).then((saved) => {
          if (saved) {
            setEmail('');
            setRole(AccountRole.STUDENT);
            setAdding(false);
          }
        });
      }}
    >
      <Stack gap="sm">
        <TextInput
          label={messages.email}
          type="email"
          placeholder="name@example.com"
          description={messages.addMemberHint}
          value={email}
          required
          autoFocus
          maxLength={OrganizationLimits.EMAIL_LENGTH}
          disabled={isBusy}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
          }}
        />
        <NativeSelect
          label={messages.permissions}
          value={role}
          disabled={isBusy}
          data={[
            { value: AccountRole.STUDENT, label: messages.student },
            { value: AccountRole.TEACHER, label: messages.teacher },
          ]}
          onChange={(event) => {
            const parsed = AccountRoleSchema.safeParse(event.currentTarget.value);
            if (parsed.success) {
              setRole(parsed.data);
            }
          }}
        />
        <Group justify="flex-end">
          <Button
            variant="subtle"
            disabled={isBusy}
            onClick={() => {
              setEmail('');
              setAdding(false);
            }}
          >
            {messages.cancel}
          </Button>
          <Button
            type="submit"
            leftSection={<IconUserPlus size={16} aria-hidden="true" />}
            loading={view.isSaving}
            disabled={isBusy || !OrganizationCommandSchema.safeParse(command).success}
          >
            {messages.addMember}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
