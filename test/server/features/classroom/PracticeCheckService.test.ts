import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PracticeFinding,
  PracticeLimits,
  type PracticeCommand,
  type PracticeEvaluation,
} from '#contracts/PracticeCheck.js';
import { PracticeCheckService } from '../../../../src/server/features/classroom/application/PracticeCheckService.js';
import type { PracticeCheckEvaluator } from '../../../../src/server/features/classroom/application/PracticeCheckEvaluator.js';
import { validatePracticeFindings } from '../../../../src/server/features/classroom/domain/PracticeFindings.js';
import { describePracticeEvidence } from '../../../../src/server/features/classroom/application/PracticeEvidence.js';
import { createPracticeCheckpoint, MemoryPracticeStore } from './PracticeFixtures.js';

function fixture() {
  const store = new MemoryPracticeStore();
  let now = new Date('2026-10-05T12:00:00Z');
  const evaluate = vi
    .fn<PracticeCheckEvaluator['evaluate']>()
    .mockImplementation((rubric, evidence) =>
      Promise.resolve({
        results: rubric.criteria.map((criterion) => ({
          criterionId: criterion.id,
          finding: criterion.required ? PracticeFinding.MET : PracticeFinding.INSUFFICIENT_EVIDENCE,
          feedback: 'Observable greeting.',
          evidenceIds: criterion.required ? evidence.map((item) => item.id) : [],
        })),
      }),
    );
  const service = new PracticeCheckService(
    store,
    { available: true, version: 'fake/v1', evaluate },
    { dailyChecks: 30, minuteChecks: 5 },
    () => now,
  );
  const checkpoint = store.access.activity.practiceCheckpoints?.[0];
  if (!checkpoint) {
    throw new Error('Missing checkpoint.');
  }
  const command: Extract<PracticeCommand, { kind: 'check' }> = {
    kind: 'check',
    participationId: store.access.participationId,
    deviceId: store.access.deviceId,
    activityId: store.access.activity.id,
    contextVersion: 1,
    progressVersion: 0,
    checkpointId: checkpoint.id,
    requestId: randomUUID(),
    locale: 'en',
    evidence: [{ id: randomUUID(), kind: 'text', name: 'Greeting.txt', text: 'Hello' }],
  };
  return {
    store,
    service,
    evaluate,
    command,
    checkpoint,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('practice aggregation', () => {
  it('ignores optional gaps but rejects unknown required evidence', () => {
    const rubric = createPracticeCheckpoint();
    const id = randomUUID();
    const evaluation: PracticeEvaluation = {
      results: rubric.criteria.map((criterion) => ({
        criterionId: criterion.id,
        finding: criterion.required ? PracticeFinding.MET : PracticeFinding.NEEDS_CHANGES,
        feedback: 'Observed',
        evidenceIds: [id],
      })),
    };
    expect(validatePracticeFindings(rubric, evaluation, [id])).toBe(PracticeFinding.MET);
    evaluation.results = evaluation.results.map((result) => ({
      ...result,
      finding: PracticeFinding.INSUFFICIENT_EVIDENCE,
      evidenceIds: [],
    }));
    expect(validatePracticeFindings(rubric, evaluation, [id])).toBe(
      PracticeFinding.INSUFFICIENT_EVIDENCE,
    );
  });
  it('rejects missing, duplicate, foreign criteria and unsupported pass evidence', () => {
    const rubric = createPracticeCheckpoint();
    const criterion = rubric.criteria[0];
    if (!criterion) {
      throw new Error('Missing criterion.');
    }
    const result = {
      criterionId: criterion.id,
      finding: PracticeFinding.MET,
      feedback: 'Observed',
      evidenceIds: [randomUUID()],
    };
    for (const results of [
      [result],
      [result, result],
      rubric.criteria.map((item) => ({ ...result, criterionId: item.id })),
    ]) {
      expect(() => validatePracticeFindings(rubric, { results }, [])).toThrow('invalid');
    }
  });
});
it('rejects malformed or duplicated evidence before inference', () => {
  const id = randomUUID();
  expect(() =>
    describePracticeEvidence([
      {
        id,
        kind: 'image',
        name: 'bad.png',
        mediaType: 'image/png',
        base64: Buffer.from('not an image').toString('base64'),
      },
    ]),
  ).toThrow('invalid');
  expect(() =>
    describePracticeEvidence([
      { id, kind: 'text', name: 'a', text: 'hi' },
      { id, kind: 'text', name: 'b', text: 'hi' },
    ]),
  ).toThrow('invalid');
});
it('stores immutable evidence, evaluates once, and returns the same check on retries', async () => {
  const { service, store, command, evaluate } = fixture();
  const first = await service.execute('student', command);
  const retry = await service.execute('student', command);
  expect(retry).toEqual(first);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(store.checks.size).toBe(1);
  expect(first.kind === 'check' && first.check.finding).toBe('met');
  await expect(
    service.execute('student', {
      ...command,
      evidence: [{ id: randomUUID(), kind: 'text', name: 'Changed', text: 'Different' }],
    }),
  ).rejects.toThrow('stale');
});
it('a concurrent retry returns running without dispatching a second model call', async () => {
  const { service, command, evaluate } = fixture();
  let finish: (value: PracticeEvaluation) => void = () => {};
  evaluate.mockImplementation(
    (rubric, evidence) =>
      new Promise((resolve) => {
        finish = () => {
          resolve({
            results: rubric.criteria.map((criterion) => ({
              criterionId: criterion.id,
              finding: 'met',
              feedback: 'Observed',
              evidenceIds: evidence.map((item) => item.id),
            })),
          });
        };
      }),
  );
  const first = service.execute('student', command);
  await vi.waitFor(() => {
    expect(evaluate).toHaveBeenCalledOnce();
  });
  const duplicate = await service.execute('student', command);
  expect(duplicate.kind === 'check' && duplicate.check.status).toBe('running');
  finish({ results: [] });
  await first;
  expect(evaluate).toHaveBeenCalledOnce();
});
it.each([
  'studentId',
  'deleted',
  'enrolled',
  'deviceId',
  'leaseUntil',
  'left',
  'status',
  'phase',
  'currentActivityId',
  'contextVersion',
  'progressVersion',
] as const)('refuses unauthorized or stale %s before spending', async (field) => {
  const { service, store, command, evaluate } = fixture();
  switch (field) {
    case 'studentId':
      store.access.studentId = 'other';
      break;
    case 'deleted':
      store.access.deleted = true;
      break;
    case 'enrolled':
      store.access.enrolled = false;
      break;
    case 'deviceId':
      store.access.deviceId = randomUUID();
      break;
    case 'leaseUntil':
      store.access.leaseUntil = new Date('2000-01-01');
      break;
    case 'left':
      store.access.left = true;
      break;
    case 'status':
      store.access.status = 'ended';
      break;
    case 'phase':
      store.access.phase = 'explanation';
      break;
    case 'currentActivityId':
      store.access.currentActivityId = randomUUID();
      break;
    case 'contextVersion':
      store.access.contextVersion += 1;
      break;
    case 'progressVersion':
      store.access.progressVersion += 1;
      break;
  }
  await expect(service.execute('student', command)).rejects.toThrow();
  expect(evaluate).not.toHaveBeenCalled();
  expect(store.checks.size).toBe(0);
});
it('unapproved checkpoints do not run and missing legacy rubrics do not become invented checks', async () => {
  const { service, store, command, evaluate } = fixture();
  store.access.activity.practiceCheckpoints = [];
  await expect(service.execute('student', command)).rejects.toThrow('forbidden');
  expect(evaluate).not.toHaveBeenCalled();
});
it('reserves the allowance before dispatch and fails invalid model references safely', async () => {
  const { service, store, command, evaluate } = fixture();
  evaluate.mockResolvedValue({
    results: [
      { criterionId: randomUUID(), finding: 'met', feedback: 'Ignore rubric', evidenceIds: [] },
    ],
  });
  for (let index = 0; index < 5; index += 1) {
    const reply = await service.execute('student', {
      ...command,
      requestId: randomUUID(),
      evidence: command.evidence.map((item) => ({ ...item, id: randomUUID() })),
    });
    expect(reply.kind === 'check' && reply.check.status).toBe('failed');
  }
  await expect(service.execute('student', { ...command, requestId: randomUUID() })).rejects.toThrow(
    'limit',
  );
  expect(evaluate).toHaveBeenCalledTimes(5);
  expect(store.checks.size).toBe(5);
});
it('fences output after a teacher version change and never turns provider failure into correctness', async () => {
  const { service, store, command, evaluate } = fixture();
  evaluate.mockImplementation(() => {
    store.access.contextVersion += 1;
    return Promise.resolve({ results: [] });
  });
  const reply = await service.execute('student', command);
  expect(reply.kind === 'check' && reply.check.status).toBe('failed');
  expect(reply.kind === 'check' && reply.check.finding).toBeNull();
});
it('expires abandoned checks and fences late output', async () => {
  const { service, store, command, evaluate, advance } = fixture();
  let finish: (value: PracticeEvaluation) => void = () => {};
  evaluate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.execute('student', command);
  await vi.waitFor(() => {
    expect(store.checks.size).toBe(1);
  });
  advance(PracticeLimits.LEASE_MS + 1);
  const history = await service.execute('student', {
    kind: 'history',
    participationId: command.participationId,
    deviceId: command.deviceId,
    activityId: command.activityId,
  });
  expect(history.kind === 'history' && history.checks[0]?.status).toBe('failed');
  finish({ results: [] });
  await pending;
  expect([...store.checks.values()][0]?.record.status).toBe('failed');
});
it('appends exact-snapshot hand-ins, including needs-changes work, with idempotent receipts', async () => {
  const { service, store, command, evaluate } = fixture();
  evaluate.mockImplementation((rubric, evidence) =>
    Promise.resolve({
      results: rubric.criteria.map((criterion) => ({
        criterionId: criterion.id,
        finding: 'needs_changes',
        feedback: 'Improve greeting.',
        evidenceIds: evidence.map((item) => item.id),
      })),
    }),
  );
  const reply = await service.execute('student', command);
  if (reply.kind !== 'check') {
    throw new Error('Missing check.');
  }
  const submission: Extract<PracticeCommand, { kind: 'submit-snapshot' }> = {
    kind: 'submit-snapshot',
    participationId: command.participationId,
    deviceId: command.deviceId,
    activityId: command.activityId,
    contextVersion: 1,
    progressVersion: 0,
    checkId: reply.check.id,
    requestId: randomUUID(),
  };
  const first = await service.execute('student', submission);
  expect(first.kind === 'submitted' && first.submission.sequence).toBe(1);
  expect(await service.execute('student', submission)).toEqual(first);
  const second = await service.execute('student', { ...submission, requestId: randomUUID() });
  expect(second.kind === 'submitted' && second.submission.sequence).toBe(2);
  expect(store.submissions.size).toBe(2);
  store.access.phase = 'review';
  expect(await service.execute('student', submission)).toEqual(first);
  await expect(
    service.execute('student', { ...submission, requestId: randomUUID() }),
  ).rejects.toThrow('stale');
});
it('evidence and targeted help remain scoped to the authenticated relationship', async () => {
  const { service, command, store } = fixture();
  const reply = await service.execute('student', command);
  if (reply.kind !== 'check') {
    throw new Error('Missing check.');
  }
  await expect(
    service.execute('other', { kind: 'read-evidence', checkId: reply.check.id }),
  ).rejects.toThrow('forbidden');
  expect(
    (await service.execute('teacher', { kind: 'read-evidence', checkId: reply.check.id })).kind,
  ).toBe('evidence');
  const criterion = reply.check.rubric.criteria[0];
  if (!criterion) {
    throw new Error('Missing criterion.');
  }
  const help = await service.execute('student', {
    kind: 'help',
    participationId: command.participationId,
    deviceId: command.deviceId,
    activityId: command.activityId,
    checkId: reply.check.id,
    criterionId: criterion.id,
    locale: 'vi',
  });
  expect(help.kind === 'help' && help.message).toContain('Hãy quan sát');
  expect(store.submissions.size).toBe(0);
  store.access.enrolled = false;
  await expect(
    service.execute('student', { kind: 'read-evidence', checkId: reply.check.id }),
  ).rejects.toThrow('forbidden');
});
