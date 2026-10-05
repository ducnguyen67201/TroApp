import { expect, it } from 'vitest';
import {
  placePetOnDisplay,
  savePetPosition,
  isPointerInsidePet,
} from '../../../../src/desktop/main/pets/PetPlacement.js';

it('round-trips placement on a scaled secondary display and clamps off-screen positions', () => {
  const display = { id: 2, workArea: { x: -1600, y: 100, width: 1200, height: 800 } };
  const position = { x: -900, y: 450 };
  expect(placePetOnDisplay(display, savePetPosition(display, position))).toEqual(position);
  const placement = savePetPosition(display, { x: -5000, y: 6000 });
  expect(placement).toMatchObject({ horizontalRatio: 0, verticalRatio: 1 });
  expect(placePetOnDisplay(display, placement)).toEqual({ x: -1600, y: 740 });
});

it('keeps transparent padding outside the main-owned hit region', () => {
  const position = { x: 200, y: 300 };
  expect(isPointerInsidePet({ x: 272, y: 400 }, position)).toBe(true);
  expect(isPointerInsidePet({ x: 225, y: 353 }, position)).toBe(false);
  expect(isPointerInsidePet({ x: 272, y: 310 }, position)).toBe(false);
});
