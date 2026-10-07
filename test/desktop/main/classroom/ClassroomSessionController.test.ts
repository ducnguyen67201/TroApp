import { createPracticeCheckpoint } from '../../../server/features/classroom/PracticeFixtures.js';
import type { TeachingContext } from '#contracts/Classroom.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ClassroomSessionController,
  type ClassroomApi,
} from '../../../../src/desktop/main/classroom/ClassroomSessionController.js';
import { ClassroomFailure, ClassroomPacing, type ClassroomReply } from '#contracts/Classroom.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';

describe('desktop classroom binding', () => {
  it('replaces old context on teacher updates and fails closed on connection loss', async () => {
    const context = createTeachingContext();
    const invalidate = vi.fn<() => void>();
    const execute = vi
      .fn<ClassroomApi['execute']>()
      .mockResolvedValue({ kind: 'context', context });
    const controller = new ClassroomSessionController({ execute }, invalidate);
    try {
      await controller.execute({
        kind: 'join',
        classSessionId: context.meeting.id,
        deviceId: randomUUID(),
      });
      expect(controller.isContextCurrent(context)).toBe(true);
      execute.mockResolvedValue({
        kind: 'context',
        context: { ...context, meeting: { ...context.meeting, contextVersion: 2 } },
      });
      await controller.readTeachingContext();
      expect(controller.isContextCurrent(context)).toBe(false);
      execute.mockResolvedValue({ kind: 'failed', code: ClassroomFailure.UNAVAILABLE });
      await expect(controller.readTeachingContext()).rejects.toThrow('unavailable');
      expect(invalidate).toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('does not admit a late join after disposal', async () => {
    const context = createTeachingContext();
    let resolve: (reply: ClassroomReply) => void = () => {};
    const delayed = new Promise<ClassroomReply>((finish) => {
      resolve = finish;
    });
    const controller = new ClassroomSessionController({ execute: () => delayed }, () => {});
    const joining = controller.execute({
      kind: 'join',
      classSessionId: context.meeting.id,
      deviceId: randomUUID(),
    });
    await Promise.resolve();
    controller.dispose();
    resolve({ kind: 'context', context });
    expect(await joining).toEqual({ kind: 'failed', code: ClassroomFailure.STALE });
    expect(controller.isContextCurrent(context)).toBe(false);
  });

  it('binds worker operations to the current student and never exposes submission commit', async () => {
    const initial = createTeachingContext();
    const context = { ...initial, attempt: { ...initial.attempt, declaredComplete: true } };
    const execute = vi
      .fn<ClassroomApi['execute']>()
      .mockResolvedValue({ kind: 'context', context });
    const controller = new ClassroomSessionController({ execute }, () => {});
    try {
      await controller.execute({
        kind: 'join',
        classSessionId: context.meeting.id,
        deviceId: randomUUID(),
      });
      await controller.executeTool(
        {
          kind: 'report-progress',
          evidence: [
            {
              criterionId: context.activity.criteria[0]?.id ?? randomUUID(),
              source: 'student',
              observation: 'Connected event visible',
            },
          ],
          helpSummary: 'Checked event',
        },
        context,
      );
      const report = execute.mock.calls.at(-1)?.[0];
      expect(report?.kind).toBe('report-progress');
      if (report?.kind === 'report-progress') {
        expect(report.evidence[0]?.source).toBe('model');
        expect(report.declaredComplete).toBe(true);
      }
      await expect(
        controller.executeTool(
          { kind: 'resume-workspace' },
          { ...context, participation: { ...context.participation, id: randomUUID() } },
        ),
      ).resolves.toEqual({ kind: 'failed', code: ClassroomFailure.STALE });
    } finally {
      controller.dispose();
    }
  });
  it('cannot restore an old self-paced activity from a late heartbeat', async () => {
    const initial = createTeachingContext();
    const context = {
      ...initial,
      meeting: { ...initial.meeting, pacing: ClassroomPacing.STUDENT },
    };
    const execute = vi
      .fn<ClassroomApi['execute']>()
      .mockResolvedValue({ kind: 'context', context });
    const controller = new ClassroomSessionController({ execute }, () => {});
    try {
      await controller.execute({
        kind: 'join',
        classSessionId: context.meeting.id,
        deviceId: randomUUID(),
      });
      let finish: (reply: ClassroomReply) => void = () => {};
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const heartbeat = controller.readTeachingContext();
      const next = {
        ...context,
        activity: { ...context.activity, id: randomUUID() },
        attempt: { ...context.attempt, id: randomUUID() },
      };
      execute.mockResolvedValue({ kind: 'context', context: next });
      await controller.execute({
        kind: 'context',
        participationId: context.participation.id,
        deviceId: context.participation.deviceId,
        activityId: next.activity.id,
      });
      const rejected = expect(heartbeat).rejects.toThrow('unavailable');
      finish({ kind: 'context', context });
      await rejected;
      expect(controller.isContextCurrent(next)).toBe(true);
      expect(controller.isContextCurrent(context)).toBe(false);
    } finally {
      controller.dispose();
    }
  });
});

it('enables review only for live approved practice and clears it on context loss or disposal', async () => {
  const context = createTeachingContext();
  context.meeting.phase = 'practice';
  context.activity.practiceCheckpoints = [createPracticeCheckpoint()];
  const changed = vi.fn<(context: TeachingContext | null) => void>();
  const execute = vi.fn<ClassroomApi['execute']>().mockResolvedValue({ kind: 'context', context });
  const controller = new ClassroomSessionController({ execute }, () => {}, changed);
  try {
    await controller.execute({
      kind: 'join',
      classSessionId: context.meeting.id,
      deviceId: randomUUID(),
    });
    expect(controller.readPracticeContext()).toEqual(context);
    expect(changed).toHaveBeenLastCalledWith(context);
    execute.mockResolvedValue({
      kind: 'context',
      context: { ...context, meeting: { ...context.meeting, phase: 'review' } },
    });
    await controller.readTeachingContext();
    expect(controller.readPracticeContext()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
    execute.mockResolvedValue({
      kind: 'context',
      context: {
        ...context,
        participation: { ...context.participation, leaseUntil: new Date(0).toISOString() },
      },
    });
    await controller.readTeachingContext();
    expect(controller.readPracticeContext()).toBeNull();
    controller.dispose();
    expect(changed).toHaveBeenLastCalledWith(null);
  } finally {
    controller.dispose();
  }
});
