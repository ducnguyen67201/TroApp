import { z } from 'zod';
import { PetId } from './Pet.js';

export const PetWorldCommandKind = {
  OWN_WORLD: 'own-world',
  OWN_HISTORY: 'own-history',
  CATALOG: 'catalog',
  GRANT_POINTS: 'grant-points',
  BUY_ITEM: 'buy-item',
  INITIALIZE_WORLD: 'initialize-world',
  SET_PET_PROFILE: 'set-pet-profile',
  EQUIP_ITEM: 'equip-item',
  PLACE_ITEM: 'place-item',
  REVERSE_GRANT: 'reverse-grant',
  VOID_RECOGNITION: 'void-recognition',
  SET_HOME_SHARING: 'set-home-sharing',
  CLASS_RECOGNITION: 'class-recognition',
  CLASS_NEIGHBORHOOD: 'class-neighborhood',
  VISIT_HOME: 'visit-home',
  COMMAND_RESULT: 'command-result',
} as const;

export const PetWorldFailure = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INVALID: 'invalid',
  REQUEST_CONFLICT: 'request_conflict',
  STALE: 'stale',
  STALE_CATALOG: 'stale_catalog',
  INSUFFICIENT_POINTS: 'insufficient_points',
  ALREADY_OWNED: 'already_owned',
  INCOMPATIBLE_ITEM: 'incompatible_item',
  HOME_UNAVAILABLE: 'home_unavailable',
  REVERSAL_UNAVAILABLE: 'reversal_unavailable',
  INITIALIZATION_REQUIRED: 'initialization_required',
  UNAVAILABLE: 'unavailable',
} as const;

export type PetWorldFailure = (typeof PetWorldFailure)[keyof typeof PetWorldFailure];

export const PetRecognitionCategory = {
  CURIOSITY: 'curiosity',
  PERSISTENCE: 'persistence',
  EXPLANATION: 'explanation',
  CONTRIBUTION: 'contribution',
  OTHER: 'other',
} as const;

export type PetRecognitionCategory =
  (typeof PetRecognitionCategory)[keyof typeof PetRecognitionCategory];

export const PetItemCategory = {
  BACKDROP: 'backdrop',
  OUTFIT: 'outfit',
  GARDEN: 'garden',
  HOME: 'home',
} as const;

export type PetItemCategory = (typeof PetItemCategory)[keyof typeof PetItemCategory];

export const PetHomeSlot = { GARDEN: 'garden', HOME: 'home', FEATURE: 'feature' } as const;

export type PetHomeSlot = (typeof PetHomeSlot)[keyof typeof PetHomeSlot];

export const PetEquipmentSlot = { BACKDROP: 'backdrop', OUTFIT: 'outfit' } as const;

export type PetEquipmentSlot = (typeof PetEquipmentSlot)[keyof typeof PetEquipmentSlot];

export const PetWalletEntryKind = {
  TEACHER_GRANT: 'teacher_grant',
  PURCHASE: 'purchase',
  GRANT_REVERSAL: 'grant_reversal',
} as const;

export type PetWalletEntryKind = (typeof PetWalletEntryKind)[keyof typeof PetWalletEntryKind];

export const PetCorrectionKind = { REVERSED: 'reversed', VOIDED: 'voided' } as const;

export type PetCorrectionKind = (typeof PetCorrectionKind)[keyof typeof PetCorrectionKind];

export const PetWorldLimits = {
  RECIPIENTS: 100,
  NOTE_LENGTH: 500,
  HISTORY_PAGE: 50,
  CLASS_PAGE: 100,
  MAX_POINTS: '9223372036854775807',
} as const;

export const PetWorldTiming = { REFRESH_MS: 15_000 } as const;

export const PetWorldAssetId = {
  MEADOW: 'meadow',
  READING_NOOK: 'reading-nook',
  STARRY_SKY: 'starry-sky',
  LITTLE_FERN: 'little-fern',
  READING_LANTERN: 'reading-lantern',
  COZY_NOOK: 'cozy-nook',
} as const;

export type PetWorldAssetId = (typeof PetWorldAssetId)[keyof typeof PetWorldAssetId];
const SupportedAssetsSchema = z.array(z.enum(PetWorldAssetId)).max(6);

const accountId = z.string().min(1).max(200);
const itemId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
const name = z.string().trim().min(1).max(40);
const requestFields = { requestId: z.uuid() };
const worldRevisionFields = { ...requestFields, expectedWorldRevision: revision };
const pointText = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) =>
      value.length < PetWorldLimits.MAX_POINTS.length ||
      (value.length === PetWorldLimits.MAX_POINTS.length && value <= PetWorldLimits.MAX_POINTS),
  );
export const PetPointBalanceSchema = pointText;

export const PetPointAmountSchema = pointText.refine((value) => value !== '0');

export const PetNamesSchema = z.strictObject({ cat: name, fox: name });

