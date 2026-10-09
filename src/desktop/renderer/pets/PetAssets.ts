import { PetId } from '#contracts/Pet.js';
import catDirections from '../../assets/pets/CatDirections.webp';
import catReactions from '../../assets/pets/CatReactions.webp';
import foxDirections from '../../assets/pets/FoxDirections.webp';
import foxReactions from '../../assets/pets/FoxReactions.webp';

/** Asset provenance and permission notice live in assets/pets/PageMascotLicense.txt. */
export const petCatalog = {
  [PetId.CAT]: { directions: catDirections, reactions: catReactions },
  [PetId.FOX]: { directions: foxDirections, reactions: foxReactions },
};
