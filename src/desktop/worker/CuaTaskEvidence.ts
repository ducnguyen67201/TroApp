import {
  CursorCompanionTool,
  CursorGuidanceResultSchema,
  GuidanceReason,
  TeachingOutcome,
  type TeachingResult,
} from '#contracts/CursorCompanion.js';
import { isCursorPresentationTool } from './CuaTeachingPolicy.js';
import { TeachingReplyKind } from './TeachingReply.js';

import type { CallToolResult } from '@openai/agents';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  parseCuaObservation,
  parseWindowObservations,
  isRefusedCuaResult,
  readObservationText,
  type CuaObservation,
  type ObservationTarget,
} from './CuaObservation.js';
import { TaskCompletionConfig, type TaskBudgetConfig } from './TaskCompletionConfig.js';
import { TaskContextBudgetError } from './TaskContextBudget.js';

export const TaskIssue = {
  GUIDANCE_FAILED: 'guidance_failed',
} as const;

export type TaskIssue = (typeof TaskIssue)[keyof typeof TaskIssue];

export interface GuidanceRequest {
  taskEpoch: string;
  expectedSteps: number;
  callNumber: number;
}

export const EvidenceContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  }),
]);

export type EvidenceContent = Readonly<z.infer<typeof EvidenceContentSchema>>;

export interface TaskObservation extends CuaObservation {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly callId: string;
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly contentIds: readonly string[];
}

export interface TaskEvidenceSnapshot {
  taskId: string;
  version: number;
  revision: number;
  mutationCount: number;
  failureCount: number;
  observations: readonly TaskObservation[];
  inFlight: number;
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  revision: number;
  isMutation: boolean;
  taskId: string;
}

const FactNames = ['url', 'is_loading', 'is_visible', 'is_focused', 'status'] as const;

/** Match explicit identities, never PID alone or conflicting displays/tabs/windows. */
function matchesObservationTarget(left: ObservationTarget, right: ObservationTarget): boolean {
  const keys = ['pid', 'window_id', 'tab_id', 'display_id', 'target_id'] as const;
  if (
    keys.some(
      (key) => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key],
    )
  ) {
    return false;
  }
  return keys.some((key) => key !== 'pid' && left[key] !== undefined && left[key] === right[key]);
}

/** Bounded task-local observations from either agent; raw content never enters logs or storage. */
export class CuaTaskEvidence {
  private guidanceIssue: TaskIssue | null = null;
  private taskEpoch: string | null = null;
  private callNumber = 0;
  private pendingGuidance = new Set<number>();
  private completedSequences = new Set<string>();
  private terminalGuidance: Extract<TeachingResult, { outcome: 'canceled' | 'failed' }> | null =
    null;

  private taskId = '';
  private version = 0;
  private revision = 0;
  private mutationCount = 0;
  private failureCount = 0;
  private nextCall = 0;
  private sequence = 0;
  private observations: TaskObservation[] = [];
  private readonly content = new Map<string, EvidenceContent>();
  private readonly inFlight = new Set<string>();
  private toolsRequiringObservation = new Set<string>();
  private readOnlyTools = new Set<string>();
  private fingerprints = new Set<string>();
  private config: TaskBudgetConfig = TaskCompletionConfig;
  private readTime: () => number = () => performance.now();

  configure(taskId: string, config: TaskBudgetConfig, readTime: () => number): void {
    this.reset();
    this.taskId = taskId;
    this.config = config;
    this.readTime = readTime;
  }

  setToolsRequiringObservation(toolNames: Iterable<string>): void {
    this.toolsRequiringObservation = new Set(toolNames);
  }

  setReadOnlyTools(toolNames: Iterable<string>): void {
    this.readOnlyTools = new Set(toolNames);
  }

  isMutation(toolName: string): boolean {
    return (
      !isCursorPresentationTool(toolName) &&
      (this.toolsRequiringObservation.has(toolName) || !this.readOnlyTools.has(toolName))
    );
  }

