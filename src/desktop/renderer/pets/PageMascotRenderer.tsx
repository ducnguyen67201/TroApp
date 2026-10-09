import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { Mascot } from 'page-mascot';
import type { PetId } from '#contracts/Pet.js';
import { petCatalog } from './PetAssets.js';
import type { PetRenderOptions, PetRenderer } from './PetRenderer.js';

interface PageMascotViewProps {
  petId: PetId;
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

/** Stateless adapter for the bundled page-mascot catalog.
 * Owns provider APIs, assets and accessibility compatibility; never owns IPC or preferences.
 */
export class PageMascotRenderer implements PetRenderer {
  renderPet(options: PetRenderOptions): ReactElement {
    return (
      <PageMascotView
        petId={options.petId}
        label={options.label}
        reducedMotion={options.reducedMotion}
      />
    );
  }
}
