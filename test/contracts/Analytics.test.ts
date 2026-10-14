import { describe, expect, it } from 'vitest';
import {
  AnalyticsEvent,
  AnalyticsEventSchema,
  AnalyticsScreen,
  AnalyticsSetEnabledSchema,
} from '../../src/contracts/Analytics.js';
import { AgentTaskMode, TeachingOutcome } from '../../src/contracts/CursorCompanion.js';
import { DesktopLocale } from '../../src/contracts/DesktopLocale.js';

describe('analytics event contract', () => {
  it('accepts bounded teaching outcomes without carrying teaching content', () => {
    expect(
      AnalyticsEventSchema.safeParse({
        event: AnalyticsEvent.AGENT_TASK_FINISHED,
        mode: AgentTaskMode.TEACH,
        locale: DesktopLocale.VIETNAMESE,
        result: 'teaching',
        teachingOutcome: TeachingOutcome.GOAL_REACHED,
        durationMs: 45_000,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown events, screen URLs, raw errors and extra student content', () => {
    for (const event of [
      { event: 'arbitrary_event' },
      { event: AnalyticsEvent.SCREEN_VIEWED, screen: 'https://school.test/student' },
      { event: AnalyticsEvent.SCREEN_VIEWED, screen: AnalyticsScreen.CLASSROOM, email: 'private' },
      { event: AnalyticsEvent.DESKTOP_RENDERER_FAILED, reason: 'private exception message' },
      { event: AnalyticsEvent.APP_OPENED, screenshot: 'pixels' },
    ]) {
      expect(AnalyticsEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('rejects invalid durations and unsupported preference fields', () => {
    for (const durationMs of [-1, 0.5, Number.POSITIVE_INFINITY, 86_400_001]) {
      expect(
        AnalyticsEventSchema.safeParse({
          event: AnalyticsEvent.AGENT_TASK_FINISHED,
          mode: AgentTaskMode.EXECUTE,
          locale: DesktopLocale.ENGLISH,
          result: 'failed',
          durationMs,
        }).success,
      ).toBe(false);
    }
    expect(AnalyticsSetEnabledSchema.safeParse({ enabled: true, token: 'private' }).success).toBe(
      false,
    );
    expect(AnalyticsSetEnabledSchema.safeParse({ enabled: 'true' }).success).toBe(false);
  });
});
