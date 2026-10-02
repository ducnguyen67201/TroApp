import { AgentTaskMode, CursorCompanionTool } from '#contracts/CursorCompanion.js';

/* Review exact tools: readOnlyHint is a discovery hint, not an authorization
   boundary. Browser evaluation, input, navigation and launch are excluded. */
const TeachingTools = new Set<string>([
  'list_apps',
  'list_windows',
  'get_screen_size',
  'get_cursor_position',
  'get_desktop_state',
  'get_window_state',
  'get_accessibility_tree',
  'get_browser_state',
  'verify_state',
  'bring_to_front',
  CursorCompanionTool.SHOW_SEQUENCE,
  CursorCompanionTool.CANCEL_SEQUENCE,
  CursorCompanionTool.READ_STATE,
  CursorCompanionTool.READ_CAPABILITIES,
]);
const HostTools = new Set<string>([
  CursorCompanionTool.SET_MODE,
  CursorCompanionTool.BEGIN_TASK,
  CursorCompanionTool.END_TASK,
  'start_session',
  'end_session',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
]);

/** Enforced both on discovery and invocation, before native dispatch. */
export function canCallCuaTool(toolName: string, mode: AgentTaskMode): boolean {
  return (
    !HostTools.has(toolName) && (mode === AgentTaskMode.EXECUTE || TeachingTools.has(toolName))
  );
}

export function isCursorPresentationTool(toolName: string): boolean {
  return (
    Object.values(CursorCompanionTool).some((name) => name === toolName) ||
    toolName.startsWith('set_agent_cursor_')
  );
}
