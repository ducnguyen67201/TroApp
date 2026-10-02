import type { CallToolResult } from '@openai/agents';
import { z } from 'zod';
import { CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { isCursorPresentationTool } from './CuaTeachingPolicy.js';

const VerificationResultSchema = z.object({
  status: z.enum(['satisfied', 'unsatisfied', 'unknown', 'refused']).optional(),
});

export const TaskIssue = {
  DESKTOP_ACTION_FAILED: 'desktop_action_failed',
  GUIDANCE_FAILED: 'guidance_failed',
  VERIFICATION_FAILED: 'verification_failed',
  OBSERVATION_MISSING: 'observation_missing',
} as const;

export type TaskIssue = (typeof TaskIssue)[keyof typeof TaskIssue];

/* Window/app lists alone do not show the result of an action inside a window. */
const StateObservationTools = new Set([
  'get_window_state',
  'get_desktop_state',
  'get_browser_state',
  'get_accessibility_tree',
  'verify_state',
]);

/** Tracks Cua failures within one task without reimplementing its desktop tools. */
export class CuaTaskEvidence {
  private issue: TaskIssue | null = null;
  private needsObservation = false;
  private recoveryActionPending = false;
  private toolsRequiringObservation = new Set<string>();

  setToolsRequiringObservation(toolNames: Iterable<string>): void {
    this.toolsRequiringObservation = new Set(toolNames);
  }

  reset(): void {
    this.issue = null;
    this.needsObservation = false;
    this.recoveryActionPending = false;
  }

  record(toolName: string, result: CallToolResult): void {
    if (isCursorPresentationTool(toolName)) {
      if (result.isError === true) {
        this.issue ??= TaskIssue.GUIDANCE_FAILED;
      } else if (
        toolName === CursorCompanionTool.SHOW_SEQUENCE &&
        this.issue === TaskIssue.GUIDANCE_FAILED
      ) {
        this.issue = null;
      }
      return;
    }
    const parsed = VerificationResultSchema.safeParse(result.structuredContent);
    const status = parsed.success ? parsed.data.status : undefined;

    if (this.toolsRequiringObservation.has(toolName)) {
      this.needsObservation = true;
    }

    if (result.isError === true || status === 'refused') {
      this.issue = TaskIssue.DESKTOP_ACTION_FAILED;
      this.recoveryActionPending = false;
      return;
    }

    if (
      this.toolsRequiringObservation.has(toolName) &&
      this.issue === TaskIssue.DESKTOP_ACTION_FAILED
    ) {
      this.recoveryActionPending = true;
    }

    if (StateObservationTools.has(toolName)) {
      this.needsObservation = false;
      if (this.recoveryActionPending && this.issue === TaskIssue.DESKTOP_ACTION_FAILED) {
        /* A later successful path plus observation resolves an earlier failed tool. */
        this.issue = null;
        this.recoveryActionPending = false;
      }
    }

    if (toolName === 'verify_state') {
      /* A successful Cua verification can resolve an earlier failed attempt. */
      this.issue = status === 'satisfied' ? null : TaskIssue.VERIFICATION_FAILED;
      this.recoveryActionPending = false;
    }
  }

  readIssue(): TaskIssue | null {
    return this.issue ?? (this.needsObservation ? TaskIssue.OBSERVATION_MISSING : null);
  }
}
