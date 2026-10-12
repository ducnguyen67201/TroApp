import { useState, type ReactElement } from 'react';
import { Button, Checkbox, Group, Modal, Select, Stack, Text } from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  PetItemCategory,
  PetWorldCommandKind,
  type PetCatalog,
  type PetCatalogItem,
  type PetOwnWorld,
  type PetWorldCommand,
} from '#contracts/PetWorld.js';
import { PetItemArtwork } from './PetItemArtwork.js';
import { formatPoints, type PetWorldTranslate } from './PetWorldLabels.js';

interface PetShopProps {
  world: PetOwnWorld;
  catalog: PetCatalog;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
}

const ShopFilter = { ALL: 'all', ...PetItemCategory } as const;
type ShopFilter = (typeof ShopFilter)[keyof typeof ShopFilter];

function describeItemCategory(category: PetItemCategory, t: PetWorldTranslate): string {
  switch (category) {
    case PetItemCategory.BACKDROP:
      return t('Backdrops', 'Phông nền');
    case PetItemCategory.OUTFIT:
      return t('Style', 'Trang phục');
    case PetItemCategory.GARDEN:
      return t('Garden', 'Khu vườn');
    case PetItemCategory.HOME:
      return t('Home', 'Ngôi nhà');
  }
}

/** Purchases require an explicit review of the displayed item and price. */
export function PetShop({
  world,
  catalog,
  isSaving,
  locale,
  t,
  sendCommand,
}: PetShopProps): ReactElement {
  const [filter, setFilter] = useState<ShopFilter>(ShopFilter.ALL);
  const [purchase, setPurchase] = useState<PetCatalogItem | null>(null);
  const [equipAfterPurchase, setEquipAfterPurchase] = useState(true);
  const profile = world.profile;
  const ownedIds = new Set(world.inventory.map((item) => item.itemId));
  if (!profile) {
    return <></>;
  }
  const items = catalog.items.filter(
    (item) => item.available && (filter === ShopFilter.ALL || item.category === filter),
  );
  return (
    <>
      <section className="pet-world-section" aria-label={t('Pet shop', 'Cửa hàng thú cưng')}>
        <Group justify="space-between" mb="md">
          <h2>
            {t('A little something for your world.', 'Thêm một chút vui cho thế giới của bạn.')}
          </h2>
          <Select
            aria-label={t('Shop category', 'Loại vật phẩm')}
            value={filter}
            data={[
              { value: ShopFilter.ALL, label: t('All items', 'Tất cả') },
              ...Object.values(PetItemCategory).map((category) => ({
                value: category,
                label: describeItemCategory(category, t),
              })),
            ]}
            onChange={(value) => {
              const selected = Object.values(ShopFilter).find((candidate) => candidate === value);
              if (selected) {
                setFilter(selected);
              }
            }}
            w={160}
          />
        </Group>
        <div className="pet-world-items">
          {items.map((item) => {
            const owned = ownedIds.has(item.id);
            const compatible = item.petIds.includes(profile.activePetId);
            const affordable = BigInt(item.price) <= BigInt(world.wallet.balance);
            return (
              <article className="pet-world-item" key={item.id}>
                <div className="pet-world-item-art" data-category={item.category}>
                  <PetItemArtwork item={item} />
                </div>
                <div className="pet-world-item-copy">
                  <Text size="sm" fw={650}>
                    {item.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {item.description}
                  </Text>
                  <Button
                    variant={owned ? 'subtle' : 'default'}
                    size="xs"
                    disabled={isSaving || owned || !compatible || !affordable}
                    onClick={() => {
                      setEquipAfterPurchase(true);
                      setPurchase(item);
                    }}
                  >
                    {owned
                      ? t('Yours', 'Đã sở hữu')
                      : !compatible
                        ? t('For another companion', 'Dành cho thú cưng khác')
                        : `${formatPoints(item.price, locale)} ${t('Points', 'điểm')}`}
                  </Button>
                  {!owned && compatible && !affordable && (
                    <Text size="xs" c="dimmed" mt={6}>
                      {t(
                        `Save ${formatPoints((BigInt(item.price) - BigInt(world.wallet.balance)).toString(), locale)} more`,
                        `Cần thêm ${formatPoints((BigInt(item.price) - BigInt(world.wallet.balance)).toString(), locale)} điểm`,
                      )}
                    </Text>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {!items.length && (
          <Text className="pet-world-empty">
            {t('No items in this collection yet.', 'Chưa có vật phẩm trong bộ sưu tập này.')}
          </Text>
        )}
      </section>
      <Modal
        opened={purchase !== null}
        onClose={() => {
          setPurchase(null);
        }}
        title={t('Bring it home?', 'Mang về nhà nhé?')}
      >
        {purchase && (
          <Stack>
            <Text fw={600}>{purchase.name}</Text>
            <Text size="sm">{purchase.description}</Text>
            <Text>
              {formatPoints(purchase.price, locale)} {t('Points', 'điểm')}
            </Text>
            <Text size="sm" c="dimmed">
              {t(
                'This item will belong to you. You can put it away and use it again anytime.',
                'Vật phẩm này sẽ thuộc về bạn. Bạn có thể cất đi và sử dụng lại bất cứ lúc nào.',
              )}
            </Text>
            {(purchase.category === PetItemCategory.BACKDROP ||
              purchase.category === PetItemCategory.OUTFIT) && (
              <Checkbox
                label={t('Use on my companion now', 'Dùng ngay cho bạn đồng hành')}
                checked={equipAfterPurchase}
                onChange={(event) => {
                  setEquipAfterPurchase(event.currentTarget.checked);
                }}
                disabled={isSaving}
              />
            )}
            <Button
              disabled={isSaving}
              onClick={() => {
                void sendCommand({
                  kind: PetWorldCommandKind.BUY_ITEM,
                  requestId: crypto.randomUUID(),
                  itemId: purchase.id,
                  catalogRevision: catalog.revision,
                  displayedPrice: purchase.price,
                  equipAfterPurchase:
                    (purchase.category === PetItemCategory.BACKDROP ||
                      purchase.category === PetItemCategory.OUTFIT) &&
                    equipAfterPurchase,
                  expectedWorldRevision: profile.revision,
                }).then((saved) => {
                  if (saved) {
                    setPurchase(null);
                  }
                });
              }}
            >
              {t('Buy with my points', 'Mua bằng điểm của mình')}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  );
}
