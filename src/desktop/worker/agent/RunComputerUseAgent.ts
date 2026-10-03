import { run, type Agent, type AgentInputItem } from '@openai/agents';
import { TeachingReplySchema, type TeachingDecision } from '../teaching/TeachingReply.js';
export interface ComputerUseAnswer {
  decision: TeachingDecision | null;
  history: AgentInputItem[];
}

/** Validate provider output; keep provider tool/result pairs intact. */
export async function runComputerUseAgent(
  agent: Agent<unknown, typeof TeachingReplySchema>,
  input: string | AgentInputItem[],
  signal: AbortSignal,
  maxTurns: number,
): Promise<ComputerUseAnswer> {
  const result = await run(agent, input, { signal, maxTurns });
  const output: unknown = result.finalOutput;
  const parsed = TeachingReplySchema.safeParse(output);
  return { decision: parsed.success ? parsed.data : null, history: result.history };
}
