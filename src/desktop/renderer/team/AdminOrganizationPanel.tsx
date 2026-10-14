import { useState, type ReactElement } from 'react';
import { Alert, Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { OrganizationAction, OrganizationLimits } from '#contracts/Organizations.js';
import { useLocale } from '../localization/UseLocale.js';
import { teamMessages } from './TeamMessages.js';
import type { TeamView } from './UseTeam.js';

interface AdminOrganizationPanelProps {
  view: TeamView;
}

/** Admin-only presentation; the backend checks persisted admin authority for every write. */
export function AdminOrganizationPanel({ view }: AdminOrganizationPanelProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [ownerEmail, setOwnerEmail] = useState('');
  const [newOwnerEmail, setNewOwnerEmail] = useState('');
  const [isConfirmingGrant, setConfirmingGrant] = useState(false);
  const isBusy = view.isLoading || view.isSaving;
  const selected = view.home?.organizations.find(
    (organization) => organization.id === view.selectedOrganizationId,
  );
  return (
    <Stack gap="lg">
      <section aria-label={messages.approveOwnerTitle}>
        <Title order={4}>{messages.approveOwnerTitle}</Title>
        <Text size="sm" c="dimmed" mt="xs">
          {messages.approveOwnerHint}
        </Text>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void view
              .sendCommand({
                kind: OrganizationAction.APPROVE_OWNER,
                email: ownerEmail.trim(),
              })
              .then((saved) => {
                if (saved) {
                  setOwnerEmail('');
                }
              });
          }}
        >
          <Stack gap="sm" mt="sm">
            <TextInput
              type="email"
              label={messages.ownerEmail}
              value={ownerEmail}
              maxLength={OrganizationLimits.EMAIL_LENGTH}
              required
              disabled={isBusy}
              onChange={(event) => {
                setOwnerEmail(event.currentTarget.value);
              }}
            />
            <Group>
              <Button type="submit" disabled={isBusy || !ownerEmail.trim()}>
                {messages.approveOwner}
              </Button>
            </Group>
          </Stack>
        </form>
      </section>
      {selected && (
        <section aria-label={messages.grantTitle}>
          <Title order={4}>{messages.grantTitle}</Title>
          <Text size="sm" c="dimmed" mt="xs">
            {messages.grantHint}
          </Text>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setConfirmingGrant(true);
            }}
          >
            <Stack gap="sm" mt="sm">
              <TextInput
                type="email"
                label={messages.newOwnerEmail}
                value={newOwnerEmail}
                maxLength={OrganizationLimits.EMAIL_LENGTH}
                required
                disabled={isBusy || isConfirmingGrant}
                onChange={(event) => {
                  setNewOwnerEmail(event.currentTarget.value);
                }}
              />
              <Group>
                <Button
                  type="submit"
                  variant="default"
                  disabled={isBusy || isConfirmingGrant || !newOwnerEmail.trim()}
                >
                  {messages.grant}
                </Button>
              </Group>
            </Stack>
          </form>
          {isConfirmingGrant && (
            <Alert mt="sm" role="alert">
              <Text size="sm">{messages.grantConfirmation}</Text>
              <Text size="sm" fw={500}>
                {selected.isNameSet === false ? messages.pendingName : selected.name} ·{' '}
                {newOwnerEmail.trim()}
              </Text>
              <Group mt="sm">
                <Button
                  disabled={isBusy}
                  onClick={() => {
                    void view
                      .sendCommand({
                        kind: OrganizationAction.GRANT_OWNER,
                        organizationId: selected.id,
                        email: newOwnerEmail.trim(),
                      })
                      .then((saved) => {
                        setConfirmingGrant(false);
                        if (saved) {
                          setNewOwnerEmail('');
                        }
                      });
                  }}
                >
                  {messages.confirmGrant}
                </Button>
                <Button
                  variant="default"
                  disabled={isBusy}
                  onClick={() => {
                    setConfirmingGrant(false);
                  }}
                >
                  {messages.cancel}
                </Button>
              </Group>
            </Alert>
          )}
        </section>
      )}
    </Stack>
  );
}
