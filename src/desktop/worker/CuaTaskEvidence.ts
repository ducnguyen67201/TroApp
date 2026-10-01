import type { CallToolResult } from '@openai/agents';
import { z } from 'zod';
import {
  CursorCompanionTool,
  CursorGuidanceResultSchema,
  GuidanceReason,
  TeachingOutcome,
  type TeachingResult,
} from '#contracts/CursorCompanion.js';
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

export interface GuidanceRequest {
  taskEpoch: string;
  expectedSteps: number;
  callNumber: number;
}

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
  private guidanceIssue: TaskIssue | null = null;
  private taskEpoch: string | null = null;
  private callNumber = 0;
  private pendingGuidance = new Set<number>();
  private completedSequences = new Set<string>();
  private terminalGuidance: Extract<TeachingResult, { outcome: 'canceled' | 'failed' }> | null =
    null;

  setToolsRequiringObservation(toolNames: Iterable<string>): void {
    this.toolsRequiringObservation = new Set(toolNames);
  }

  reset(): void {
    this.issue = null;
    this.needsObservation = false;
    this.recoveryActionPending = false;
    this.guidanceIssue = null;
    this.taskEpoch = null;
    this.callNumber = 0;
    this.pendingGuidance.clear();
    this.completedSequences.clear();
    this.terminalGuidance = null;
  }

  beginGuidanceTask(taskEpoch: string): void {
    this.reset();
    this.taskEpoch = taskEpoch;
  }

  hasPendingGuidance(): boolean {
    return this.pendingGuidance.size > 0;
  }

  beginGuidanceRequest(expectedSteps: number): GuidanceRequest | null {
    if (!this.taskEpoch || this.terminalGuidance) {
      return null;
    }
    const request = { taskEpoch: this.taskEpoch, expectedSteps, callNumber: ++this.callNumber };
    this.pendingGuidance.add(request.callNumber);
    return request;
  }

  /** A native receipt satisfies exactly its dispatched request, never verification. */
  settleGuidanceRequest(request: GuidanceRequest, result: CallToolResult): boolean {
    if (request.taskEpoch !== this.taskEpoch || !this.pendingGuidance.delete(request.callNumber)) {
      return false;
    }
    if (this.terminalGuidance) {
      return false;
    }
    const parsed = CursorGuidanceResultSchema.safeParse(result.structuredContent);
    if (!parsed.success) {
      this.failGuidance(GuidanceReason.TRANSPORT_FAILED);
      return false;
    }
    const native = parsed.data;
    if (native.status === 'completed') {
      const receipt = native.receipt;
      if (
        result.isError ||
        receipt.task_epoch !== request.taskEpoch ||
        receipt.completed_steps !== request.expectedSteps ||
        this.completedSequences.has(receipt.sequence_id)
      ) {
        this.failGuidance(GuidanceReason.TRANSPORT_FAILED);
        return false;
      }
      this.completedSequences.add(receipt.sequence_id);
      return true;
    }
    if (!result.isError || native.task_epoch !== request.taskEpoch) {
      this.failGuidance(GuidanceReason.TRANSPORT_FAILED);
      return false;
    }
    this.guidanceIssue = TaskIssue.GUIDANCE_FAILED;
    this.terminalGuidance =
      native.status === 'canceled'
        ? { outcome: TeachingOutcome.CANCELED, reason: native.reason }
        : { outcome: TeachingOutcome.FAILED, reason: native.code };
    return false;
  }

  failGuidance(reason: GuidanceReason): void {
    this.guidanceIssue = TaskIssue.GUIDANCE_FAILED;
    this.terminalGuidance ??= { outcome: TeachingOutcome.FAILED, reason };
  }

  cancelGuidance(reason: GuidanceReason): void {
    this.guidanceIssue = TaskIssue.GUIDANCE_FAILED;
    this.terminalGuidance = { outcome: TeachingOutcome.CANCELED, reason };
  }

  hasTerminalGuidance(): boolean {
    return this.terminalGuidance !== null;
  }

  readTeachingResult(answer: string): TeachingResult {
    if (this.terminalGuidance) {
      return this.terminalGuidance;
    }
    if (this.readIssue() || this.pendingGuidance.size > 0) {
      return { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.TRANSPORT_FAILED };
    }
    return this.completedSequences.size > 0
      ? { outcome: TeachingOutcome.DEMONSTRATED, answer }
      : { outcome: TeachingOutcome.NEEDS_INPUT, reason: GuidanceReason.NO_DEMONSTRATION };
  }

  record(toolName: string, result: CallToolResult): void {
    if (isCursorPresentationTool(toolName)) {
      if (result.isError === true) {
        this.guidanceIssue ??= TaskIssue.GUIDANCE_FAILED;
      } else if (
        toolName === CursorCompanionTool.SHOW_SEQUENCE &&
        this.taskEpoch === null &&
        this.guidanceIssue === TaskIssue.GUIDANCE_FAILED
      ) {
        this.guidanceIssue = null;
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
    return (
      this.guidanceIssue ??
      this.issue ??
      (this.needsObservation ? TaskIssue.OBSERVATION_MISSING : null)
    );
  }
}
