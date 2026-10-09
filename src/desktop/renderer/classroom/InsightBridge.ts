import type { DesktopBridge } from '#contracts/DesktopBridge.js';

/** Older hosts and browser-only previews may omit the optional insight capabilities. */
export function readInsightBridge(
  browser: { tro?: DesktopBridge } = window,
): Pick<DesktopBridge, 'controlClassroomInsights' | 'exportParentReport'> | null {
  return browser.tro ?? null;
}
