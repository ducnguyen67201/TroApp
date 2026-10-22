import { readTaskModelRunner } from './TaskModelClient.js';
import { type AgentInputItem } from '@openai/agents';
import type { createTeachingAgent } from './CreateComputerUseAgent.js';
import { readCheckpointOutput } from '../context/ReadCheckpointOutput.js';
import type { PreparedTaskContext } from '../context/PrepareTaskContext.js';
import { TeachingReplySchema, type TeachingDecision } from '../teaching/TeachingReply.js';
export interface ComputerUseAnswer {
  decision: TeachingDecision | null;
  history: AgentInputItem[];
}

/** Validate provider output; keep provider tool/result pairs intact. */
export async function runComputerUseAgent(
  agent: ReturnType<typeof createTeachingAgent>,
  input: string | AgentInputItem[],
  signal: AbortSignal,
  maxTurns: number,
  context?: PreparedTaskContext,
): Promise<ComputerUseAnswer> {
  const result = await readTaskModelRunner().run(agent, input, { signal, maxTurns });
  const output: unknown = readCheckpointOutput(result.finalOutput, context);
  const parsed = TeachingReplySchema.safeParse(output);
  return { decision: parsed.success ? parsed.data : null, history: result.history };
}
