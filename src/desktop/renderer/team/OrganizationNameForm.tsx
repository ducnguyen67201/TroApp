import { useState, type ReactElement } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import {
  OrganizationAction,
  OrganizationCommandSchema,
  OrganizationLimits,
} from '#contracts/Organizations.js';
import { useLocale } from '../localization/UseLocale.js';
import { teamMessages } from './TeamMessages.js';

interface OrganizationNameFormProps {
  organizationId?: string | undefined;
  isBusy: boolean;
  onSave: (name: string) => Promise<boolean>;
}

/** A review step makes the permanent choice explicit before its single write. */
export function OrganizationNameForm({
  organizationId,
  isBusy,
  onSave,
}: OrganizationNameFormProps): ReactElement {
  const { locale } = useLocale();
  const messages = teamMessages[locale];
  const [name, setName] = useState('');
  const [isReviewing, setReviewing] = useState(false);
  const parsed = OrganizationCommandSchema.safeParse(
    organizationId
      ? {
          kind: OrganizationAction.SET_NAME,
          organizationId,
          name,
        }
      : { kind: OrganizationAction.CREATE_OWN_ORGANIZATION, name },
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.success || isBusy) {
          return;
        }
        if (!isReviewing) {
          setReviewing(true);
          return;
        }
        void onSave(name.trim());
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {messages.namePermanentHint}
        </Text>
        <TextInput
          label={messages.organizationName}
          value={name}
          required
          maxLength={OrganizationLimits.NAME_LENGTH}
          disabled={isBusy}
          readOnly={isReviewing}
          data-autofocus
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        {isReviewing && (
          <Text size="sm" fw={500}>
            {messages.nameConfirmation}
          </Text>
        )}
        <Group>
          <Button type="submit" disabled={isBusy || !parsed.success} loading={isBusy}>
            {isReviewing ? messages.confirmName : messages.reviewName}
          </Button>
          {isReviewing && (
            <Button
              variant="default"
              disabled={isBusy}
              onClick={() => {
                setReviewing(false);
              }}
            >
              {messages.editName}
            </Button>
          )}
        </Group>
      </Stack>
    </form>
  );
}
