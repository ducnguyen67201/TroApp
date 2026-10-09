import { useEffect, useState, type ReactElement } from 'react';
import { petRenderer } from './PetPresentation.js';
import type { PetRenderOptions, PetRenderer } from './PetRenderer.js';
import './Pet.css';

interface PetMascotProps extends PetRenderOptions {
  renderer?: PetRenderer;
}

/** Applies Tro and OS motion preferences before delegating to the selected renderer. */
export function PetMascot({ renderer = petRenderer, ...options }: PetMascotProps): ReactElement {
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => {
      setSystemReducedMotion(preference.matches);
    };
    update();
    preference.addEventListener('change', update);
    return () => {
      preference.removeEventListener('change', update);
    };
  }, []);

  return renderer.renderPet({
    ...options,
    reducedMotion: options.reducedMotion || systemReducedMotion,
  });
}
