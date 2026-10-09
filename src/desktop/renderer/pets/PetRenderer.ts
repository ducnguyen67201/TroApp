import type { ReactElement } from 'react';
import type { PetId } from '#contracts/Pet.js';

/** Provider-independent presentation input. Motion already includes the OS preference. */
export interface PetRenderOptions {
  petId: PetId;
  label: string;
  reducedMotion: boolean;
}

/** Renderers return React elements; component lifecycle and hooks stay in components. */
export interface PetRenderer {
  renderPet(options: PetRenderOptions): ReactElement;
}
