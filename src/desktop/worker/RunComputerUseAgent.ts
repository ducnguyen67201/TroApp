import { run, type Agent, type AgentInputItem } from '@openai/agents';

export interface ComputerUseAnswer {
  answer: string | null;
  history: AgentInputItem[];
}

/** Contain the SDK output at the worker boundary; prose is never action evidence. */
export async function runComputerUseAgent(
  agent: Agent,
  input: string | AgentInputItem[],
  signal: AbortSignal,
  maxTurns: number,
): Promise<ComputerUseAnswer> {
  const result = await run(agent, input, { signal, maxTurns });
  const output: unknown = result.finalOutput;
  return { answer: typeof output === 'string' ? output : null, history: result.history };
}
