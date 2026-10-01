import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCPServerStdio, mcpToFunctionTool } from '@openai/agents';
import { chooseCuaDriverCommand } from '../src/desktop/worker/ChooseCuaDriverCommand.js';

/** Print the MCP tool schema and the actual Agents SDK conversion locally.
 * This inspects tool definitions only; it never calls a desktop action. */
async function inspectCuaMcpSchema(): Promise<void> {
  const toolName = process.argv[2] ?? 'browser_click';
  const homeDirectory = homedir();
  const installation = await chooseCuaDriverCommand({
    resourcesPath: join(homeDirectory, '.cache', 'tro'),
    homeDirectory,
    platform: process.platform,
  });
  const server = new MCPServerStdio({
    name: 'Cua Driver schema inspector',
    command: installation.command,
    args: ['mcp'],
  });

  try {
    await server.connect();
    const tools = await server.listTools();

    if (toolName === '--list') {
      console.log(tools.map((tool) => tool.name).join('\n'));
      return;
    }

    const mcpTool = tools.find((tool) => tool.name === toolName);
    if (!mcpTool) {
      throw new Error(`Cua did not publish "${toolName}". Run with --list to see tool names.`);
    }

    /* Use the same public SDK converter as the agent, with its default
       non-strict setting. The SDK may emit its own fallback warning here. */
    const agentTool = mcpToFunctionTool(mcpTool, server, false);
    const mcpInputSchema: unknown = mcpTool.inputSchema;
    const agentParameters: unknown = agentTool.parameters;
    console.log(
      JSON.stringify(
        {
          tool: mcpTool.name,
          mcpInputSchema,
          agentTool: {
            name: agentTool.name,
            strict: agentTool.strict,
            parameters: agentParameters,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
  }
}

void inspectCuaMcpSchema().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Cua schema inspection failed.');
  process.exitCode = 1;
});
