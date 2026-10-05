import type { PetOverlayBridge } from '#contracts/Pet.js';

declare global {
  interface Window {
    troPet: PetOverlayBridge;
  }
}
