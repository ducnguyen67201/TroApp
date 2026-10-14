import {
  AnalyticsEvent,
  AnalyticsScreenSchema,
  AnalyticsSetEnabledSchema,
  type AnalyticsEventInput,
  type AnalyticsReply,
} from '#contracts/Analytics.js';

export interface DesktopAnalytics {
  initialize(): Promise<void>;
  readStatus(): AnalyticsReply;
  setEnabled(enabled: boolean): Promise<AnalyticsReply>;
  capture(event: AnalyticsEventInput): void;
}

/** The renderer can change consent or report one fixed screen name, never arbitrary event properties. */
export function registerAnalyticsHandlers<Event>(
  ipc: {
    handle(
      channel: string,
      listener: (event: Event, raw: unknown) => AnalyticsReply | boolean | Promise<AnalyticsReply>,
    ): void;
  },
  isTrustedSender: (event: Event) => boolean,
  analytics: DesktopAnalytics,
): void {
  ipc.handle('tro:analytics-status', async (event) => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed' };
    }
    await analytics.initialize();
    return isTrustedSender(event) ? analytics.readStatus() : { kind: 'failed' };
  });
  ipc.handle('tro:analytics-enabled', (event, raw) => {
    const request = AnalyticsSetEnabledSchema.safeParse(raw);
    return isTrustedSender(event) && request.success
      ? analytics.setEnabled(request.data.enabled)
      : { kind: 'failed' };
  });
  ipc.handle('tro:analytics-screen', (event, raw) => {
    const screen = AnalyticsScreenSchema.safeParse(raw);
    if (!isTrustedSender(event) || !screen.success) {
      return false;
    }
    analytics.capture({ event: AnalyticsEvent.SCREEN_VIEWED, screen: screen.data });
    return true;
  });
}
