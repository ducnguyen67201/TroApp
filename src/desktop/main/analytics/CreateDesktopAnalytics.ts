import { PostHog } from 'posthog-node';
import { AnalyticsPreferences } from './AnalyticsPreferences.js';
import {
  AnalyticsController,
  analyticsShutdownTimeoutMs,
  type AnalyticsMetadata,
  type AnalyticsTransport,
} from './AnalyticsController.js';

export interface DesktopAnalyticsOptions extends AnalyticsMetadata {
  directory: string;
  projectToken: string | undefined;
  host: string | undefined;
}

/** A fresh SDK instance is owned by one period of sharing; disabled queues cannot be reused. */
export function createPostHogTransport(projectToken: string, host: string): AnalyticsTransport {
  const cancellation = new AbortController();
  let stopped = false;
  let hasReportedFailure = false;

  function reportDeliveryFailure(reason: 'transport' | 'http'): void {
    if (!stopped && !hasReportedFailure) {
      hasReportedFailure = true;
      console.warn('analytics.delivery.failed', { reason });
    }
  }

  const client = new PostHog(projectToken, {
    host,
    persistence: 'memory',
    disableGeoip: true,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
    disableRemoteFeatureFlags: true,
    flushAt: 10,
    maxQueueSize: 100,
    flushInterval: 10_000,
    requestTimeout: analyticsShutdownTimeoutMs,
    fetchRetryCount: 0,
    before_send: (event) => (stopped ? null : event),
    fetch: async (url, options) => {
      if (stopped) {
        return new Response(null, { status: 200 });
      }
      const signal = options.signal
        ? AbortSignal.any([options.signal, cancellation.signal])
        : cancellation.signal;
      try {
        const response = await fetch(url, { ...options, signal });
        if (response.ok) {
          return response;
        }
        reportDeliveryFailure('http');
        void response.body?.cancel().catch(() => {});
        /* SDK background diagnostics may log this response. Preserve only the
           failure status, without provider bodies, headers, URLs or status text. */
        return new Response(null, { status: response.status });
      } catch {
        reportDeliveryFailure('transport');
        if (cancellation.signal.aborted) {
          return new Response(null, { status: 200 });
        }
        throw new Error('Analytics delivery failed.');
      }
    },
  });

  return {
    capture: (message) => {
      if (!stopped) {
        client.capture({ ...message, disableGeoip: true });
      }
    },
    stop: () => {
      stopped = true;
      cancellation.abort();
      void client.disable().catch(() => {});
    },
    shutdown: () => client.shutdown(analyticsShutdownTimeoutMs),
  };
}

/** Configuration is validated by desktop Env before composition; no backend key enters this adapter. */
export function createDesktopAnalytics(options: DesktopAnalyticsOptions): AnalyticsController {
  const projectToken = options.projectToken;
  const host = options.host;
  return new AnalyticsController(
    new AnalyticsPreferences(options.directory),
    projectToken && host ? () => createPostHogTransport(projectToken, host) : undefined,
    {
      appVersion: options.appVersion,
      appEnvironment: options.appEnvironment,
      platform: options.platform,
    },
  );
}
