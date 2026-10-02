import { z } from 'zod';

export const AgentTaskMode = { EXECUTE: 'execute', TEACH: 'teach' } as const;

export const AgentTaskModeSchema = z.enum(AgentTaskMode);

export type AgentTaskMode = z.infer<typeof AgentTaskModeSchema>;

export const CursorCompanionTool = {
  SHOW_SEQUENCE: 'show_cursor_sequence',
  SET_MODE: 'set_cursor_companion_mode',
  CANCEL_SEQUENCE: 'cancel_cursor_sequence',
  READ_STATE: 'get_cursor_companion_state',
} as const;

/** Cua owns this protocol; Tro validates host responses without rendering it. */
export const CursorCompanionStateSchema = z.strictObject({
  status: z.enum(['state', 'following', 'hidden', 'canceled', 'completed']),
  following: z.boolean(),
  active: z.boolean(),
});
