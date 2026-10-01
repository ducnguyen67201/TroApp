import { Agent } from '@openai/agents';
import { ComputerUseInstructions } from './ComputerUseInstructions.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

/** Cua publishes its own tool catalog over MCP; Tro does not map actions. */
export function createComputerUseAgent(desktopServer: LoggedCuaServer): Agent {
  return new Agent({
    name: 'Tro computer-use assistant',
    model: 'gpt-5.4',
    instructions: ComputerUseInstructions,
    mcpServers: [desktopServer],
    mcpConfig: { convertSchemasToStrict: false },
  });
}
