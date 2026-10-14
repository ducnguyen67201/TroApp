import type { PostHogOptions } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsEvent } from '../../../../src/contracts/Analytics.js';
import type { AnalyticsCapture } from '../../../../src/desktop/main/analytics/AnalyticsController.js';
import { createPostHogTransport } from '../../../../src/desktop/main/analytics/CreateDesktopAnalytics.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn<(token: string, options: PostHogOptions) => void>(),
  capture: vi.fn<(message: AnalyticsCapture & { disableGeoip: boolean }) => void>(),
  disable: vi.fn<() => Promise<void>>().mockResolvedValue(),
  shutdown: vi.fn<(timeoutMs: number) => Promise<void>>().mockResolvedValue(),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(token: string, options: PostHogOptions) {
      sdk.create(token, options);
    }

    capture(message: AnalyticsCapture & { disableGeoip: boolean }): void {
      sdk.capture(message);
    }

    disable(): Promise<void> {
      return sdk.disable();
    }

    shutdown(timeoutMs: number): Promise<void> {
      return sdk.shutdown(timeoutMs);
    }
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PostHog transport boundary', () => {
  it('disables automatic content capture, geolocation and flags with bounded delivery', async () => {
    const transport = createPostHogTransport('phc_test', 'https://us.i.posthog.com');
    expect(sdk.create).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        host: 'https://us.i.posthog.com',
        persistence: 'memory',
        disableGeoip: true,
        enableExceptionAutocapture: false,
        enableLocalEvaluation: false,
        disableRemoteFeatureFlags: true,
        flushAt: 10,
        maxQueueSize: 100,
        requestTimeout: 2_000,
        fetchRetryCount: 0,
      }),
    );
    const message: AnalyticsCapture = {
      distinctId: 'cd8b39e6-44a7-4c71-ad49-ae50ca2b34ef',
      event: AnalyticsEvent.APP_OPENED,
      properties: { $process_person_profile: false },
    };
    transport.capture(message);
    expect(sdk.capture).toHaveBeenCalledWith({ ...message, disableGeoip: true });
    await transport.shutdown();
    expect(sdk.shutdown).toHaveBeenCalledWith(2_000);
  });

  it('aborts in-flight requests and drops pending sends immediately on opt-out', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createPostHogTransport('phc_test', 'https://us.i.posthog.com');
    const sdkFetch = sdk.create.mock.calls[0]?.[1].fetch;
    if (!sdkFetch) {
      throw new Error('The SDK must use the consent-aware transport.');
    }
    await sdkFetch('https://us.i.posthog.com/batch/', { method: 'POST', headers: {} });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    transport.stop();
    expect(signal?.aborted).toBe(true);
    await sdkFetch('https://us.i.posthog.com/batch/', { method: 'POST', headers: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    transport.capture({ distinctId: 'ignored', event: AnalyticsEvent.APP_OPENED, properties: {} });
    expect(sdk.capture).not.toHaveBeenCalled();
    expect(sdk.disable).toHaveBeenCalled();
  });

  it('preserves failures without exposing provider bodies or raw transport errors', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private provider response', { status: 403 }))
      .mockRejectedValueOnce(new Error('private transport context'));
    vi.stubGlobal('fetch', fetchMock);
    createPostHogTransport('phc_test', 'https://us.i.posthog.com');
    const sdkFetch = sdk.create.mock.calls[0]?.[1].fetch;
    if (!sdkFetch) {
      throw new Error('The SDK must use the consent-aware transport.');
    }
    const rejected = await sdkFetch('https://us.i.posthog.com/batch/', {
      method: 'POST',
      headers: {},
    });
    await expect(
      sdkFetch('https://us.i.posthog.com/batch/', { method: 'POST', headers: {} }),
    ).rejects.toThrow('Analytics delivery failed.');
    expect(await rejected.text()).toBe('');
    expect(rejected.status).toBe(403);
    expect(warning).toHaveBeenCalledExactlyOnceWith('analytics.delivery.failed', {
      reason: 'http',
    });
  });
});
