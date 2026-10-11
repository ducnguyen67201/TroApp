import { useState, type ReactElement } from 'react';
import { Button, Group, Select, TextInput } from '@mantine/core';
import { PetId } from '#contracts/Pet.js';
import {
  PetWorldCommandKind,
  type PetWorldCommand,
  type PetWorldProfile,
} from '#contracts/PetWorld.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

export function PetProfileEditor({
  profile,
  isSaving,
  t,
  sendCommand,
}: {
  profile: PetWorldProfile;
  isSaving: boolean;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
}): ReactElement {
  const [petId, setPetId] = useState<PetId>(profile.activePetId);
  const [name, setName] = useState(profile.names[profile.activePetId]);
  return (
    <Group align="end" grow>
      <Select
        label={t('Your companion', 'Bạn đồng hành')}
        data={[
          { value: PetId.CAT, label: t('Cat', 'Mèo') },
          { value: PetId.FOX, label: t('Fox', 'Cáo') },
        ]}
        value={petId}
        disabled={isSaving}
        onChange={(value) => {
          const next = Object.values(PetId).find((candidate) => candidate === value);
          if (next) {
            setPetId(next);
            setName(profile.names[next]);
          }
        }}
      />
      <TextInput
        label={t('Pet name', 'Tên thú cưng')}
        value={name}
        maxLength={40}
        disabled={isSaving}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <Button
        variant="default"
        disabled={
          isSaving ||
          !name.trim() ||
          (petId === profile.activePetId && name.trim() === profile.names[petId])
        }
        onClick={() => {
          void sendCommand({
            kind: PetWorldCommandKind.SET_PET_PROFILE,
            requestId: crypto.randomUUID(),
            activePetId: petId,
            name: name.trim(),
            expectedWorldRevision: profile.revision,
          });
        }}
      >
        {t('Save companion', 'Lưu bạn đồng hành')}
      </Button>
    </Group>
  );
}
