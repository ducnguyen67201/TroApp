import {
  TaskModelClient,
  runWithTaskModel,
} from '../../../../src/desktop/worker/agent/TaskModelClient.js';
import { Agent, Usage, setTracingDisabled, type Model } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { runComputerUseAgent } from '../../../../src/desktop/worker/agent/RunComputerUseAgent.js';
import {
  TeachingReplySchema,
  EnrichedTeachingReplySchema,
  TeachingDisposition,
} from '../../../../src/desktop/worker/teaching/TeachingReply.js';
import { randomUUID } from 'node:crypto';
import {
  PreparedTaskContext,
  type TaskContextPort,
} from '../../../../src/desktop/worker/context/PrepareTaskContext.js';
it.each(Object.values(TeachingDisposition))(
  'validates the %s decision through the real SDK without flattening history',
  async (disposition) => {
    setTracingDisabled(true);
    const decision = {
      disposition,
      presentationId: null,
      goalRevisionId: null,
      captureId: 'current',
      observationSummary: 'Current screen',
      message: 'Question or completion',
      reason: null,
      goalEvidence: [],
    };
    const getResponse = vi.fn<Model['getResponse']>().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(decision) }],
        },
      ],
      usage: new Usage(),
    });
    const model: Model = {
      getResponse,
      getStreamedResponse() {
        throw new Error('No streaming in this test');
      },
    };
    const agent = new Agent({ name: 'Teaching fixture', model, outputType: TeachingReplySchema });
    const scope = new TaskModelClient('fixture', 'http://127.0.0.1', vi.fn<typeof fetch>());
    const result = await runWithTaskModel(scope, () =>
      runComputerUseAgent(agent, 'Open YouTube', new AbortController().signal, 1),
    );
    scope.dispose();
    expect(result.decision).toEqual(decision);
    expect(result.history).toHaveLength(2);
    expect(getResponse).toHaveBeenCalledOnce();
  },
);
it('rejects old chat-only guidance and unknown dispositions', () => {
  expect(TeachingReplySchema.safeParse({ kind: 'guide', answer: 'Click there' }).success).toBe(
    false,
  );
  expect(TeachingReplySchema.safeParse({ disposition: 'explanation' }).success).toBe(false);
});

it.each([false, true])(
  'updates memory in the existing SDK call; malformed optional memory=%s never triggers repair',
  async (malformed) => {
    const sourceId = randomUUID();
    const sessionId = randomUUID();
    const request = vi.fn<TaskContextPort['request']>().mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'resolve'
          ? {
              kind: 'packet',
              packet: {
                generation: 1,
                sessionId,
                eventRevision: 1,
                checkpoint: null,
                activity: [],
                gaps: [],
                nextCursor: null,
                sources: [
                  {
                    id: sourceId,
                    resource: 'Scratch',
                    text: 'repeat 10',
                    digest: 'fixture',
                    observedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                  },
                ],
              },
            }
          : { kind: 'accepted', revision: 1 },
      ),
    );
    const context = new PreparedTaskContext(
      { scope: { enabled: true, available: true, generation: 1, sessionId }, request },
      new AbortController().signal,
    );
    await context.prepareTaskContext('Why?');
    const decision = {
      disposition: TeachingDisposition.ASK,
      presentationId: null,
      goalRevisionId: null,
      captureId: 'current',
      observationSummary: 'Current screen',
      message: 'Which sprite?',
      reason: null,
      goalEvidence: [],
    };
    const checkpointUpdate = malformed
      ? 'invalid optional enrichment'
      : {
          expectedRevision: 0,
          coveredEventRevision: 1,
          sourceIds: [sourceId],
          summary: 'Working on repeats',
          claims: [],
          openQuestions: ['Which sprite?'],
        };
    const getResponse = vi.fn<Model['getResponse']>().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: JSON.stringify({ ...decision, checkpointUpdate }) },
          ],
        },
      ],
      usage: new Usage(),
    });
    const model: Model = {
      getResponse,
      getStreamedResponse() {
        throw new Error('No streaming in this fixture.');
      },
    };
    const agent = new Agent<
      unknown,
      typeof TeachingReplySchema | typeof EnrichedTeachingReplySchema
    >({ name: 'Enriched teaching fixture', model, outputType: EnrichedTeachingReplySchema });
    const scope = new TaskModelClient('fixture', 'http://127.0.0.1', vi.fn<typeof fetch>());
    try {
      const result = await runWithTaskModel(scope, () =>
        runComputerUseAgent(
          agent,
          context.buildMemoryInput(),
          new AbortController().signal,
          1,
          context,
        ),
      );
      await context.settle();
      expect(result.decision).toEqual(decision);
      expect(getResponse).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([command]) => command.kind === 'checkpoint')).toHaveLength(
        malformed ? 0 : 1,
      );
    } finally {
      scope.dispose();
    }
  },
);
