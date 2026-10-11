import {
  PetEquipmentSlot,
  PetItemCategory,
  PetWorldFailure,
  type PetEquipmentSlot as EquipmentSlot,
  type PetHomeSlot,
  type PetWorldProfile,
} from '#contracts/PetWorld.js';
import type { PetId } from '#contracts/Pet.js';
import { findCatalogItem, requireItemCompatibility } from './PetCatalog.js';
import { PetWorldError } from './PetWorldError.js';

export function changePetEquipment(
  profile: PetWorldProfile,
  slot: EquipmentSlot,
  itemId: string | null,
): PetWorldProfile {
  if (itemId) {
    const item = findCatalogItem(itemId);
    const category =
      slot === PetEquipmentSlot.BACKDROP ? PetItemCategory.BACKDROP : PetItemCategory.OUTFIT;
    if (item.category !== category) {
      throw new PetWorldError(PetWorldFailure.INCOMPATIBLE_ITEM);
    }
    requireItemCompatibility(item, profile.activePetId);
  }
  return slot === PetEquipmentSlot.BACKDROP
    ? { ...profile, backdropItemId: itemId }
    : { ...profile, outfitItemId: itemId };
}

export function changeHomeSlot(
  profile: PetWorldProfile,
  slot: PetHomeSlot,
  itemId: string | null,
): PetWorldProfile {
  if (itemId) {
    const item = findCatalogItem(itemId);
    if (
      item.slot !== slot ||
      (item.category !== PetItemCategory.GARDEN && item.category !== PetItemCategory.HOME)
    ) {
      throw new PetWorldError(PetWorldFailure.INCOMPATIBLE_ITEM);
    }
  }
  return { ...profile, slots: { ...profile.slots, [slot]: itemId } };
}

export function changePetProfile(
  profile: PetWorldProfile,
  petId: PetId,
  name: string,
): PetWorldProfile {
  const isCompatible = (itemId: string | null): boolean =>
    !itemId || findCatalogItem(itemId).petIds.includes(petId);
  return {
    ...profile,
    activePetId: petId,
    names: { ...profile.names, [petId]: name },
    backdropItemId: isCompatible(profile.backdropItemId) ? profile.backdropItemId : null,
    outfitItemId: isCompatible(profile.outfitItemId) ? profile.outfitItemId : null,
  };
}