export const PetHomeSlotsSchema = z.strictObject({
  garden: itemId.nullable(),
  home: itemId.nullable(),
  feature: itemId.nullable(),
});

export const PetWorldProfileSchema = z.strictObject({
  activePetId: z.enum(PetId),
  names: PetNamesSchema,
  slots: PetHomeSlotsSchema,
  backdropItemId: itemId.nullable(),
  outfitItemId: itemId.nullable(),
  revision,
});

export type PetWorldProfile = z.infer<typeof PetWorldProfileSchema>;

export const PetWalletViewSchema = z.strictObject({ balance: PetPointBalanceSchema, revision });

export const PetInventoryItemSchema = z.strictObject({
  itemId,
  purchaseId: z.uuid(),
  acquiredAt: timestamp,
});

export type PetInventoryItem = z.infer<typeof PetInventoryItemSchema>;

export const PetHomeShareSchema = z.strictObject({
  classId: z.uuid(),
  enabled: z.boolean(),
  revision,
});

export type PetHomeShare = z.infer<typeof PetHomeShareSchema>;

export const PetWalletEntrySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(PetWalletEntryKind),
  delta: z.string().regex(/^-?[1-9]\d{0,18}$/),
  sourceId: z.uuid(),
  createdAt: timestamp,
});

export const PetRecognitionCorrectionSchema = z.strictObject({
  kind: z.enum(PetCorrectionKind),
  reason: z.string().trim().min(1).max(500),
  createdAt: timestamp,
});

export const PetRecognitionSchema = z.strictObject({
  id: z.uuid(),
  classId: z.uuid(),
  teacherId: accountId,
  studentId: accountId,
  batchId: z.uuid(),
  points: PetPointAmountSchema,
  category: z.enum(PetRecognitionCategory),
  note: z.string().max(500),
  classSessionId: z.uuid().nullable(),
  activityId: z.uuid().nullable(),
  createdAt: timestamp,
  correction: PetRecognitionCorrectionSchema.nullable(),
});

export type PetRecognition = z.infer<typeof PetRecognitionSchema>;

export const PetOwnWorldSchema = z.strictObject({
  studentId: accountId,
  wallet: PetWalletViewSchema,
  profile: PetWorldProfileSchema.nullable(),
  inventory: z.array(PetInventoryItemSchema).max(200),
  entries: z.array(PetWalletEntrySchema).max(50),
  recognitions: z.array(PetRecognitionSchema).max(50),
  shares: z.array(PetHomeShareSchema).max(1000),
});

export type PetOwnWorld = z.infer<typeof PetOwnWorldSchema>;

export const PetCatalogItemSchema = z.strictObject({
  id: itemId,
  name: z.string().min(1).max(80),
  description: z.string().max(300),
  category: z.enum(PetItemCategory),
  price: PetPointAmountSchema,
  slot: z.enum(PetHomeSlot).nullable(),
  petIds: z.array(z.enum(PetId)).min(1).max(2),
  assetId: z.enum(PetWorldAssetId),
  available: z.boolean(),
});

export type PetCatalogItem = z.infer<typeof PetCatalogItemSchema>;

export const PetCatalogSchema = z.strictObject({
  revision: z.string().min(1).max(80),
  items: z.array(PetCatalogItemSchema).max(200),
});

export type PetCatalog = z.infer<typeof PetCatalogSchema>;

export const PetSharedHomeSchema = z.strictObject({
  studentId: accountId,
  displayName: name,
  profile: PetWorldProfileSchema,
});

export type PetSharedHome = z.infer<typeof PetSharedHomeSchema>;

export const PetRecognitionCoverageSchema = z.strictObject({
  eligibleStudents: z.number().int().nonnegative(),
  recognizedStudents: z.number().int().nonnegative(),
  recognizedStudentIds: z.array(accountId),
  classroomMoments: z.number().int().nonnegative(),
  gardenMilestone: z.number().int().nonnegative(),
});

export type PetRecognitionCoverage = z.infer<typeof PetRecognitionCoverageSchema>;

export const PetGardenSchema = z.strictObject({
  classroomMoments: z.number().int().nonnegative(),
  gardenMilestone: z.number().int().nonnegative(),
});

export type PetGarden = z.infer<typeof PetGardenSchema>;

