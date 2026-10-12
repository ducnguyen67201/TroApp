import type { ReactElement } from 'react';
import { PetBackdropId } from '#contracts/Pet.js';
import { PetHomeSlot, type PetCatalog, type PetWorldProfile } from '#contracts/PetWorld.js';
import { PetMascot } from '../pets/PetMascot.js';
import { PetHomeLandscape } from './PetHomeLandscape.js';
import { PetItemArtwork } from './PetItemArtwork.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

interface PetHomeSceneProps {
  profile: PetWorldProfile;
  catalog: PetCatalog | null;
  ownerName: string;
  t: PetWorldTranslate;
}

/** The same cosmetic projection renders an owner's home and an explicitly shared visit. */
export function PetHomeScene({ profile, catalog, ownerName, t }: PetHomeSceneProps): ReactElement {
  const backdrop = catalog?.items.find((item) => item.id === profile.backdropItemId)?.assetId;
  const backdropId = Object.values(PetBackdropId).find((value) => value === backdrop) ?? null;
  const petName = profile.names[profile.activePetId];
  return (
    <div
      className="pet-home-scene"
      data-backdrop={backdropId}
      role="region"
      aria-label={t(`${ownerName}'s home`, `Nhà của ${ownerName}`)}
    >
      <PetHomeLandscape backdropId={backdropId} />
      <div className="pet-home-heading">
        <h2>{t(`${petName}'s little world`, `Thế giới nhỏ của ${petName}`)}</h2>
        <span>{t('Good memories make a home.', 'Những kỷ niệm đẹp làm nên mái ấm.')}</span>
      </div>
      <div className="pet-home-pet">
        <PetMascot petId={profile.activePetId} label={petName} reducedMotion={false} />
      </div>
      {Object.values(PetHomeSlot).map((slot) => {
        const item = catalog?.items.find((candidate) => candidate.id === profile.slots[slot]);
        return item ? (
          <div
            className="pet-home-decoration"
            key={slot}
            data-slot={slot}
            role="img"
            aria-label={item.name}
          >
            <PetItemArtwork item={item} />
          </div>
        ) : null;
      })}
    </div>
  );
}
