import { Agent, Usage, setTracingDisabled, type Model } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { runComputerUseAgent } from '../../../../src/desktop/worker/agent/RunComputerUseAgent.js';
import {
  TeachingReplySchema,
  TeachingDisposition,
} from '../../../../src/desktop/worker/teaching/TeachingReply.js';
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
    const result = await runComputerUseAgent(
      agent,
      'Open YouTube',
      new AbortController().signal,
      1,
    );
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
