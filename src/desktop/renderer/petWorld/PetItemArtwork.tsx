import type { ReactElement } from 'react';
import {
  IconArmchair,
  IconBook2,
  IconFlower,
  IconLamp,
  IconMoonStars,
  IconPlant2,
  IconShirt,
  IconSun,
} from '@tabler/icons-react';
import { PetItemCategory, type PetCatalogItem } from '#contracts/PetWorld.js';

interface PetItemArtworkProps {
  item: PetCatalogItem;
  size?: number;
}

/** Cosmetic asset IDs select trusted bundled artwork; unknown IDs have a quiet fallback. */
export function PetItemArtwork({ item, size = 62 }: PetItemArtworkProps): ReactElement {
  const props = { size, stroke: 1.2, 'aria-hidden': true } as const;
  switch (item.assetId) {
    case 'little-fern':
      return <IconPlant2 {...props} />;
    case 'reading-lantern':
      return <IconLamp {...props} />;
    case 'cozy-nook':
      return <IconArmchair {...props} />;
    case 'starry-sky':
      return <IconMoonStars {...props} />;
    case 'reading-nook':
      return <IconBook2 {...props} />;
    case 'meadow':
      return <IconSun {...props} />;
    default:
      return item.category === PetItemCategory.OUTFIT ? (
        <IconShirt {...props} />
      ) : (
        <IconFlower {...props} />
      );
  }
}
