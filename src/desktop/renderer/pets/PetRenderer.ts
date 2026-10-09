import type { ReactElement } from 'react';
import type { PetId, PetReaction } from '#contracts/Pet.js';

/** Provider-independent presentation input. Motion already includes the OS preference. */
export interface PetRenderOptions {
  petId: PetId;
  label: string;
  reaction?: PetReaction;
  reducedMotion: boolean;
  onPet?: () => void;
  onSlap?: () => void;
}

/** Renderers return React elements; component lifecycle and hooks stay in components. */
export interface PetRenderer {
  renderPet(options: PetRenderOptions): ReactElement;
  supportsControlledReactions(petId: PetId): boolean;
}
