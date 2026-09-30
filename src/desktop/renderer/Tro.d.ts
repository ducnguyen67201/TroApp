import type { DesktopBridge } from '#contracts/SystemStatus.js';

declare global {
  interface Window {
    tro: DesktopBridge;
  }
}
