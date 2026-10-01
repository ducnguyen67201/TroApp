import { Agent, type MCPServerStdio } from '@openai/agents';
import { ComputerUseInstructions } from './ComputerUseInstructions.js';

/** Cua publishes its own tool catalog over MCP; Tro does not map actions. */
export function createComputerUseAgent(desktopServer: MCPServerStdio): Agent {
  return new Agent({
    name: 'Tro computer-use assistant',
    model: 'gpt-5.4',
    instructions: ComputerUseInstructions,
    mcpServers: [desktopServer],
  });
}
