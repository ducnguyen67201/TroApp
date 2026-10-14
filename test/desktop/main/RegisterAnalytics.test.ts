import { expect, it, vi } from 'vitest';
import { AnalyticsEvent, AnalyticsScreen, type AnalyticsReply } from '#contracts/Analytics.js';
import {
  registerAnalyticsHandlers,
  type DesktopAnalytics,
} from '../../../src/desktop/main/RegisterAnalytics.js';

it('checks the sender and rejects arbitrary event properties at the analytics IPC boundary', async () => {
  const status: AnalyticsReply = { kind: 'ok', status: { configured: true, enabled: false } };
  const analytics = {
    initialize: vi.fn<DesktopAnalytics['initialize']>().mockResolvedValue(),
    readStatus: vi.fn<DesktopAnalytics['readStatus']>().mockReturnValue(status),
    setEnabled: vi.fn<DesktopAnalytics['setEnabled']>().mockResolvedValue(status),
    capture: vi.fn<DesktopAnalytics['capture']>(),
  };
  const handlers = new Map<
    string,
    (trusted: boolean, raw: unknown) => AnalyticsReply | boolean | Promise<AnalyticsReply>
  >();
  registerAnalyticsHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    (trusted: boolean) => trusted,
    analytics,
  );
  const invoke = (channel: string, trusted: boolean, raw?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error('Missing analytics handler.');
    }
    return handler(trusted, raw);
  };

  expect(await invoke('tro:analytics-status', false)).toEqual({ kind: 'failed' });
  expect(await invoke('tro:analytics-enabled', false, { enabled: true })).toEqual({
    kind: 'failed',
  });
  expect(await invoke('tro:analytics-screen', false, AnalyticsScreen.WORKSPACE)).toBe(false);
  expect(analytics.readStatus).not.toHaveBeenCalled();
  expect(analytics.setEnabled).not.toHaveBeenCalled();
  expect(analytics.capture).not.toHaveBeenCalled();

  for (const invalid of [
    true,
    { enabled: 'yes' },
    { enabled: true, email: 'student@example.test' },
  ]) {
    expect(await invoke('tro:analytics-enabled', true, invalid)).toEqual({ kind: 'failed' });
  }
  for (const invalid of [
    '#/classroom/private-id',
    { screen: AnalyticsScreen.CLASSROOM, text: 'private lesson' },
  ]) {
    expect(await invoke('tro:analytics-screen', true, invalid)).toBe(false);
  }
  expect(await invoke('tro:analytics-enabled', true, { enabled: true })).toEqual(status);
  expect(analytics.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  expect(await invoke('tro:analytics-screen', true, AnalyticsScreen.CLASSROOM)).toBe(true);
  expect(analytics.capture).toHaveBeenCalledExactlyOnceWith({
    event: AnalyticsEvent.SCREEN_VIEWED,
    screen: AnalyticsScreen.CLASSROOM,
  });
});
