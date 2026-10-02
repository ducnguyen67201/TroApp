import type { DesktopDriverConnection } from '#contracts/DesktopDriver.js';

/** Workers lease connections from the main-owned host. Only main stops it. */
export interface DesktopDriverPort {
  start(onExit: () => void): Promise<DesktopDriverConnection>;
}
