import { PetId } from '#contracts/Pet.js';
import catImage from '../../assets/pets/Cat.png';
import foxImage from '../../assets/pets/Fox.png';
import slimeImage from '../../assets/pets/Slime.png';

/** Only bundled raster images enter the first catalog. No user-supplied paths or URLs. */
export const petCatalog = {
  [PetId.CAT]: { imageUrl: catImage },
  [PetId.FOX]: { imageUrl: foxImage },
  [PetId.SLIME]: { imageUrl: slimeImage },
} satisfies Record<PetId, { imageUrl: string }>;
