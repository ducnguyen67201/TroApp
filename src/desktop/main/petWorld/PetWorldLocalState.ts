import { z } from 'zod';
import { PetBackdropId, PetId } from '#contracts/Pet.js';
import {
  PetNamesSchema,
  PetWorldCommandSchema,
  isPetWorldMutationCommand,
} from '#contracts/PetWorld.js';

/** Only confirmed cosmetics and unresolved online intents are cached locally. */
export const PetWorldLocalStateSchema = z.strictObject({
  version: z.literal(1),
  appearance: z
    .strictObject({
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      activePetId: z.enum(PetId),
      names: PetNamesSchema,
      backdropId: z.enum(PetBackdropId).nullable(),
    })
    .nullable(),
  pending: z.array(PetWorldCommandSchema.refine(isPetWorldMutationCommand)).max(30),
});

export type PetWorldLocalState = z.infer<typeof PetWorldLocalStateSchema>;

export interface PetWorldLocalStore {
  readState(accountId: string): Promise<PetWorldLocalState>;
  saveState(accountId: string, state: PetWorldLocalState): Promise<void>;
}

export function createPetWorldLocalState(): PetWorldLocalState {
  return { version: 1, appearance: null, pending: [] };
}
