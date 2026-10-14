import { setTimeout as waitForRetry } from 'node:timers/promises';
import type { Details } from 'electron';

export const DesktopWindowSource = {
  DEVELOPMENT: 'development',
  PACKAGED: 'packaged',
} as const;

type DesktopWindowSource = (typeof DesktopWindowSource)[keyof typeof DesktopWindowSource];

export const DesktopWindowLoadPolicy = { MAX_ATTEMPTS: 3, RETRY_DELAY_MS: 300 } as const;

export interface DesktopChildFailure {
  event: 'desktop.child_process.failed';
  processType: Details['type'];
  reason: Details['reason'];
  exitCode: number;
  isNetworkService: boolean;
}

export type DesktopWindowLoadDiagnostic =
  | {
      event: 'desktop.renderer.load.failed';
      source: DesktopWindowSource;
      attempt: number;
      code: string;
      durationMs: number;
      willRetry: boolean;
    }
  | {
      event: 'desktop.renderer.load.recovered';
      source: DesktopWindowSource;
      attempt: number;
      durationMs: number;
    };

/** Child names and service identifiers are used only for classification, never logged. */
export function readDesktopChildFailure(details: Details): DesktopChildFailure | null {
  if (details.reason === 'clean-exit') {
    return null;
  }
  return {
    event: 'desktop.child_process.failed',
    processType: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    isNetworkService:
      details.type === 'Utility' &&
      (details.serviceName === 'network.mojom.NetworkService' ||
        details.name === 'Network Service'),
  };
}

function readNavigationFailureCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const codes = new Set([
      'ERR_FAILED',
      'ERR_ABORTED',
      'ERR_CONNECTION_REFUSED',
      'ERR_CONNECTION_RESET',
      'ERR_NAME_NOT_RESOLVED',
      'ERR_INTERNET_DISCONNECTED',
      'ERR_TIMED_OUT',
      'ERR_FILE_NOT_FOUND',
    ]);
    if (codes.has(error.code)) {
      return error.code;
    }
  }
  return 'unknown';
}

interface DesktopWindowLoadOptions {
  source: DesktopWindowSource;
  load(): Promise<void>;
  readNetworkFailureVersion(): number;
  canContinue(): boolean;
  log(diagnostic: DesktopWindowLoadDiagnostic): void;
  pause?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

/** Retry only an initial development navigation interrupted by an observed Network Service
 * failure. The same validated document is loaded again; shutdown and ordinary navigation
 * failures still propagate. Packaged loads and sandbox policy are unchanged.
 */
export async function loadDesktopWindow(options: DesktopWindowLoadOptions): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? ((delayMs: number) => waitForRetry(delayMs));
  const startedAt = now();
  for (let attempt = 1; attempt <= DesktopWindowLoadPolicy.MAX_ATTEMPTS; attempt += 1) {
    const networkFailureVersion = options.readNetworkFailureVersion();
    try {
      await options.load();
      if (attempt > 1) {
        options.log({
          event: 'desktop.renderer.load.recovered',
          source: options.source,
          attempt,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
        });
      }
      return;
    } catch (error: unknown) {
      const code = readNavigationFailureCode(error);
      const willRetry =
        options.source === DesktopWindowSource.DEVELOPMENT &&
        code === 'ERR_FAILED' &&
        options.readNetworkFailureVersion() !== networkFailureVersion &&
        attempt < DesktopWindowLoadPolicy.MAX_ATTEMPTS &&
        options.canContinue();
      options.log({
        event: 'desktop.renderer.load.failed',
        source: options.source,
        attempt,
        code,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        willRetry,
      });
      if (!willRetry) {
        throw error;
      }
      await pause(DesktopWindowLoadPolicy.RETRY_DELAY_MS);
      if (!options.canContinue()) {
        throw error;
      }
    }
  }
}
