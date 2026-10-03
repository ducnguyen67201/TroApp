import { MCPServerStdio } from '@openai/agents';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { TaskContext } from '../../../../src/desktop/worker/execution/TaskContext.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { TaskCompletionConfig } from '../../../../src/desktop/worker/execution/TaskCompletionConfig.js';
import {
  TaskVerifier,
  type RunTaskVerifier,
} from '../../../../src/desktop/worker/execution/TaskVerifier.js';
import { TaskHarness } from '../../../../src/desktop/worker/execution/TaskHarness.js';
import { readCompletionAssessment } from '../../../../src/desktop/worker/execution/CompletionGate.js';
import type { TaskVerification } from '../../../../src/desktop/worker/execution/TaskVerification.js';
import { createTaskResult } from '../../../../src/desktop/worker/execution/TaskResult.js';

async function requestVerification(
  task: TaskContext,
  server: LoggedCuaServer,
  locale: DesktopLocale,
  runVerifier: RunTaskVerifier,
): Promise<TaskVerification> {
  const harness = new TaskHarness(
    task,
    locale,
    () => server.settleCalls(),
    new TaskVerifier(task, server, locale, runVerifier),
  );
  await harness.requestVerification();
  const verification = task.latestVerification;
  if (!verification) {
    throw new Error('No stored verification.');
  }
  return verification;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function createFixture() {
  const server = new LoggedCuaServer(
    { name: 'verifier fixture', command: 'unused' },
    pino({ level: 'silent' }),
  );
  const task = new TaskContext(
    server.taskEvidence,
    new AbortController().signal,
    TaskCompletionConfig,
    undefined,
    'Open YouTube on my external monitor',
  );
  server.bindTask(task);
  task.evidence.setReadOnlyTools(['get_window_state']);
  task.defineGoal({
    summary: 'Show YouTube',
    criteria: [{ description: 'YouTube is open and visible to the user' }],
  });
  task.admitModelTurn();
  const observe = () => {
    const observations = task.evidence.recordToolResult(
      task.evidence.beginToolCall('get_window_state'),
      { pid: 7, window_id: 12 },
      {
        content: [{ type: 'text', text: 'YouTube home loaded' }],
        structuredContent: { pid: 7, window_id: 12 },
      },
    ).observations;
    const id = observations[0]?.id;
    if (!id) {
      throw new Error('Missing fixture observation.');
    }
    return id;
  };
  const id = observe();
  const verdict = {
    summary: 'Đã mở YouTube.',
    decision: 'confirmed',
    missingRequirements: [],
    criteria: [
      {
        criterionId: 'criterion-1',
        state: 'satisfied',
        evidenceIds: [id],
        explanation: 'The correct window shows YouTube.',
      },
    ],
  };
  return { task, server, verdict, observe };
}

describe('LLM task verification with a local provenance gate', () => {
  it('runs a read-only model only when explicitly invoked, passing original request and observed content', async () => {
    const fixture = createFixture();
    const runVerifier = vi.fn<RunTaskVerifier>().mockImplementation((agent, input, task, turns) => {
      expect(agent.name).toBe('Tro task verifier');
      expect(agent.instructions).toContain('Vietnamese');
      expect(agent.tools).toEqual([]);
      expect(JSON.stringify(input)).toContain('Open YouTube on my external monitor');
      expect(JSON.stringify(input)).toContain('YouTube home loaded');
      expect(JSON.stringify(input)).toContain('criterion-1');
      expect(task.isVerifying).toBe(true);
      expect(() => {
        task.admitToolCall(true);
      }).toThrow('read-only');
      expect(turns).toBe(3);
      return Promise.resolve(fixture.verdict);
    });
    try {
      expect(runVerifier).not.toHaveBeenCalled();
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.VIETNAMESE,
        runVerifier,
      );
      expect(verification).toMatchObject({
        id: 'verification-1',
        status: 'succeeded',
        supported: 1,
      });
      expect(fixture.task.isVerifying).toBe(false);
      const assessment = readCompletionAssessment(fixture.task, {
        mode: 'task',
        answer: 'Đã mở YouTube.',
        verificationId: verification.id,
      });
      expect(assessment.status).toBe(TaskOutcomeStatus.SUCCEEDED);
      expect(runVerifier).toHaveBeenCalledTimes(1);
    } finally {
      fixture.task.dispose();
    }
  });

  it.each(['forged-id', 'evidence-call-1-1'])('rejects forged or stale evidence %s', async (id) => {
    const fixture = createFixture();
    try {
      fixture.task.evidence.recordToolResult(
        fixture.task.evidence.beginToolCall('click'),
        {},
        { content: [] },
      );
      const verdict = {
        ...fixture.verdict,
        criteria: fixture.verdict.criteria.map((criterion) => ({
          ...criterion,
          evidenceIds: [id],
        })),
      };
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () => Promise.resolve(verdict),
      );
      expect(verification).toMatchObject({ status: 'unverified', supported: 0 });
    } finally {
      fixture.task.dispose();
    }
  });

  it('does not treat empty snapshots as proof even if the model says satisfied', async () => {
    const fixture = createFixture();
    try {
      const [empty] = fixture.task.evidence.recordToolResult(
        fixture.task.evidence.beginToolCall('get_window_state'),
        { pid: 7, window_id: 12 },
        {
          content: [{ type: 'text', text: JSON.stringify({ elements: [], tree_markdown: '' }) }],
          structuredContent: { pid: 7, window_id: 12 },
        },
      ).observations;
      const verdict = {
        ...fixture.verdict,
        criteria: fixture.verdict.criteria.map((criterion) => ({
          ...criterion,
          evidenceIds: [empty?.id ?? 'missing'],
        })),
      };
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () => Promise.resolve(verdict),
      );
      expect(verification.status).toBe('unverified');
    } finally {
      fixture.task.dispose();
    }
  });

  it.each(['missing', 'duplicate', 'invalid'])('rejects a %s verdict', async (kind) => {
    const fixture = createFixture();
    try {
      const output: unknown =
        kind === 'invalid'
          ? { done: true }
          : {
              ...fixture.verdict,
              criteria:
                kind === 'missing'
                  ? []
                  : [...fixture.verdict.criteria, ...fixture.verdict.criteria],
            };
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () => Promise.resolve(output),
      );
      expect(verification.status).toBe('unverified');
    } finally {
      fixture.task.dispose();
    }
  });

  it('does not accept an actor goal that omitted part of the original request', async () => {
    const fixture = createFixture();
    try {
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () =>
          Promise.resolve({
            ...fixture.verdict,
            decision: 'unknown',
            missingRequirements: ['External monitor visibility is not established.'],
            summary: 'External monitor visibility was not confirmed.',
          }),
      );
      expect(verification).toMatchObject({
        status: 'unverified',
        supported: 0,
        needsRecovery: true,
      });
      expect(verification.limitation).toContain('External monitor');
    } finally {
      fixture.task.dispose();
    }
  });

  it('reports partial results and uses the verifier summary rather than unsupported Done', async () => {
    const fixture = createFixture();
    fixture.task.dispose();
    const task = new TaskContext(fixture.server.taskEvidence, new AbortController().signal);
    fixture.server.bindTask(task);
    try {
      task.defineGoal({
        summary: 'Show two pages',
        criteria: [{ description: 'YouTube visible' }, { description: 'Mail visible' }],
      });
      task.admitModelTurn();
      const id = fixture.observe();
      const verification = await requestVerification(
        task,
        fixture.server,
        DesktopLocale.VIETNAMESE,
        () =>
          Promise.resolve({
            ...fixture.verdict,
            decision: 'unknown',
            summary: 'Đã mở YouTube; chưa xác nhận Mail.',
            criteria: [
              {
                criterionId: 'criterion-1',
                state: 'satisfied',
                evidenceIds: [id],
                explanation: 'YouTube visible.',
              },
              {
                criterionId: 'criterion-2',
                state: 'unknown',
                evidenceIds: [],
                explanation: 'Mail not observed.',
              },
            ],
          }),
      );
      expect(verification).toMatchObject({ status: 'partial', required: 2, supported: 1 });
      const proposal = { mode: 'task' as const, answer: 'Done!', verificationId: verification.id };
      const result = createTaskResult(
        readCompletionAssessment(task, proposal),
        proposal,
        DesktopLocale.VIETNAMESE,
      );
      expect(result).toMatchObject({
        answer: 'Đã mở YouTube; chưa xác nhận Mail.',
        completion: { kind: 'task', outcome: { status: 'partial' } },
      });
    } finally {
      task.dispose();
    }
  });

  it('accepts an observed blocker without starting another recovery', async () => {
    const fixture = createFixture();
    try {
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () =>
          Promise.resolve({
            summary: 'Screen access was denied.',
            decision: 'blocked',
            missingRequirements: [],
            criteria: [
              {
                criterionId: 'criterion-1',
                state: 'unknown',
                evidenceIds: [],
                explanation: 'No permission to observe.',
              },
            ],
          }),
      );
      expect(verification).toMatchObject({ status: 'blocked', needsRecovery: false });
    } finally {
      fixture.task.dispose();
    }
  });

  it('allows targeted verifier observations but denies writes at the transport boundary', async () => {
    const fixture = createFixture();
    const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
      content: [{ type: 'text', text: 'Fresh YouTube content' }],
      structuredContent: { pid: 7, window_id: 12 },
    });
    try {
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        async () => {
          const write = await fixture.server.callToolResult('click', {});
          expect(write.isError).toBe(true);
          await fixture.server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
          const id = fixture.task.evidence.readSnapshot().observations.at(-1)?.id;
          return {
            ...fixture.verdict,
            criteria: fixture.verdict.criteria.map((criterion) => ({
              ...criterion,
              evidenceIds: [id ?? 'missing'],
            })),
          };
        },
      );
      expect(verification.status).toBe('succeeded');
      expect(driver).toHaveBeenCalledTimes(1);
      expect(driver.mock.calls[0]?.[0]).toBe('get_window_state');
    } finally {
      fixture.task.dispose();
    }
  });

  it('invalidates a verdict after later mutations and rejects fabricated verdict IDs', async () => {
    const fixture = createFixture();
    try {
      const verification = await requestVerification(
        fixture.task,
        fixture.server,
        DesktopLocale.ENGLISH,
        () => Promise.resolve(fixture.verdict),
      );
      expect(
        readCompletionAssessment(fixture.task, {
          mode: 'task',
          answer: 'Done',
          verificationId: 'invented',
        }).status,
      ).toBe('unverified');
      fixture.task.evidence.recordToolResult(
        fixture.task.evidence.beginToolCall('hotkey'),
        {},
        { content: [] },
      );
      expect(
        readCompletionAssessment(fixture.task, {
          mode: 'task',
          answer: 'Done',
          verificationId: verification.id,
        }).status,
      ).toBe('unverified');
    } finally {
      fixture.task.dispose();
    }
  });

  it('caps verification attempts and propagates cancellation', async () => {
    const fixture = createFixture();
    const user = new AbortController();
    try {
      const runVerifier = vi.fn<RunTaskVerifier>().mockResolvedValue(fixture.verdict);
      await requestVerification(fixture.task, fixture.server, DesktopLocale.ENGLISH, runVerifier);
      await requestVerification(fixture.task, fixture.server, DesktopLocale.ENGLISH, runVerifier);
      await requestVerification(fixture.task, fixture.server, DesktopLocale.ENGLISH, runVerifier);
      expect(runVerifier).toHaveBeenCalledTimes(2);
      const task = new TaskContext(fixture.server.taskEvidence, user.signal);
      try {
        task.defineGoal({
          summary: 'Open YouTube',
          criteria: [{ description: 'YouTube visible' }],
        });
        task.admitModelTurn();
        await expect(
          requestVerification(task, fixture.server, DesktopLocale.ENGLISH, () => {
            user.abort();
            return Promise.resolve(fixture.verdict);
          }),
        ).rejects.toThrow();
        expect(task.latestVerification).toBeNull();
        expect(task.isVerifying).toBe(false);
      } finally {
        task.dispose();
      }
    } finally {
      fixture.task.dispose();
    }
  });
});
