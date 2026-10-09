import { useEffect, useRef, useState, type ReactElement, type PointerEvent } from 'react';
import { PetMotion, PetOverlayAction, type PetSnapshot } from '#contracts/Pet.js';
import { PetMascot } from './PetMascot.js';
import { petMessages } from './PetMessages.js';

export function PetOverlay(): ReactElement | null {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const revision = useRef(-1);
  const suppressClick = useRef(false);
  const capturedPointer = useRef<Element | null>(null);
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
    /* Electron forwards mouse movement while the transparent window ignores clicks. */
    window.addEventListener('mousemove', hover);
    window.addEventListener('mouseleave', hover);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('mousemove', hover);
      window.removeEventListener('mouseleave', hover);
      window.troPet.interactWithPet({ kind: PetOverlayAction.END_DRAG });
    };
  }, []);

  function finishDrag(event: PointerEvent<HTMLDivElement>): void {
    const previous = drag.current;
    drag.current = null;
    window.troPet.interactWithPet({ kind: PetOverlayAction.END_DRAG });
    if (!previous) {
      return;
    }
    suppressClick.current = previous.moved || event.type !== 'pointerup';
    const captured = capturedPointer.current;
    capturedPointer.current = null;
    if (captured?.hasPointerCapture(event.pointerId)) {
      captured.releasePointerCapture(event.pointerId);
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
      <div
        className="pet-hit-region"
        onPointerDownCapture={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          suppressClick.current = false;
          drag.current = { x: event.screenX, y: event.screenY, moved: false };
          const target = event.target;
          if (target instanceof Element) {
            capturedPointer.current = target.closest('button') ?? event.currentTarget;
            capturedPointer.current.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMoveCapture={(event) => {
          const previous = drag.current;
          if (
            previous &&
            !previous.moved &&
            Math.hypot(event.screenX - previous.x, event.screenY - previous.y) > 4
          ) {
            drag.current = { ...previous, moved: true };
            window.troPet.interactWithPet({ kind: PetOverlayAction.START_DRAG });
          }
        }}
        onPointerUpCapture={finishDrag}
        onPointerCancelCapture={finishDrag}
        onLostPointerCapture={finishDrag}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail > 0) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <PetMascot
          petId={snapshot.preferences.activePetId}
          label={`${messages.pet} ${snapshot.preferences.names[snapshot.preferences.activePetId]}`}
          reducedMotion={snapshot.preferences.motion === PetMotion.REDUCED}
        />
      </div>
    </main>
  );
}
