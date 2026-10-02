import { describe, expect, it, vi } from 'vitest';
import pino, { type Logger } from 'pino';
import { PassThrough } from 'node:stream';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AgentResultSchema } from '#contracts/AgentSession.js';
import { CuaTaskEvidence } from './CuaTaskEvidence.js';
import { TaskContext, TaskPhase } from './TaskContext.js';
import { TaskCompletionConfig, TaskTermination } from './TaskCompletionConfig.js';
import { TaskHarness } from './TaskHarness.js';
import type { MainAgentPort, VerificationPort } from './TaskExecutionPorts.js';
import { readCompletionAssessment } from './CompletionGate.js';
import { createVerificationEvidencePacket } from './TaskEvidencePacket.js';
import { TaskContextBudgetError } from './TaskContextBudget.js';

function createFixture(log?: Logger) {
  let time = 0;
  const user = new AbortController();
  const task = new TaskContext(
    new CuaTaskEvidence(),
    user.signal,
    TaskCompletionConfig,
    () => time,
    'Open YouTube on the external monitor',
  );
  task.evidence.setReadOnlyTools(['get_window_state', 'list_windows']);
  task.defineGoal({
    summary: 'Open YouTube',
    criteria: [{ description: 'YouTube loaded and visible' }],
  });
  task.admitModelTurn();
  const observe = (visible = true, text = 'Actual YouTube page', windowId = 12, image = false) => {
    const recorded = task.evidence.recordToolResult(
      task.evidence.beginToolCall('get_window_state'),
      { pid: 7, window_id: windowId },
      {
        content: [
          { type: 'text', text },
          ...(image
            ? [{ type: 'image' as const, data: 'dmVyaWZpZXItb25seQ==', mimeType: 'image/png' }]
            : []),
        ],
        structuredContent: { pid: 7, window_id: windowId, is_visible: visible },
      },
    );
    const id = recorded.observations[0]?.id;
    if (!id) {
      throw new Error('No fixture observation.');
    }
    return id;
  };
  const id = observe();
  const verdict = {
    decision: 'confirmed',
    summary: 'YouTube is open.',
    missingRequirements: [],
    criteria: [
      {
        criterionId: 'criterion-1',
        state: 'satisfied',
        evidenceIds: [id],
        explanation: 'The observed window shows YouTube.',
      },
    ],
  };
  const verifier = {
    verifyCurrentTask: vi.fn<VerificationPort['verifyCurrentTask']>().mockResolvedValue(verdict),
  } satisfies VerificationPort;
  const harness = new TaskHarness(
    task,
    DesktopLocale.ENGLISH,
    () => Promise.resolve(),
    verifier,
    log,
  );
  const main = {
    runFirstAttempt: vi.fn<MainAgentPort['runFirstAttempt']>().mockImplementation(async () => {
      await harness.requestVerification();
      return { mode: 'task', answer: 'Done.', verificationId: task.latestVerification?.id ?? null };
    }),
    continueWithFeedback: vi
      .fn<MainAgentPort['continueWithFeedback']>()
      .mockResolvedValue({ mode: 'task', answer: 'Done.', verificationId: null }),
    dispose: vi.fn<MainAgentPort['dispose']>(),
  } satisfies MainAgentPort;
  return {
    task,
    user,
    observe,
    id,
    verdict,
    verifier,
    harness,
    main,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('task harness completion and sequential controls', () => {
  it('logs verification and final gate rejection reasons without persisting evidence or answers', async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const fixture = createFixture(pino({ level: 'debug' }, output));
    fixture.verifier.verifyCurrentTask.mockResolvedValue({
      ...fixture.verdict,
      decision: 'needs_work',
    });
    await fixture.harness.run(fixture.main);
    const logs = lines.join('');
    expect(logs).toContain('agent.verification.started');
    expect(logs).toContain('agent.verification.context');
    expect(logs).toContain('agent.verification.finished');
    expect(logs).toContain('"diagnosticReason":"decision_inconsistent"');
    expect(logs).toContain('agent.continuation.started');
    expect(logs).toContain('"diagnosticReason":"verification_id_mismatch"');
    expect(logs).toContain('"packetObservationCount":1');
    expect(logs).not.toMatch(
      /Actual YouTube page|Open YouTube on the external monitor|YouTube is open|Done\./,
    );
  });
  it('allows SDK callback reentry, verifies once and settles once', async () => {
    const fixture = createFixture();
    const result = AgentResultSchema.parse(await fixture.harness.run(fixture.main));
    expect(result).toMatchObject({
      kind: 'completed',
      answer: 'Done.',
      completion: { kind: 'task', outcome: { status: 'succeeded' } },
    });
    expect(fixture.verifier.verifyCurrentTask).toHaveBeenCalledTimes(1);
    expect(fixture.main.continueWithFeedback).not.toHaveBeenCalled();
    expect(fixture.main.dispose).toHaveBeenCalledOnce();
    expect(fixture.task.phase).toBe(TaskPhase.SETTLED);
    expect(fixture.task.evidence.readSnapshot().observations).toEqual([]);
    expect(() => {
      fixture.task.admitToolCall(false);
    }).toThrow('ended');
    await expect(fixture.harness.requestVerification()).rejects.toThrow('ended');
    await expect(fixture.harness.run(fixture.main)).rejects.toThrow('already started');
  });

  it('blocks a second verification and mutations before the first asynchronous read', async () => {
    const fixture = createFixture();
    let release: ((value: unknown) => void) | undefined;
    fixture.verifier.verifyCurrentTask = vi
      .fn<VerificationPort['verifyCurrentTask']>()
      .mockImplementation(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      );
    try {
      const first = fixture.harness.requestVerification();
      expect(fixture.task.phase).toBe(TaskPhase.VERIFYING);
      expect(() => {
        fixture.task.admitToolCall(true);
      }).toThrow('read-only');
      await expect(fixture.harness.requestVerification()).rejects.toThrow('other verification');
      await Promise.resolve();
      expect(fixture.verifier.verifyCurrentTask).toHaveBeenCalledOnce();
      release?.(fixture.verdict);
      await first;
      expect(fixture.task.phase).toBe(TaskPhase.READY_TO_FINISH);
    } finally {
      fixture.task.dispose();
    }
  });

  it.each([
    { decision: 'confirmed', missingRequirements: ['Another requested page is missing'] },
    {
      decision: 'confirmed',
      criteria: [
        { criterionId: 'criterion-1', state: 'unknown', evidenceIds: [], explanation: 'No proof' },
      ],
    },
    {
      decision: 'confirmed',
      criteria: [
        {
          criterionId: 'criterion-1',
          state: 'unsatisfied',
          evidenceIds: [],
          explanation: 'Not done',
        },
      ],
    },
    { decision: 'blocked', missingRequirements: [] },
    { decision: 'needs_work', missingRequirements: [] },
    { decision: 'unknown', missingRequirements: [] },
    { requestSatisfied: true, blocked: true },
  ])('rejects inconsistent or legacy verdicts: %j', async (override) => {
    const fixture = createFixture();
    fixture.verifier.verifyCurrentTask = vi
      .fn<VerificationPort['verifyCurrentTask']>()
      .mockResolvedValue({ ...fixture.verdict, ...override });
    try {
      await fixture.harness.requestVerification();
      expect(fixture.task.latestVerification).toMatchObject({ status: 'unverified', supported: 0 });
      expect(fixture.task.phase).toBe(TaskPhase.WORKING);
    } finally {
      fixture.task.dispose();
    }
  });

  it('cannot accept an older visible snapshot after a newer hidden snapshot at the same revision', async () => {
    const fixture = createFixture();
    try {
      fixture.observe(false, 'Window is now hidden');
      await fixture.harness.requestVerification();
      expect(fixture.task.latestVerification?.status).toBe('unverified');
      expect(fixture.task.evidence.readSnapshot().revision).toBe(0);
      const packet = createVerificationEvidencePacket(fixture.task, DesktopLocale.ENGLISH);
      expect(packet.observations.map((item) => item.id)).not.toContain(fixture.id);
    } finally {
      fixture.task.dispose();
    }
  });

  it.each(['during verification', 'during final answer', 'after a newer capture'])(
    'rechecks evidence %s',
    async (stage) => {
      const fixture = createFixture();
      try {
        if (stage === 'during verification') {
          fixture.verifier.verifyCurrentTask = vi
            .fn<VerificationPort['verifyCurrentTask']>()
            .mockImplementation(() => {
              fixture.advance(TaskCompletionConfig.maximumEvidenceAgeMs + 1);
              return Promise.resolve(fixture.verdict);
            });
        }
        await fixture.harness.requestVerification();
        if (stage === 'during final answer') {
          fixture.advance(TaskCompletionConfig.maximumEvidenceAgeMs + 1);
        } else if (stage === 'after a newer capture') {
          fixture.observe(false);
        }
        const assessment = readCompletionAssessment(fixture.task, {
          mode: 'task',
          answer: 'Done',
          verificationId: fixture.task.latestVerification?.id ?? null,
        });
        expect(assessment.status).toBe('unverified');
        expect(fixture.verifier.verifyCurrentTask).toHaveBeenCalledTimes(1);
        expect(fixture.task.phase).toBe(TaskPhase.WORKING);
      } finally {
        fixture.task.dispose();
      }
    },
  );

  it('admits fresh verifier-only reads after expired evidence and reuses their content next time', async () => {
    const fixture = createFixture();
    fixture.advance(TaskCompletionConfig.maximumEvidenceAgeMs + 1);
    let attempt = 0;
    fixture.verifier.verifyCurrentTask = vi
      .fn<VerificationPort['verifyCurrentTask']>()
      .mockImplementation((packet) => {
        if (++attempt === 1) {
          expect(packet.content).toEqual([]);
          const id = fixture.observe(true, 'Only the verifier observed this content', 12, true);
          return Promise.resolve({
            ...fixture.verdict,
            criteria: fixture.verdict.criteria.map((claim) => ({ ...claim, evidenceIds: [id] })),
          });
        }
        expect(JSON.stringify(packet)).toContain('Only the verifier observed this content');
        expect(JSON.stringify(packet)).toContain('dmVyaWZpZXItb25seQ==');
        expect(JSON.stringify(packet)).not.toContain('YouTube is open.');
        const id = packet.observations[0]?.id ?? 'missing';
        return Promise.resolve({
          ...fixture.verdict,
          criteria: fixture.verdict.criteria.map((claim) => ({ ...claim, evidenceIds: [id] })),
        });
      });
    try {
      await fixture.harness.requestVerification();
      await fixture.harness.requestVerification();
      expect(fixture.task.latestVerification?.status).toBe('succeeded');
      await fixture.harness.requestVerification();
      expect(fixture.verifier.verifyCurrentTask).toHaveBeenCalledTimes(2);
    } finally {
      fixture.task.dispose();
    }
  });

  it('permits complementary visibility/content and distinct windows rather than merging by PID', async () => {
    const fixture = createFixture();
    try {
      fixture.observe(false, 'Different hidden window', 13);
      const evidence = fixture.task.evidence;
      evidence.recordToolResult(
        evidence.beginToolCall('get_window_state'),
        { pid: 8, window_id: 19 },
        {
          content: [{ type: 'text', text: 'Independent content' }],
          structuredContent: { pid: 8, window_id: 19 },
        },
      );
      const contentId = evidence.readSnapshot().observations.at(-1)?.id ?? 'missing';
      evidence.recordToolResult(evidence.beginToolCall('list_windows'), null, {
        content: [],
        structuredContent: { windows: [{ pid: 8, window_id: 19, is_on_screen: true }] },
      });
      expect(evidence.hasAdmissibleEvidence(fixture.id)).toBe(true);
      expect(evidence.hasAdmissibleEvidence(contentId)).toBe(true);
      await fixture.harness.requestVerification();
      expect(fixture.task.latestVerification?.status).toBe('succeeded');
    } finally {
      fixture.task.dispose();
    }
  });

  it('rejects overwritten explicit facts across observation categories', () => {
    const fixture = createFixture();
    try {
      fixture.task.evidence.recordToolResult(
        fixture.task.evidence.beginToolCall('list_windows'),
        null,
        {
          content: [],
          structuredContent: { windows: [{ pid: 7, window_id: 12, is_on_screen: false }] },
        },
      );
      expect(fixture.task.evidence.hasAdmissibleEvidence(fixture.id)).toBe(false);
    } finally {
      fixture.task.dispose();
    }
  });

  it('retains the locale, original request and immutable goal in evidence packets', () => {
    const fixture = createFixture();
    try {
      const packet = createVerificationEvidencePacket(fixture.task, DesktopLocale.VIETNAMESE);
      expect(packet).toMatchObject({
        locale: 'vi',
        originalRequest: 'Open YouTube on the external monitor',
        taskId: fixture.task.id,
      });
      expect(packet.goal.criteria[0]?.id).toBe('criterion-1');
      expect(JSON.stringify(packet.content)).toContain('Actual YouTube page');
    } finally {
      fixture.task.dispose();
    }
  });

  it('rejects a verdict belonging to another task', async () => {
    const fixture = createFixture();
    try {
      await fixture.harness.requestVerification();
      const other = new TaskContext(new CuaTaskEvidence(), new AbortController().signal);
      try {
        other.defineGoal({ summary: 'Other task', criteria: [{ description: 'Other result' }] });
        other.admitModelTurn();
        other.beginVerification();
        if (!fixture.task.latestVerification) {
          throw new Error('Missing fixture verdict.');
        }
        other.saveVerification(fixture.task.latestVerification);
        other.endVerification();
        expect(
          readCompletionAssessment(other, {
            mode: 'task',
            answer: 'Done',
            verificationId: fixture.task.latestVerification.id,
          }).status,
        ).toBe('unverified');
      } finally {
        other.dispose();
      }
    } finally {
      fixture.task.dispose();
    }
  });

  it('cancellation during verification cannot save a late success or start recovery', async () => {
    const fixture = createFixture();
    fixture.verifier.verifyCurrentTask = vi
      .fn<VerificationPort['verifyCurrentTask']>()
      .mockImplementation(() => {
        fixture.user.abort();
        return Promise.resolve(fixture.verdict);
      });
    expect(await fixture.harness.run(fixture.main)).toEqual({ kind: 'stopped' });
    expect(fixture.task.latestVerification).toBeNull();
    expect(fixture.task.phase).toBe(TaskPhase.STOPPED);
    expect(fixture.main.continueWithFeedback).not.toHaveBeenCalled();
  });

  it('context exhaustion settles unverified without more provider work', async () => {
    const fixture = createFixture();
    fixture.verifier.verifyCurrentTask = vi
      .fn<VerificationPort['verifyCurrentTask']>()
      .mockRejectedValue(new TaskContextBudgetError());
    const result = await fixture.harness.run(fixture.main);
    expect(result).toMatchObject({
      kind: 'completed',
      completion: { kind: 'task', outcome: { status: 'unverified' } },
    });
    expect(fixture.task.termination).toBe(TaskTermination.CONTEXT_LIMIT);
    expect(fixture.task.phase).toBe(TaskPhase.SETTLED);
    expect(fixture.main.continueWithFeedback).not.toHaveBeenCalled();
    expect(fixture.verifier.verifyCurrentTask).toHaveBeenCalledOnce();
  });
});
