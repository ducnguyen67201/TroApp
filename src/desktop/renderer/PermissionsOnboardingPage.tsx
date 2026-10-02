import { Button, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconArrowUpRight, IconCheck, IconRefresh, IconShieldLock } from '@tabler/icons-react';
import type { ReactElement } from 'react';
import { PermissionArea, PermissionGrant } from '#contracts/DesktopPermissions.js';
import { useLocale } from './localization/UseLocale.js';
import type { TranslationCatalog } from './localization/English.js';
import type { DesktopPermissionsController } from './UseDesktopPermissions.js';
import { TroIcon } from './TroIcon.js';

interface PermissionsOnboardingPageProps {
  controller: DesktopPermissionsController;
}

function grantLabel(grant: string, messages: TranslationCatalog): string {
  if (grant === PermissionGrant.GRANTED) return messages.permissionEnabled;
  if (grant === PermissionGrant.MISSING) return messages.permissionMissing;
  return messages.permissionUnknown;
}

/** Real onboarding uses Tro’s host permission status; the HTML prototype's Settings window
 * is only a visual example and never appears inside the shipped application. */
export function PermissionsOnboardingPage({
  controller,
}: PermissionsOnboardingPageProps): ReactElement {
  const { status } = controller;
  const { messages } = useLocale();

  return (
    <section className="permission-page" aria-label={messages.permissionSetup}>
      <div className="permission-progress" aria-label={messages.permissionProgress}>
        <span className="permission-progress-step is-done">
          <IconCheck size={14} /> {messages.signIn}
        </span>
        <span className="permission-progress-line" />
        <span className="permission-progress-step is-current">{messages.permissionMacAccess}</span>
        <span className="permission-progress-line" />
        <span className="permission-progress-step">{messages.permissionReady}</span>
      </div>

      <div className="permission-hero">
        <div>
          <Text className="permission-eyebrow">{messages.permissionOneTimeSetup}</Text>
          <Title order={1}>{messages.permissionHeading}</Title>
          <Text c="dimmed" size="sm" className="permission-lead">
            {messages.permissionIntroduction}
          </Text>
        </div>
        <div className="permission-hero-icon" aria-hidden="true">
          <TroIcon size={132} />
        </div>
      </div>

      <Paper withBorder className="permission-card">
        <Group justify="space-between" align="baseline" mb="sm">
          <Title order={2}>{messages.permissionTitle}</Title>
          <Text size="xs" c="dimmed">
            {messages.permissionBothNeeded}
          </Text>
        </Group>
        <Stack gap={0}>
          <div className="permission-row">
            <div className="permission-row-copy">
              <Text fw={600}>{messages.permissionAccessibility}</Text>
              <Text size="sm" c="dimmed">
                {messages.permissionAccessibilityDescription}
              </Text>
            </div>
            <Text
              className="permission-status"
              data-granted={status?.accessibility === PermissionGrant.GRANTED || undefined}
              size="xs"
            >
              {grantLabel(status?.accessibility ?? PermissionGrant.UNKNOWN, messages)}
            </Text>
            <Button
              variant="subtle"
              rightSection={<IconArrowUpRight size={15} />}
              onClick={() => void controller.openSettings(PermissionArea.ACCESSIBILITY)}
            >
              {messages.permissionOpenSettings}
            </Button>
          </div>
          <div className="permission-row">
            <div className="permission-row-copy">
              <Text fw={600}>{messages.permissionScreenRecording}</Text>
              <Text size="sm" c="dimmed">
                {messages.permissionScreenRecordingDescription}
              </Text>
            </div>
            <Text
              className="permission-status"
              data-granted={status?.screenRecording === PermissionGrant.GRANTED || undefined}
              size="xs"
            >
              {grantLabel(status?.screenRecording ?? PermissionGrant.UNKNOWN, messages)}
            </Text>
            <Button
              variant="subtle"
              rightSection={<IconArrowUpRight size={15} />}
              onClick={() => void controller.openSettings(PermissionArea.SCREEN_RECORDING)}
            >
              {messages.permissionOpenSettings}
            </Button>
          </div>
        </Stack>
        <Group mt="lg" gap="sm">
          <Button
            leftSection={<IconShieldLock size={17} />}
            loading={controller.isRequesting}
            onClick={() => void controller.requestPermissions()}
          >
            {messages.permissionRequest}
          </Button>
          <Button
            variant="default"
            leftSection={<IconRefresh size={17} />}
            loading={controller.isChecking}
            onClick={() => void controller.checkAgain()}
          >
            {messages.permissionCheckAgain}
          </Button>
        </Group>
      </Paper>

      <Text role="status" size="sm" c="dimmed" className="permission-feedback">
        {controller.isChecking ? (
          <>
            <Loader size="xs" mr="xs" /> {messages.permissionChecking}
          </>
        ) : (
          (controller.message ?? messages.permissionReturnHint)
        )}
      </Text>
      <Text size="xs" c="dimmed" className="permission-hint">
        {messages.permissionRestartHint}
      </Text>
    </section>
  );
}
