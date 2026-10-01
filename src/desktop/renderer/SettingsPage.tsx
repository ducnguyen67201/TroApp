import { Divider, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactElement } from 'react';
import type { AuthUser } from '#contracts/AuthSession.js';

interface SettingsPageProps {
  user: AuthUser | null;
}

/** A small account summary; appearance is controlled by the shared theme. */
export function SettingsPage({ user }: SettingsPageProps): ReactElement {
  return (
    <section aria-label="Settings" className="settings-page">
      <Stack gap={8} className="page-heading">
        <Title order={1}>Settings</Title>
        <Text c="dimmed" size="sm">
          The essentials, all in one place.
        </Text>
      </Stack>
      <Paper withBorder className="settings-card">
        <Title order={2} mb="lg">
          Account
        </Title>
        {user ? (
          <Stack gap="md">
            <div>
              <Text size="xs" c="dimmed" mb={4}>
                Name
              </Text>
              <Text size="sm">{user.name}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" mb={4}>
                Email
              </Text>
              <Text size="sm" className="account-email">
                {user.email}
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              You can sign out from the sidebar.
            </Text>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            Sign in from the sidebar to see your account.
          </Text>
        )}
        <Divider my="xl" color="var(--tro-border)" />
        <Group justify="space-between">
          <div>
            <Title order={2}>Appearance</Title>
            <Text size="sm" c="dimmed" mt={6}>
              A simple, warm light theme.
            </Text>
          </div>
          <Text size="sm">Light</Text>
        </Group>
      </Paper>
    </section>
  );
}
