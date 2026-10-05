import type { ReactElement } from 'react';
import { PetMotion, PetReaction, type PetId } from '#contracts/Pet.js';
import { petCatalog } from './PetAssets.js';
import './Pet.css';

interface PetSpriteProps {
  petId: PetId;
  reaction?: PetReaction;
  reducedMotion?: boolean;
}

/** Preview and overlay share the same assets and animation behavior. */
export function PetSprite({
  petId,
  reaction = PetReaction.IDLE,
  reducedMotion = false,
}: PetSpriteProps): ReactElement {
  return (
    <img
      className="pet-sprite"
      data-pet-id={petId}
      data-reaction={reaction}
      data-motion={reducedMotion ? PetMotion.REDUCED : PetMotion.SYSTEM}
      src={petCatalog[petId].imageUrl}
      width={96}
      height={96}
      alt=""
      draggable={false}
    />
  );
}
