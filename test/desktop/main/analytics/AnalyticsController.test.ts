import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnalyticsEvent,
  AnalyticsScreen,
  type AnalyticsEventInput,
} from '../../../../src/contracts/Analytics.js';
import { AppEnvironment } from '../../../../src/contracts/AppEnvironment.js';
import {
  AnalyticsController,
  analyticsShutdownTimeoutMs,
  type AnalyticsTransport,
} from '../../../../src/desktop/main/analytics/AnalyticsController.js';
import type {
  AnalyticsStore,
  SavedAnalyticsPreferences,
} from '../../../../src/desktop/main/analytics/AnalyticsPreferences.js';

const installationId = 'cd8b39e6-44a7-4c71-ad49-ae50ca2b34ef';
const screenEvent: AnalyticsEventInput = {
  event: AnalyticsEvent.SCREEN_VIEWED,
  screen: AnalyticsScreen.CLASSROOM,
};

function createHarness(saved: SavedAnalyticsPreferences | null = null, configured = true) {
  const store = {
    readPreferences: vi.fn<AnalyticsStore['readPreferences']>().mockResolvedValue(saved),
    savePreferences: vi.fn<AnalyticsStore['savePreferences']>().mockResolvedValue(),
  };
  const transport = {
    capture: vi.fn<AnalyticsTransport['capture']>(),
    stop: vi.fn<AnalyticsTransport['stop']>(),
    shutdown: vi.fn<AnalyticsTransport['shutdown']>().mockResolvedValue(),
  };
  const createTransport = vi.fn<() => AnalyticsTransport>().mockReturnValue(transport);
  const controller = new AnalyticsController(store, configured ? createTransport : undefined, {
    appVersion: '0.1.0',
    appEnvironment: AppEnvironment.PROD,
    platform: 'darwin',
  });
  return { store, transport, createTransport, controller };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('analytics preferences and delivery', () => {
  it('saves sharing and a device identity once before tracking a configured new installation', async () => {
    const { controller, createTransport, transport, store } = createHarness();
    controller.capture(screenEvent);
    expect(createTransport).not.toHaveBeenCalled();
    await Promise.all([controller.initialize(), controller.initialize()]);
    controller.capture(screenEvent);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(store.readPreferences).toHaveBeenCalledTimes(1);
    const firstId = transport.capture.mock.calls[0]?.[0].distinctId;
    expect(firstId).toBeTypeOf('string');
    expect(store.savePreferences).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      enabled: true,
      installationId: firstId,
    });
    expect(transport.capture.mock.calls.map(([message]) => message.event)).toEqual([
      AnalyticsEvent.APP_OPENED,
      AnalyticsEvent.SCREEN_VIEWED,
    ]);
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: true },
    });
  });

  it('keeps an existing opt-out unchanged when the app starts', async () => {
    const { controller, createTransport, store } = createHarness({
      version: 1,
      enabled: false,
      installationId,
    });
    await controller.initialize();
    controller.capture(screenEvent);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences).not.toHaveBeenCalled();
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: false },
    });
  });

  it('creates no preference or client when a new installation is unconfigured', async () => {
    const { controller, createTransport, store } = createHarness(null, false);
    await controller.initialize();
    controller.capture(screenEvent);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences).not.toHaveBeenCalled();
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: false, enabled: false },
    });
  });

  it('leaves an unconfigured app offline even when a consent file exists', async () => {
    const { controller, createTransport, store } = createHarness(
      { version: 1, enabled: true, installationId },
      false,
    );
    await controller.initialize();
    expect(await controller.setEnabled(true)).toEqual({ kind: 'failed' });
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: false, enabled: false },
    });
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences).not.toHaveBeenCalled();
  });

  it('loads saved consent once and emits one app-open event with a device identity', async () => {
    const { controller, transport, store } = createHarness({
      version: 1,
      enabled: true,
      installationId,
    });
    await Promise.all([controller.initialize(), controller.initialize()]);
    controller.capture(screenEvent);
    expect(store.readPreferences).toHaveBeenCalledTimes(1);
    expect(transport.capture).toHaveBeenNthCalledWith(1, {
      distinctId: installationId,
      event: AnalyticsEvent.APP_OPENED,
      properties: {
        appVersion: '0.1.0',
        appEnvironment: AppEnvironment.PROD,
        platform: 'darwin',
        $process_person_profile: false,
      },
    });
    expect(transport.capture).toHaveBeenNthCalledWith(2, {
      distinctId: installationId,
      event: AnalyticsEvent.SCREEN_VIEWED,
      properties: {
        appVersion: '0.1.0',
        appEnvironment: AppEnvironment.PROD,
        platform: 'darwin',
        $process_person_profile: false,
        screen: AnalyticsScreen.CLASSROOM,
      },
    });
  });

  it('saves opt-in before capture and rotates identity after opting out', async () => {
    const { controller, transport, store, createTransport } = createHarness({
      version: 1,
      enabled: false,
      installationId,
    });
    await controller.initialize();
    let releaseSave: (() => void) | undefined;
    store.savePreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    const enabled = controller.setEnabled(true);
    await vi.waitFor(() => {
      expect(releaseSave).toBeDefined();
    });
    controller.capture(screenEvent);
    expect(createTransport).not.toHaveBeenCalled();
    releaseSave?.();
    await enabled;
    controller.capture(screenEvent);
    const firstId = transport.capture.mock.calls[0]?.[0].distinctId;
    expect(firstId).toBeTypeOf('string');
    await controller.setEnabled(false);
    const captureCount = transport.capture.mock.calls.length;
    controller.capture(screenEvent);
    expect(transport.capture).toHaveBeenCalledTimes(captureCount);
    await controller.setEnabled(true);
    controller.capture(screenEvent);
    expect(transport.capture.mock.lastCall?.[0].distinctId).not.toBe(firstId);
    expect(
      transport.capture.mock.calls.filter(
        ([message]) => message.event === AnalyticsEvent.APP_OPENED,
      ),
    ).toHaveLength(1);
  });

  it('rejects extra fields at the final capture boundary', async () => {
    const { controller, transport } = createHarness({ version: 1, enabled: true, installationId });
    await controller.initialize();
    transport.capture.mockClear();
    const eventWithContent = { ...screenEvent, email: 'student@example.test' };
    controller.capture(eventWithContent);
    expect(transport.capture).not.toHaveBeenCalled();
  });

  it('preserves unreadable consent and stays disabled when preference persistence fails', async () => {
    const broken = createHarness();
    broken.store.readPreferences.mockRejectedValue(new Error('unreadable'));
    await broken.controller.initialize();
    expect(await broken.controller.setEnabled(true)).toEqual({ kind: 'failed' });
    expect(broken.store.savePreferences).not.toHaveBeenCalled();
    expect(broken.controller.readStatus()).toEqual({ kind: 'failed' });
    broken.store.readPreferences.mockResolvedValue(null);
    await broken.controller.initialize();
    expect(broken.controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: false },
    });
    const { controller, store, transport } = createHarness({
      version: 1,
      enabled: true,
      installationId,
    });
    await controller.initialize();
    transport.capture.mockClear();
    store.savePreferences.mockRejectedValue(new Error('disk full'));
    expect(await controller.setEnabled(false)).toEqual({ kind: 'failed' });
    controller.capture(screenEvent);
    expect(transport.capture).not.toHaveBeenCalled();
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: false },
    });
  });

  it('keeps opt-out off while an earlier opt-in save is pending', async () => {
    const { controller, store, createTransport } = createHarness({
      version: 1,
      enabled: false,
      installationId,
    });
    await controller.initialize();
    let releaseSave: (() => void) | undefined;
    store.savePreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    const enabled = controller.setEnabled(true);
    await vi.waitFor(() => {
      expect(releaseSave).toBeDefined();
    });
    const disabled = controller.setEnabled(false);
    releaseSave?.();
    await Promise.all([enabled, disabled]);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences.mock.lastCall?.[0].enabled).toBe(false);
  });

  it('waits for the default preference save and honors a concurrent opt-out', async () => {
    const { controller, store, createTransport } = createHarness();
    let releaseSave: (() => void) | undefined;
    store.savePreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    const initialized = controller.initialize();
    await vi.waitFor(() => {
      expect(releaseSave).toBeDefined();
    });
    controller.capture(screenEvent);
    expect(createTransport).not.toHaveBeenCalled();
    const disabled = controller.setEnabled(false);
    releaseSave?.();
    await Promise.all([initialized, disabled]);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences.mock.lastCall?.[0].enabled).toBe(false);
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: false },
    });
  });

  it('does not save default sharing when opt-out is requested before initialization', async () => {
    const { controller, createTransport, store } = createHarness();
    await controller.setEnabled(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences).toHaveBeenCalledTimes(1);
    expect(store.savePreferences.mock.lastCall?.[0].enabled).toBe(false);
  });

  it('fails closed when the first default save fails and retries initialization safely', async () => {
    const { controller, store, createTransport, transport } = createHarness();
    store.savePreferences.mockRejectedValueOnce(new Error('disk full'));
    await controller.initialize();
    controller.capture(screenEvent);
    expect(controller.readStatus()).toEqual({ kind: 'failed' });
    expect(createTransport).not.toHaveBeenCalled();
    await controller.initialize();
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: true },
    });
    expect(store.savePreferences).toHaveBeenCalledTimes(2);
    expect(transport.capture.mock.calls[0]?.[0].distinctId).toBe(
      store.savePreferences.mock.lastCall?.[0].installationId,
    );
  });

  it('does not restore saved consent while a disable request initializes storage', async () => {
    const { controller, createTransport, store } = createHarness({
      version: 1,
      enabled: true,
      installationId,
    });
    await controller.setEnabled(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(store.savePreferences.mock.lastCall?.[0].enabled).toBe(false);
  });

  it('contains SDK exceptions and bounds a stuck shutdown', async () => {
    vi.useFakeTimers();
    const { controller, transport } = createHarness({ version: 1, enabled: true, installationId });
    await controller.initialize();
    transport.capture.mockImplementation(() => {
      throw new Error('sdk failed');
    });
    expect(() => {
      controller.capture(screenEvent);
    }).not.toThrow();
    transport.shutdown.mockImplementation(() => new Promise<void>(() => {}));
    const shutdown = controller.shutdown();
    await vi.advanceTimersByTimeAsync(analyticsShutdownTimeoutMs);
    await shutdown;
    expect(transport.stop).toHaveBeenCalled();
    expect(controller.readStatus()).toEqual({
      kind: 'ok',
      status: { configured: true, enabled: false },
    });
  });
});
