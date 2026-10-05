import { PetGeometry, type PetPlacement } from '#contracts/Pet.js';

export interface PetDisplay {
  id: number;
  workArea: { x: number; y: number; width: number; height: number };
}

export function placePetOnDisplay(
  display: PetDisplay,
  placement: PetPlacement | null,
): { x: number; y: number } {
  const horizontalRatio = placement?.horizontalRatio ?? 0.95;
  const verticalRatio = placement?.verticalRatio ?? 0.95;
  return {
    x: Math.round(
      display.workArea.x +
        Math.max(0, display.workArea.width - PetGeometry.WIDTH) * horizontalRatio,
    ),
    y: Math.round(
      display.workArea.y +
        Math.max(0, display.workArea.height - PetGeometry.HEIGHT) * verticalRatio,
    ),
  };
}

export function savePetPosition(
  display: PetDisplay,
  position: { x: number; y: number },
): PetPlacement {
  return {
    displayId: display.id,
    horizontalRatio: Math.max(
      0,
      Math.min(
        1,
        (position.x - display.workArea.x) / Math.max(1, display.workArea.width - PetGeometry.WIDTH),
      ),
    ),
    verticalRatio: Math.max(
      0,
      Math.min(
        1,
        (position.y - display.workArea.y) /
          Math.max(1, display.workArea.height - PetGeometry.HEIGHT),
      ),
    ),
  };
}

/** Main computes the hit region from OS pointer coordinates; the renderer cannot enlarge it. */
export function isPointerInsidePet(
  pointer: { x: number; y: number },
  position: { x: number; y: number },
): boolean {
  const horizontalDistance = pointer.x - position.x - PetGeometry.CENTER_X;
  const verticalDistance = pointer.y - position.y - PetGeometry.CENTER_Y;
  return horizontalDistance ** 2 + verticalDistance ** 2 <= PetGeometry.HIT_RADIUS ** 2;
}
