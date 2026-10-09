import { PageMascotRenderer } from './PageMascotRenderer.js';
import type { PetRenderer } from './PetRenderer.js';

/** Select the shared pet provider here; gallery and overlay consume the same contract. */
export const petRenderer: PetRenderer = new PageMascotRenderer();
