import type { ReactElement } from 'react';
import { PetMotion, PetReaction, PetId } from '#contracts/Pet.js';
import { petCatalog } from './PetAssets.js';
import './Pet.css';

interface PetSpriteProps {
  reaction?: PetReaction;
  reducedMotion?: boolean;
}

/** Legacy slime presentation, shared by preview and overlay. */
export function PetSprite({
  reaction = PetReaction.IDLE,
  reducedMotion = false,
}: PetSpriteProps): ReactElement {
  return (
    <img
      className="pet-sprite"
      data-pet-id={PetId.SLIME}
      data-reaction={reaction}
      data-motion={reducedMotion ? PetMotion.REDUCED : PetMotion.SYSTEM}
      src={petCatalog[PetId.SLIME].imageUrl}
      width={96}
      height={96}
      alt=""
      draggable={false}
    />
  );
}