  reset(): void {
    this.guidanceIssue = null;
    this.taskEpoch = null;
    this.callNumber = 0;
    this.pendingGuidance.clear();
    this.completedSequences.clear();
    this.terminalGuidance = null;
    this.taskId = '';
    this.version = 0;
    this.revision = 0;
    this.mutationCount = 0;
    this.failureCount = 0;
    this.nextCall = 0;
    this.sequence = 0;
    this.observations = [];
    this.content.clear();
    this.inFlight.clear();
    this.fingerprints.clear();
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

  readTeachingResult(answer: string, replyKind?: TeachingReplyKind): TeachingResult {
    if (this.terminalGuidance) {
      return this.terminalGuidance;
    }
    if (this.guidanceIssue || this.pendingGuidance.size > 0) {
      return { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.TRANSPORT_FAILED };
    }
    if (this.completedSequences.size > 0) {
      return { outcome: TeachingOutcome.DEMONSTRATED, answer };
    }
    if (replyKind === TeachingReplyKind.EXPLANATION && answer.trim()) {
      return { outcome: TeachingOutcome.EXPLAINED, answer };
    }
    return {
      outcome: TeachingOutcome.NEEDS_INPUT,
      reason: GuidanceReason.NO_DEMONSTRATION,
      ...(replyKind === TeachingReplyKind.NEEDS_INPUT && answer.trim() ? { answer } : {}),
    };
  }

  readIssue(): TaskIssue | null {
    return this.guidanceIssue;
  }

  /** Native presentation state is independent from execution evidence. */
  record(toolName: string, result: CallToolResult): void {
    if (isCursorPresentationTool(toolName)) {
      if (result.isError === true) {
        this.guidanceIssue ??= TaskIssue.GUIDANCE_FAILED;
      } else if (toolName === CursorCompanionTool.SHOW_SEQUENCE && this.taskEpoch === null) {
        this.guidanceIssue = null;
      }
    }
  }

  beginToolCall(toolName: string): ToolCallRecord {
    const isMutation = this.isMutation(toolName);
    if (isMutation) {
      this.revision += 1;
      this.mutationCount += 1;
      this.version += 1;
    }
    const record = {
      id: 'call-' + String(++this.nextCall),
      toolName,
      revision: this.revision,
      isMutation,
      taskId: this.taskId,
    };
    this.inFlight.add(record.id);
    return record;
  }

  recordToolResult(
    call: ToolCallRecord,
    args: Record<string, unknown> | null,
    result: CallToolResult,
  ): { observations: TaskObservation[]; fingerprint: string } {
    if (call.taskId !== this.taskId) {
      return { observations: [], fingerprint: '' };
    }
    this.inFlight.delete(call.id);
    const failed = result.isError === true || isRefusedCuaResult(result);
    if (failed) {
      this.failureCount += 1;
    }
    const parsed = failed ? null : parseCuaObservation(call.toolName, args, result);
    const facts = failed
      ? []
      : call.toolName === 'list_windows'
        ? parseWindowObservations(result)
        : parsed
          ? [parsed]
          : [];
    const captureSequence = ++this.sequence;
    const capturedAtMs = this.readTime();
    this.version += 1;
    let observations: TaskObservation[] = [];
    if (call.taskId === this.taskId && call.revision === this.revision && facts.length > 0) {
      const parts = this.readValidatedContent(result);
      const contentIds = this.saveContent(parts);
      observations = facts.map((observation, index) =>
        Object.freeze({
          ...observation,
          target: Object.freeze({ ...observation.target }),
          fields: Object.freeze({ ...observation.fields }),
          hasImage: observation.hasImage && parts.some((part) => part.type === 'image'),
          hasText:
            observation.hasText &&
            parts.some((part) => part.type === 'text' && readObservationText(part.text).length > 0),
          id: 'evidence-' + call.id + '-' + String(index + 1),
          callId: call.id,
          taskId: this.taskId,
          revision: call.revision,
          sequence: captureSequence,
          capturedAtMs,
          contentIds: Object.freeze(contentIds),
        }),
      );
      this.observations.push(...observations);
      this.enforceRetainedBudget();
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          tool: call.toolName,
          args,
          facts: facts.map((fact) => ({ target: fact.target, fields: fact.fields })),
          text: result.content.flatMap((item) =>
            item.type === 'text' && typeof item.text === 'string'
              ? [parsed ? readObservationText(item.text) : item.text]
              : [],
          ),
          error: failed,
        }),
      )
      .digest('hex');
    return { observations, fingerprint };
  }

  recordToolError(call: ToolCallRecord): void {
    if (call.taskId !== this.taskId) {
      return;
    }
    this.inFlight.delete(call.id);
    this.failureCount += 1;
    this.version += 1;
  }

  recordFingerprint(fingerprint: string): boolean {
    const isNew = !this.fingerprints.has(fingerprint);
    this.fingerprints.add(fingerprint);
    return isNew;
  }

  isAdmissible(observation: TaskObservation): boolean {
    if (
      observation.taskId !== this.taskId ||
      observation.revision !== this.revision ||
      this.readTime() - observation.capturedAtMs > this.config.maximumEvidenceAgeMs
    ) {
      return false;
    }
    return !this.observations.some((newer) => {
      if (newer.revision !== this.revision || newer.sequence <= observation.sequence) {
        return false;
      }
      const sameTarget = matchesObservationTarget(observation.target, newer.target);
      const sameGlobalSnapshot =
        Object.keys(observation.target).length === 0 && Object.keys(newer.target).length === 0;
      if (!sameTarget && !sameGlobalSnapshot) {
        return false;
      }
      return (
        newer.category === observation.category ||
        (sameTarget &&
          FactNames.some(
            (field) => observation.fields[field] !== undefined && newer.fields[field] !== undefined,
          ))
      );
    });
  }

  hasAdmissibleEvidence(id: string): boolean {
    const observation = this.observations.find((item) => item.id === id);
    return (
      observation !== undefined &&
      this.isAdmissible(observation) &&
      (observation.hasImage ||
        observation.hasText ||
        FactNames.some((field) => observation.fields[field] !== undefined))
    );
  }

  readContent(observation: TaskObservation): readonly EvidenceContent[] {
    return observation.contentIds.flatMap((id) => {
      const part = this.content.get(id);
      return part ? [part] : [];
    });
  }

  readRetainedBytes(): number {
    return (
      Buffer.byteLength(JSON.stringify(this.observations)) +
      [...this.content.values()].reduce(
        (sum, part) => sum + Buffer.byteLength(JSON.stringify(part)),
        0,
      )
    );
  }

  readSnapshot(): TaskEvidenceSnapshot {
    return {
      taskId: this.taskId,
      version: this.version,
      revision: this.revision,
      mutationCount: this.mutationCount,
      failureCount: this.failureCount,
      observations: [...this.observations],
      inFlight: this.inFlight.size,
    };
  }

  private readValidatedContent(result: CallToolResult): EvidenceContent[] {
    const parts = result.content.flatMap((part) => {
      const parsed = EvidenceContentSchema.safeParse(part);
      return parsed.success ? [Object.freeze(parsed.data)] : [];
    });
    const structured = z.json().safeParse(result.structuredContent);
    if (structured.success) {
      parts.push(Object.freeze({ type: 'text', text: JSON.stringify(structured.data) }));
    }
    return parts;
  }

  private saveContent(parts: readonly EvidenceContent[]): string[] {
    return parts.map((part) => {
      const id = createHash('sha256').update(JSON.stringify(part)).digest('hex');
      if (!this.content.has(id)) {
        this.content.set(id, part);
      }
      return id;
    });
  }

  private enforceRetainedBudget(): void {
    if (this.readRetainedBytes() <= this.config.maximumRetainedEvidenceBytes) {
      return;
    }
    this.observations = this.observations.filter((observation) => this.isAdmissible(observation));
    const used = new Set(this.observations.flatMap((observation) => [...observation.contentIds]));
    for (const id of this.content.keys()) {
      if (!used.has(id)) {
        this.content.delete(id);
      }
    }
    if (this.readRetainedBytes() > this.config.maximumRetainedEvidenceBytes) {
      throw new TaskContextBudgetError();
    }
  }
}
