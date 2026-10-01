import type { DesktopBridge } from '#contracts/DesktopBridge.js';

declare global {
  interface Window {
    tro: DesktopBridge;
  }
}
