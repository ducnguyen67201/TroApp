import { Button, Divider, Group, NativeSelect, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactElement } from 'react';
import { desktopLocales } from './localization/Locale.js';
import { useLocale } from './localization/UseLocale.js';
import type { AuthUser } from '#contracts/AuthSession.js';

interface SettingsPageProps {
  user: AuthUser | null;
  onChooseMicrophone: () => void;
}

/** Account details, local language and microphone preferences, and appearance. */
export function SettingsPage({ user, onChooseMicrophone }: SettingsPageProps): ReactElement {
  const { locale, messages, changeLocale, isLocaleSaved } = useLocale();

  return (
    <section aria-label={messages.settings} className="settings-page">
      <Stack gap={8} className="page-heading">
        <Title order={1}>{messages.settings}</Title>
        <Text c="dimmed" size="sm">
          {messages.settingsDescription}
        </Text>
      </Stack>
      <Paper withBorder className="settings-card">
        <Title order={2} mb="lg">
          {messages.account}
        </Title>
        {user ? (
          <Stack gap="md">
            <div>
              <Text size="xs" c="dimmed" mb={4}>
                {messages.name}
              </Text>
              <Text size="sm">{user.name}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" mb={4}>
                {messages.email}
              </Text>
              <Text size="sm" className="account-email">
                {user.email}
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              {messages.signOutHint}
            </Text>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {messages.accountSignInHint}
          </Text>
        )}
        <Divider my="xl" color="var(--tro-border)" />
        <NativeSelect
          label={messages.language}
          description={messages.languageDescription}
          value={locale}
          onChange={(event) => {
            changeLocale(event.currentTarget.value);
          }}
          data={Object.entries(desktopLocales).map(([value, entry]) => ({
            value,
            label: entry.label,
          }))}
        />
        {!isLocaleSaved && (
          <Text size="sm" role="status" mt="sm">
            {messages.languageStorageWarning}
          </Text>
        )}
        <Divider my="xl" color="var(--tro-border)" />
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>{messages.microphone}</Title>
            <Text size="sm" c="dimmed" mt={6}>
              {messages.microphoneDescription}
            </Text>
          </div>
          <Button variant="default" onClick={onChooseMicrophone} disabled={!user}>
            {messages.microphoneChange}
          </Button>
        </Group>
        <Divider my="xl" color="var(--tro-border)" />
        <Group justify="space-between">
          <div>
            <Title order={2}>{messages.appearance}</Title>
            <Text size="sm" c="dimmed" mt={6}>
              {messages.appearanceDescription}
            </Text>
          </div>
          <Text size="sm">{messages.light}</Text>
        </Group>
      </Paper>
    </section>
  );
}
