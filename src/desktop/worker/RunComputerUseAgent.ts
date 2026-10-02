import { run, type Agent, type AgentInputItem } from '@openai/agents';
import { TeachingReplySchema, type TeachingReplyKind } from './TeachingReply.js';

export interface ComputerUseAnswer {
  answer: string | null;
  history: AgentInputItem[];
  replyKind?: TeachingReplyKind;
}

/** Contain the SDK output at the worker boundary; prose is never action evidence. */
export async function runComputerUseAgent(
  agent: Agent<unknown, typeof TeachingReplySchema>,
  input: string | AgentInputItem[],
  signal: AbortSignal,
  maxTurns: number,
): Promise<ComputerUseAnswer> {
  const result = await run(agent, input, { signal, maxTurns });
  const output: unknown = result.finalOutput;
  const reply = TeachingReplySchema.safeParse(output);
  return reply.success
    ? { answer: reply.data.answer, replyKind: reply.data.kind, history: result.history }
    : { answer: null, history: result.history };
}
