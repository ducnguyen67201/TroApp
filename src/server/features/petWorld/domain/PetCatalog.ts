import { PetId } from '#contracts/Pet.js';
import {
  PetItemCategory,
  PetHomeSlot,
  PetWorldFailure,
  type PetCatalog,
  type PetCatalogItem,
} from '#contracts/PetWorld.js';
import { PetWorldError } from './PetWorldError.js';

/** Stable bundled catalog. Delisting must preserve an existing owner's entitlement. */
export const petCatalog: PetCatalog = {
  revision: '2026-10-11.1',
  items: [
    {
      id: 'meadow',
      name: 'Sunny meadow',
      description: 'A little sunshine behind your companion.',
      category: PetItemCategory.BACKDROP,
      price: '20',
      slot: null,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'meadow',
      available: true,
    },
    {
      id: 'reading-nook',
      name: 'Reading nook',
      description: 'A quiet corner for big ideas.',
      category: PetItemCategory.BACKDROP,
      price: '35',
      slot: null,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'reading-nook',
      available: true,
    },
    {
      id: 'starry-sky',
      name: 'Starry sky',
      description: 'A sky full of possibilities.',
      category: PetItemCategory.BACKDROP,
      price: '50',
      slot: null,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'starry-sky',
      available: true,
    },
    {
      id: 'little-fern',
      name: 'Little fern',
      description: 'A green friend for your garden.',
      category: PetItemCategory.GARDEN,
      price: '10',
      slot: PetHomeSlot.GARDEN,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'little-fern',
      available: true,
    },
    {
      id: 'reading-lantern',
      name: 'Reading lantern',
      description: 'A warm light for a little story.',
      category: PetItemCategory.HOME,
      price: '20',
      slot: PetHomeSlot.FEATURE,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'reading-lantern',
      available: true,
    },
    {
      id: 'cozy-nook',
      name: 'Cozy nook',
      description: 'A welcoming place to rest.',
      category: PetItemCategory.HOME,
      price: '40',
      slot: PetHomeSlot.HOME,
      petIds: [PetId.CAT, PetId.FOX],
      assetId: 'cozy-nook',
      available: true,
    },
  ],
};

export function findCatalogItem(itemId: string): PetCatalogItem {
  const item = petCatalog.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new PetWorldError(PetWorldFailure.INCOMPATIBLE_ITEM);
  }
  return item;
}

export function requireItemCompatibility(item: PetCatalogItem, petId: PetId): void {
  if (!item.petIds.includes(petId)) {
    throw new PetWorldError(PetWorldFailure.INCOMPATIBLE_ITEM);
  }
}
