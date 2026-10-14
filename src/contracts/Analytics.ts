import { z } from 'zod';
import { AgentResultSchema } from './AgentSession.js';
import { AgentTaskModeSchema, TeachingOutcomeSchema } from './CursorCompanion.js';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import { OnboardingAction, OnboardingStatus } from './OnboardingValues.js';
import { TaskOutcomeStatus } from './TaskOutcome.js';

export const AnalyticsEvent = {
  APP_OPENED: 'app_opened',
  SCREEN_VIEWED: 'screen_viewed',
  AGENT_TASK_STARTED: 'agent_task_started',
  AGENT_TASK_FINISHED: 'agent_task_finished',
  CLASSROOM_ACTION_FINISHED: 'classroom_action_finished',
  ONBOARDING_UPDATED: 'onboarding_updated',
  DESKTOP_RENDERER_FAILED: 'desktop_renderer_failed',
} as const;

export const AnalyticsScreen = {
  WORKSPACE: 'workspace',
  CLASSROOM: 'classroom',
  INSIGHTS: 'insights',
  LESSON_VIDEOS: 'lesson-videos',
  PET_WORLD: 'pet-world',
  SIGN_IN: 'sign-in',
} as const;

export const AnalyticsScreenSchema = z.enum(AnalyticsScreen);

export type AnalyticsScreen = z.infer<typeof AnalyticsScreenSchema>;

export const AnalyticsClassroomOperation = {
  JOIN: 'join',
  LEAVE: 'leave',
  SUBMIT: 'submit',
  CHECK: 'check',
  START: 'start',
  END: 'end',
} as const;

export const AnalyticsActionOutcome = { SUCCEEDED: 'succeeded', FAILED: 'failed' } as const;

export const AnalyticsRendererFailure = {
  CLEAN_EXIT: 'clean-exit',
  ABNORMAL_EXIT: 'abnormal-exit',
  KILLED: 'killed',
  CRASHED: 'crashed',
  OUT_OF_MEMORY: 'oom',
  LAUNCH_FAILED: 'launch-failed',
  INTEGRITY_FAILURE: 'integrity-failure',
  MEMORY_EVICTION: 'memory-eviction',
} as const;

const durationMs = z.number().int().min(0).max(86_400_000);
const agentResult = z.union(AgentResultSchema.options.map((option) => option.shape.kind));

/** Explicit events accept only static vocabulary and bounded measurements, never user content. */
export const AnalyticsEventSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal(AnalyticsEvent.APP_OPENED) }),
  z.strictObject({ event: z.literal(AnalyticsEvent.SCREEN_VIEWED), screen: AnalyticsScreenSchema }),
  z.strictObject({
    event: z.literal(AnalyticsEvent.AGENT_TASK_STARTED),
    mode: AgentTaskModeSchema,
    locale: DesktopLocaleSchema,
  }),
  z.strictObject({
    event: z.literal(AnalyticsEvent.AGENT_TASK_FINISHED),
    mode: AgentTaskModeSchema,
    locale: DesktopLocaleSchema,
    result: agentResult,
    outcome: z.enum(TaskOutcomeStatus).optional(),
    teachingOutcome: TeachingOutcomeSchema.optional(),
    durationMs,
  }),
  z.strictObject({
    event: z.literal(AnalyticsEvent.CLASSROOM_ACTION_FINISHED),
    operation: z.enum(AnalyticsClassroomOperation),
    outcome: z.enum(AnalyticsActionOutcome),
    durationMs,
  }),
  z.strictObject({
    event: z.literal(AnalyticsEvent.ONBOARDING_UPDATED),
    action: z.enum(OnboardingAction),
    status: z.enum(OnboardingStatus),
  }),
  z.strictObject({
    event: z.literal(AnalyticsEvent.DESKTOP_RENDERER_FAILED),
    reason: z.enum(AnalyticsRendererFailure),
  }),
]);

export type AnalyticsEventInput = z.infer<typeof AnalyticsEventSchema>;

export const AnalyticsStatusSchema = z.strictObject({
  configured: z.boolean(),
  enabled: z.boolean(),
});

export type AnalyticsStatus = z.infer<typeof AnalyticsStatusSchema>;

export const AnalyticsSetEnabledSchema = z.strictObject({ enabled: z.boolean() });

export const AnalyticsReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), status: AnalyticsStatusSchema }),
  z.strictObject({ kind: z.literal('failed') }),
]);

export type AnalyticsReply = z.infer<typeof AnalyticsReplySchema>;
