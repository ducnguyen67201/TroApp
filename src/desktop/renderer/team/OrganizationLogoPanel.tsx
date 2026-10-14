import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, FileButton, Group, Stack, Text, Title } from '@mantine/core';
import { IconUpload } from '@tabler/icons-react';
import { OrganizationAction, type Organization } from '#contracts/Organizations.js';
import { OrganizationLogoMediaType } from '#contracts/OrganizationLogo.js';
import { TroIcon } from '../TroIcon.js';
import { useLocale } from '../localization/UseLocale.js';
import { prepareOrganizationLogo } from './PrepareOrganizationLogo.js';
import { teamMessages } from './TeamMessages.js';
import type { TeamView } from './UseTeam.js';

interface OrganizationLogoPanelProps {
  organization: Organization;
  view: TeamView;
  showTitle?: boolean;
}

export function OrganizationLogoPanel({
  organization,
  view,
  showTitle = true,
}: OrganizationLogoPanelProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [isPreparing, setPreparing] = useState(false);
  const [didFail, setFailed] = useState(false);
  const generation = useRef(0);
  const isBusy = isPreparing || view.isLoading || view.isSaving;
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  async function uploadLogo(file: File | null): Promise<void> {
    if (!file || isBusy) {
      return;
    }
    const requestGeneration = ++generation.current;
    setPreparing(true);
    setFailed(false);
    try {
      const logoDataUrl = await prepareOrganizationLogo(file);
      if (generation.current === requestGeneration) {
        await view.sendCommand({
          kind: OrganizationAction.SET_LOGO,
          organizationId: organization.id,
          logoDataUrl,
        });
      }
    } catch {
      if (generation.current === requestGeneration) {
        setFailed(true);
      }
    } finally {
      if (generation.current === requestGeneration) {
        setPreparing(false);
      }
    }
  }

  return (
    <section aria-label={showTitle ? messages.logoTitle : undefined} data-organization-logo>
      {showTitle && <Title order={4}>{messages.logoTitle}</Title>}
      <Stack gap="sm" mt="sm">
        <Text size="sm" c="dimmed">
          {messages.logoHint}
        </Text>
        <Group align="center">
          {organization.logoDataUrl ? (
            <img
              className="organization-logo-preview"
              src={organization.logoDataUrl}
              width={64}
              height={64}
              alt={organization.name}
            />
          ) : (
            <TroIcon size={64} />
          )}
          {organization.logoDataUrl && (
            <Button
              variant="default"
              disabled={isBusy}
              onClick={() => {
                void view.sendCommand({
                  kind: OrganizationAction.SET_LOGO,
                  organizationId: organization.id,
                  logoDataUrl: null,
                });
              }}
            >
              {messages.removeLogo}
            </Button>
          )}
        </Group>
        <FileButton
          accept={Object.values(OrganizationLogoMediaType).join(',')}
          onChange={(file) => {
            void uploadLogo(file);
          }}
        >
          {(buttonProps) => (
            <Button
              {...buttonProps}
              variant="default"
              leftSection={<IconUpload size={16} aria-hidden="true" />}
              disabled={isBusy}
            >
              {organization.logoDataUrl ? messages.replaceLogo : messages.uploadLogo}
            </Button>
          )}
        </FileButton>
        {isPreparing && (
          <Text size="sm" role="status">
            {messages.preparingLogo}
          </Text>
        )}
        {didFail && (
          <Alert color="red" role="alert">
            {messages.invalidLogo}
          </Alert>
        )}
      </Stack>
    </section>
  );
}
