import { useState, type ReactElement } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useLocale } from '../localization/UseLocale.js';
import { OrganizationNameForm } from './OrganizationNameForm.js';
import { teamMessages } from './TeamMessages.js';
import type { OrganizationSetupView } from './UseOrganizationSetup.js';

interface OrganizationSetupDialogProps {
  view: OrganizationSetupView;
  onSignOut: () => Promise<void>;
}

export function OrganizationSetupDialog({
  view,
  onSignOut,
}: OrganizationSetupDialogProps): ReactElement {
  const { locale, messages: commonMessages } = useLocale();
  const messages = teamMessages[locale];
  const [isCreating, setCreating] = useState(false);
  const showsName = view.organization !== null || (isCreating && view.canCreateOrganization);
  return (
    <Modal
      opened={view.isBlocking}
      onClose={() => {}}
      title={showsName ? messages.setupTitle : messages.chooseSetupTitle}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      centered
      size="md"
    >
      <Stack gap="lg">
        {view.failure && (
          <Alert color="red" role="alert">
            {messages.errors[view.failure]}
          </Alert>
        )}
        {showsName ? (
          <OrganizationNameForm
            key={view.organization?.id ?? 'new'}
            organizationId={view.organization?.id}
            isBusy={view.isBusy}
            onSave={(name) => view.saveName(name)}
          />
        ) : view.isBusy ? (
          <Text size="sm" role="status">
            {messages.checkingSetup}
          </Text>
        ) : view.canContinuePersonal ? (
          <Stack gap="md">
            <Text c="dimmed" size="sm">
              {view.canCreateOrganization
                ? messages.organizationChoiceHint
                : messages.personalChoiceHint}
            </Text>
            {view.canCreateOrganization && (
              <Button
                size="md"
                onClick={() => {
                  setCreating(true);
                }}
              >
                {messages.create}
              </Button>
            )}
          </Stack>
        ) : null}
        {view.canContinuePersonal && (
          <Button
            variant={view.canCreateOrganization || showsName ? 'default' : 'filled'}
            disabled={view.isBusy}
            onClick={() => {
              void view.continuePersonal();
            }}
          >
            {view.organization ? messages.setupLater : messages.continuePersonal}
          </Button>
        )}
        <Group>
          {view.failure && (
            <Button
              variant="default"
              disabled={view.isBusy}
              onClick={() => {
                void view.refresh();
              }}
            >
              {messages.retrySetup}
            </Button>
          )}
          <Button
            variant="subtle"
            onClick={() => {
              void onSignOut();
            }}
          >
            {commonMessages.signOutCurrentAccount}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
