import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { Mascot } from 'page-mascot';
import { PetId, PetReaction } from '#contracts/Pet.js';
import { petCatalog } from './PetAssets.js';
import { PetSprite } from './PetSprite.js';
import type { PetRenderOptions, PetRenderer } from './PetRenderer.js';

interface PageMascotViewProps {
  petId: Exclude<PetId, typeof PetId.SLIME>;
  label: string;
  reducedMotion: boolean;
}

function PageMascotView({ petId, label, reducedMotion }: PageMascotViewProps): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    /* The public component owns its button but prefixes its label in English.
     * Override only the accessible name, without coupling to its sprite DOM. */
    container.current?.querySelector('button')?.setAttribute('aria-label', label);
  }, [label, petId, reducedMotion]);

  const sheets = petCatalog[petId];
  return (
    <div
      ref={container}
      className="pet-mascot"
      data-pet-id={petId}
      data-motion={reducedMotion ? 'reduced' : 'system'}
    >
      {reducedMotion ? (
        <span
          role="img"
          aria-label={label}
          className="pet-mascot-still"
          style={{ backgroundImage: `url(${sheets.directions})` }}
        />
      ) : (
        <Mascot
          directions={sheets.directions}
          reactions={sheets.reactions}
          size={96}
          label={label}
        />
      )}
    </div>
  );
}

/** Stateless adapter for page-mascot and the bundled slime fallback.
 * Owns provider APIs, assets and accessibility compatibility; never owns IPC or preferences.
 */
export class PageMascotRenderer implements PetRenderer {
  renderPet(options: PetRenderOptions): ReactElement {
    if (options.petId === PetId.SLIME) {
      return (
        <button
          type="button"
          className="pet-mascot-button"
          aria-label={options.label}
          onClick={options.onPet}
          onContextMenu={(event) => {
            event.preventDefault();
            options.onSlap?.();
          }}
        >
          <PetSprite
            reaction={options.reaction ?? PetReaction.IDLE}
            reducedMotion={options.reducedMotion}
          />
        </button>
      );
    }
    return (
      <PageMascotView
        petId={options.petId}
        label={options.label}
        reducedMotion={options.reducedMotion}
      />
    );
  }

  supportsControlledReactions(petId: PetId): boolean {
    return petId === PetId.SLIME;
  }
}
