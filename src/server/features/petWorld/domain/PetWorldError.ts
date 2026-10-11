import type { PetWorldFailure } from '#contracts/PetWorld.js';

/** Safe domain failure; HTTP and desktop boundaries never expose database details. */
export class PetWorldError extends Error {
  constructor(readonly code: PetWorldFailure) {
    super(code);
    this.name = 'PetWorldError';
  }
}
