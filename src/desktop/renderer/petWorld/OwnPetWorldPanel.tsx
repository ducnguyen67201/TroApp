import type { ReactElement } from 'react';
import { Text } from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type {
  PetCatalog,
  PetOwnWorld,
  PetWorldCommand,
  PetWorldReply,
} from '#contracts/PetWorld.js';
import { PetHomeScene } from './PetHomeScene.js';
import { PetProfileEditor } from './PetProfileEditor.js';
import { InventoryEditor } from './InventoryEditor.js';
import { PetShop } from './PetShop.js';
import { PetWorldHistory } from './PetWorldHistory.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

interface OwnPetWorldPanelProps {
  userName: string;
  world: PetOwnWorld;
  catalog: PetCatalog | null;
  history: Extract<PetWorldReply, { kind: 'history' }> | null;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
  readOlderHistory: () => Promise<void>;
}

/** Composes home appearance, profile, shopping, inventory and private history. */
export function OwnPetWorldPanel({
  userName,
  world,
  catalog,
  history,
  isSaving,
  locale,
  t,
  sendCommand,
  readOlderHistory,
}: OwnPetWorldPanelProps): ReactElement {
  const profile = world.profile;
  if (!profile) {
    return (
      <Text className="pet-world-empty">
        {t(
          'Preparing your companion’s home. Refresh to try again.',
          'Đang chuẩn bị nhà cho bạn đồng hành. Cập nhật để thử lại.',
        )}
      </Text>
    );
  }
  return (
    <div className="pet-world-layout">
      <div>
        <section className="pet-home-card">
          <PetHomeScene profile={profile} catalog={catalog} ownerName={userName} t={t} />
          <div className="pet-home-footer">
            <PetProfileEditor
              key={profile.revision}
              profile={profile}
              isSaving={isSaving}
              t={t}
              sendCommand={sendCommand}
            />
          </div>
        </section>
        {catalog && (
          <>
            <PetShop
              world={world}
              catalog={catalog}
              isSaving={isSaving}
              locale={locale}
              t={t}
              sendCommand={sendCommand}
            />
            <InventoryEditor
              world={world}
              catalog={catalog}
              isSaving={isSaving}
              t={t}
              sendCommand={sendCommand}
            />
          </>
        )}
      </div>
      <div>
        <PetWorldHistory
          world={world}
          history={history}
          isSaving={isSaving}
          locale={locale}
          t={t}
          readOlderHistory={readOlderHistory}
        />
      </div>
    </div>
  );
}
