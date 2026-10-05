import { useEffect, useRef, useState, type ReactElement, type PointerEvent } from 'react';
import { PetMotion, PetOverlayAction, type PetSnapshot } from '#contracts/Pet.js';
import { PetSprite } from './PetSprite.js';
import { petMessages } from './PetMessages.js';

export function PetOverlay(): ReactElement | null {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const revision = useRef(-1);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    const accept = (next: PetSnapshot): void => {
      if (active && next.revision >= revision.current) {
        revision.current = next.revision;
        setSnapshot(next);
      }
    };
    const unsubscribe = window.troPet.subscribePet(accept);
    void window.troPet
      .readPet()
      .then(accept)
      .catch(() => {
        setSnapshot(null);
      });
    const hover = (): void => {
      window.troPet.interactWithPet({ kind: PetOverlayAction.HOVER });
    };
    window.addEventListener('pointermove', hover);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('pointermove', hover);
      window.troPet.interactWithPet({ kind: PetOverlayAction.END_DRAG });
    };
  }, []);

  function finishDrag(event: PointerEvent<HTMLButtonElement>): void {
    const previous = drag.current;
    drag.current = null;
    window.troPet.interactWithPet({ kind: PetOverlayAction.END_DRAG });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (previous && !previous.moved && event.type === 'pointerup') {
      window.troPet.interactWithPet({ kind: PetOverlayAction.PET });
    }
  }

  if (!snapshot?.isVisible) {
    return null;
  }
  const messages = petMessages[snapshot.preferences.locale];
  return (
    <main className="pet-overlay">
      {snapshot.encouragement && (
        <div className="pet-bubble" role="status">
          {messages.encouragement}
        </div>
      )}
      <button
        type="button"
        className="pet-hit-region"
        aria-label={`${messages.pet} ${snapshot.preferences.names[snapshot.preferences.activePetId]}`}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          drag.current = { x: event.screenX, y: event.screenY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          window.troPet.interactWithPet({ kind: PetOverlayAction.START_DRAG });
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (
            previous &&
            !previous.moved &&
            Math.hypot(event.screenX - previous.x, event.screenY - previous.y) > 4
          ) {
            drag.current = { ...previous, moved: true };
          }
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          window.troPet.interactWithPet({ kind: PetOverlayAction.SLAP });
        }}
      >
        <PetSprite
          petId={snapshot.preferences.activePetId}
          reaction={snapshot.reaction}
          reducedMotion={snapshot.preferences.motion === PetMotion.REDUCED}
        />
      </button>
    </main>
  );
}