export const PetWorldCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(PetWorldCommandKind.OWN_WORLD) }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.OWN_HISTORY),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.CATALOG),
    supportedAssetIds: SupportedAssetsSchema.optional(),
  }),
  z.strictObject({ kind: z.literal(PetWorldCommandKind.COMMAND_RESULT), requestId: z.uuid() }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.GRANT_POINTS),
    ...requestFields,
    classId: z.uuid(),
    studentIds: z
      .array(accountId)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    pointsPerStudent: PetPointAmountSchema,
    category: z.enum(PetRecognitionCategory),
    note: z.string().trim().max(500).optional(),
    classSessionId: z.uuid().optional(),
    activityId: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.INITIALIZE_WORLD),
    ...requestFields,
    activePetId: z.enum(PetId),
    names: PetNamesSchema,
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.SET_PET_PROFILE),
    ...worldRevisionFields,
    activePetId: z.enum(PetId),
    name,
  }),
  z
    .strictObject({
      kind: z.literal(PetWorldCommandKind.BUY_ITEM),
      ...requestFields,
      itemId,
      catalogRevision: z.string().min(1).max(80),
      displayedPrice: PetPointAmountSchema,
      equipAfterPurchase: z.boolean(),
      expectedWorldRevision: revision.optional(),
      supportedAssetIds: SupportedAssetsSchema.optional(),
    })
    .refine((value) => !value.equipAfterPurchase || value.expectedWorldRevision !== undefined),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.EQUIP_ITEM),
    ...worldRevisionFields,
    slot: z.enum(PetEquipmentSlot),
    itemId: itemId.nullable(),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.PLACE_ITEM),
    ...worldRevisionFields,
    slot: z.enum(PetHomeSlot),
    itemId: itemId.nullable(),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.REVERSE_GRANT),
    ...requestFields,
    recognitionId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.VOID_RECOGNITION),
    ...requestFields,
    recognitionId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.SET_HOME_SHARING),
    ...requestFields,
    classId: z.uuid(),
    enabled: z.boolean(),
    expectedShareRevision: revision,
  }),
  z
    .strictObject({
      kind: z.literal(PetWorldCommandKind.CLASS_RECOGNITION),
      classId: z.uuid(),
      from: timestamp,
      to: timestamp,
      cursor: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .refine((value) => Date.parse(value.from) < Date.parse(value.to)),
  z.strictObject({ kind: z.literal(PetWorldCommandKind.CLASS_NEIGHBORHOOD), classId: z.uuid() }),
  z.strictObject({
    kind: z.literal(PetWorldCommandKind.VISIT_HOME),
    classId: z.uuid(),
    studentId: accountId,
  }),
]);

export type PetWorldCommand = z.infer<typeof PetWorldCommandSchema>;

export type PetWorldMutationCommand = Exclude<
  Extract<PetWorldCommand, { requestId: string }>,
  { kind: typeof PetWorldCommandKind.COMMAND_RESULT }
>;

export function isPetWorldMutationCommand(
  command: PetWorldCommand,
): command is PetWorldMutationCommand {
  return 'requestId' in command && command.kind !== PetWorldCommandKind.COMMAND_RESULT;
}

export const PetWorldMutationReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ok'),
    requestId: z.uuid(),
    walletRevision: revision.nullable(),
    worldRevision: revision.nullable(),
  }),
  z.strictObject({
    kind: z.literal('granted'),
    requestId: z.uuid(),
    batchId: z.uuid(),
    createdAt: timestamp,
    recognitions: z
      .array(z.strictObject({ id: z.uuid(), studentId: accountId, points: PetPointAmountSchema }))
      .min(1)
      .max(100),
  }),
  z.strictObject({
    kind: z.literal('corrected'),
    requestId: z.uuid(),
    recognitionId: z.uuid(),
    correction: z.strictObject({ kind: z.enum(PetCorrectionKind), createdAt: timestamp }),
  }),
  z.strictObject({ kind: z.literal('shared'), requestId: z.uuid(), share: PetHomeShareSchema }),
]);

export type PetWorldMutationReply = z.infer<typeof PetWorldMutationReplySchema>;

export const PetWorldReplySchema = z.discriminatedUnion('kind', [
  ...PetWorldMutationReplySchema.options,
  z.strictObject({ kind: z.literal('world'), world: PetOwnWorldSchema }),
  z.strictObject({
    kind: z.literal('history'),
    walletRevision: revision,
    entries: z.array(PetWalletEntrySchema).max(50),
    recognitions: z.array(PetRecognitionSchema).max(50),
    nextCursor: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal('catalog'), catalog: PetCatalogSchema }),
  z.strictObject({
    kind: z.literal('class-recognition'),
    classId: z.uuid(),
    from: timestamp,
    to: timestamp,
    roster: z.array(z.strictObject({ studentId: accountId, displayName: z.string().max(200) })),
    recognitions: z.array(PetRecognitionSchema).max(100),
    coverage: PetRecognitionCoverageSchema,
    nextCursor: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal('neighborhood'),
    classId: z.uuid(),
    homes: z.array(PetSharedHomeSchema).max(1000),
    garden: PetGardenSchema,
  }),
  z.strictObject({ kind: z.literal('home'), home: PetSharedHomeSchema }),
  z.strictObject({
    kind: z.literal('command-result'),
    result: PetWorldMutationReplySchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(PetWorldFailure) }),
]);

export type PetWorldReply = z.infer<typeof PetWorldReplySchema>;
