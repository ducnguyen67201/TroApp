import { Agent } from '@openai/agents';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { createComputerUseInstructions } from './ComputerUseInstructions.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

/** Cua publishes its own tool catalog over MCP; Tro does not map actions. */
export function createComputerUseAgent(
  desktopServer: LoggedCuaServer,
  locale: DesktopLocale,
  mode: AgentTaskMode = AgentTaskMode.EXECUTE,
): Agent {
  return new Agent({
    name: 'Tro computer-use assistant',
    model: 'gpt-5.4',
    instructions: createComputerUseInstructions(locale, mode),
    ...(mode === AgentTaskMode.TEACH ? { modelSettings: { parallelToolCalls: false } } : {}),
    mcpServers: [desktopServer],
    mcpConfig: { convertSchemasToStrict: false },
  });
}
