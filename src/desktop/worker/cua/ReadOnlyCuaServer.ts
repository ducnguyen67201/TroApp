import type { MCPServer, MCPCallToolOptions, CallToolResult } from '@openai/agents';
import { CuaAdmissionReason, LoggedCuaServer } from './LoggedCuaServer.js';

const ObservationToolNames = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_accessibility_tree',
  'get_desktop_state',
  'get_browser_state',
  'verify_state',
]);

/** Borrow the existing transport without granting the verifier desktop writes. */
export class ReadOnlyCuaServer implements MCPServer {
  cacheToolsList = false;
  readonly name = 'Cua task observations';

  constructor(private readonly desktopServer: LoggedCuaServer) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  invalidateToolsCache(): Promise<void> {
    return Promise.resolve();
  }

  async listTools(): ReturnType<MCPServer['listTools']> {
    const tools = await this.desktopServer.listTools();
    return tools.filter((tool) => this.canObserve(tool.name));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): ReturnType<MCPServer['callTool']> {
    return (await this.callToolResult(toolName, args, meta, options)).content;
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    if (!this.canObserve(toolName)) {
      this.desktopServer.reportRejectedTool(toolName, CuaAdmissionReason.VERIFICATION_READ_ONLY);
      throw new Error('The verification agent can only observe the desktop.');
    }
    return this.desktopServer.callToolResult(toolName, args, meta, options);
  }

  private canObserve(toolName: string): boolean {
    return (
      ObservationToolNames.has(toolName) && !this.desktopServer.taskEvidence.isMutation(toolName)
    );
  }
}
