import { z } from 'zod';
import { DesktopLocale, DesktopLocaleSchema } from './DesktopLocale.js';

export const PetId = { CAT: 'cat', FOX: 'fox' } as const;

export type PetId = (typeof PetId)[keyof typeof PetId];

export const PetReaction = { IDLE: 'idle', HAPPY: 'happy', STARTLED: 'startled' } as const;

export type PetReaction = (typeof PetReaction)[keyof typeof PetReaction];

export const PetMotion = { SYSTEM: 'system', REDUCED: 'reduced' } as const;

export const PetAction = {
  ADOPT: 'adopt',
  PREFERENCES: 'preferences',
  REACT: 'react',
  HIDE: 'hide',
} as const;

export const PetOverlayAction = {
  HOVER: 'hover',
  PET: 'pet',
  SLAP: 'slap',
  START_DRAG: 'start-drag',
  END_DRAG: 'end-drag',
} as const;

export const PetFailure = {
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
  SAVE: 'save',
} as const;

export const PetGeometry = {
  WIDTH: 144,
  HEIGHT: 160,
  CENTER_X: 72,
  CENTER_Y: 100,
  HIT_RADIUS: 48,
} as const;

export const PetPlacementSchema = z.strictObject({
  displayId: z.number().int(),
  horizontalRatio: z.number().min(0).max(1),
  verticalRatio: z.number().min(0).max(1),
});

export type PetPlacement = z.infer<typeof PetPlacementSchema>;

const PetNameSchema = z.string().trim().min(1).max(40);
export const PetPreferencesSchema = z.strictObject({
  version: z.literal(2),
  enabled: z.boolean(),
  activePetId: z.enum(PetId),
  names: z.strictObject({ cat: PetNameSchema, fox: PetNameSchema }),
  quiet: z.boolean(),
  locale: DesktopLocaleSchema,
  motion: z.enum(PetMotion),
  placement: PetPlacementSchema.nullable(),
});

export type PetPreferences = z.infer<typeof PetPreferencesSchema>;

export function createPetPreferences(): PetPreferences {
  return {
    version: 2,
    enabled: false,
    activePetId: PetId.CAT,
    names: { cat: 'Mochi', fox: 'Maple' },
    quiet: false,
    locale: DesktopLocale.VIETNAMESE,
    motion: PetMotion.SYSTEM,
    placement: null,
  };
}

export const PetSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  preferences: PetPreferencesSchema,
  reaction: z.enum(PetReaction),
  isVisible: z.boolean(),
  hasPresentationError: z.boolean(),
  encouragement: z.boolean(),
});

export type PetSnapshot = z.infer<typeof PetSnapshotSchema>;

export const PetCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(PetAction.ADOPT),
    petId: z.enum(PetId),
    name: PetNameSchema,
    locale: DesktopLocaleSchema,
  }),
  z.strictObject({
    kind: z.literal(PetAction.PREFERENCES),
    quiet: z.boolean(),
    motion: z.enum(PetMotion),
    locale: DesktopLocaleSchema,
  }),
  z.strictObject({ kind: z.literal(PetAction.REACT), reaction: z.enum(PetReaction) }),
  z.strictObject({ kind: z.literal(PetAction.HIDE) }),
]);

export type PetCommand = z.infer<typeof PetCommandSchema>;

export const PetOverlayCommandSchema = z.strictObject({ kind: z.enum(PetOverlayAction) });

export type PetOverlayCommand = z.infer<typeof PetOverlayCommandSchema>;

export const PetReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), snapshot: PetSnapshotSchema }),
  z.strictObject({ kind: z.literal('failed'), reason: z.enum(PetFailure) }),
]);

export type PetReply = z.infer<typeof PetReplySchema>;

/** The overlay receives only its presentation state and bounded local interactions. */
export interface PetOverlayBridge {
  readPet(): Promise<PetSnapshot>;
  subscribePet(listener: (snapshot: PetSnapshot) => void): () => void;
  interactWithPet(command: PetOverlayCommand): void;
}
