import type { ReactElement } from 'react';
import { Badge, Group, Select, Stack, Text } from '@mantine/core';
import {
  PetEquipmentSlot,
  PetHomeSlot,
  PetItemCategory,
  PetWorldCommandKind,
  type PetCatalog,
  type PetOwnWorld,
  type PetWorldCommand,
} from '#contracts/PetWorld.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

export function InventoryEditor({
  world,
  catalog,
  isSaving,
  t,
  sendCommand,
}: {
  world: PetOwnWorld;
  catalog: PetCatalog;
  isSaving: boolean;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
}): ReactElement {
  const profile = world.profile;
  if (!profile) {
    return <></>;
  }
  const ownedIds = new Set(world.inventory.map((item) => item.itemId));
  const ownedItems = catalog.items.filter(
    (item) => ownedIds.has(item.id) && item.petIds.includes(profile.activePetId),
  );
  const changeEquipment = (slot: PetEquipmentSlot, itemId: string | null): void => {
    void sendCommand({
      kind: PetWorldCommandKind.EQUIP_ITEM,
      requestId: crypto.randomUUID(),
      expectedWorldRevision: profile.revision,
      slot,
      itemId,
    });
  };
  return (
    <section
      className="pet-world-panel pet-world-section"
      aria-label={t('Your inventory', 'Vật phẩm của bạn')}
    >
      <Group justify="space-between" mb="md">
        <h2>{t('Make yourself at home.', 'Trang trí mái ấm của bạn.')}</h2>
        <Badge variant="light">
          {world.inventory.length} {t('owned', 'đã sở hữu')}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        {t(
          'Move or put away anything you own. Your items stay yours.',
          'Đặt hoặc cất vật phẩm đã sở hữu. Chúng luôn thuộc về bạn.',
        )}
      </Text>
      <Stack gap="md">
        <Select
          label={t('Pet backdrop', 'Phông nền thú cưng')}
          placeholder={t('Default scenery', 'Khung cảnh mặc định')}
          clearable
          data={ownedItems
            .filter((item) => item.category === PetItemCategory.BACKDROP)
            .map((item) => ({ value: item.id, label: item.name }))}
          value={profile.backdropItemId}
          disabled={isSaving}
          onChange={(itemId) => {
            changeEquipment(PetEquipmentSlot.BACKDROP, itemId);
          }}
        />
        {ownedItems.some((item) => item.category === PetItemCategory.OUTFIT) && (
          <Select
            label={t('Pet outfit', 'Trang phục thú cưng')}
            clearable
            data={ownedItems
              .filter((item) => item.category === PetItemCategory.OUTFIT)
              .map((item) => ({ value: item.id, label: item.name }))}
            value={profile.outfitItemId}
            disabled={isSaving}
            onChange={(itemId) => {
              changeEquipment(PetEquipmentSlot.OUTFIT, itemId);
            }}
          />
        )}
        {Object.values(PetHomeSlot).map((slot) => (
          <Select
            key={slot}
            label={
              slot === PetHomeSlot.GARDEN
                ? t('Garden corner', 'Góc vườn')
                : slot === PetHomeSlot.HOME
                  ? t('Home corner', 'Góc nhà')
                  : t('Special feature', 'Điểm nhấn')
            }
            placeholder={t('Leave this spot open', 'Để trống vị trí này')}
            clearable
            data={ownedItems
              .filter((item) => item.slot === slot)
              .map((item) => ({ value: item.id, label: item.name }))}
            value={profile.slots[slot]}
            disabled={isSaving}
            onChange={(itemId) => {
              void sendCommand({
                kind: PetWorldCommandKind.PLACE_ITEM,
                requestId: crypto.randomUUID(),
                expectedWorldRevision: profile.revision,
                slot,
                itemId,
              });
            }}
          />
        ))}
      </Stack>
      {!world.inventory.length && (
        <Text size="sm" c="dimmed" mt="md">
          {t(
            'Your first little treasure will live here.',
            'Món đồ đầu tiên của bạn sẽ xuất hiện ở đây.',
          )}
        </Text>
      )}
    </section>
  );
}
