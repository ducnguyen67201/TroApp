import { ClassroomMaterialInstructions } from '../agent/ComputerUseInstructions.js';
import { randomUUID } from 'node:crypto';
import type { TeachingContext } from '#contracts/Classroom.js';
import type { AgentInputItem, CallToolResult } from '@openai/agents';
import { z } from 'zod';
import {
  DefineTeachingGoalSchema,
  ReviseTeachingGoalSchema,
  TeachingMessageKind,
  type PresentTeachingStep,
  type TeachingMessage,
  type TeachingPresentationReceipt,
} from '#contracts/TeachingStep.js';
import { EvidenceContentSchema } from '../cua/CuaTaskEvidence.js';
import { DesktopCaptureSchema } from '../observation/TeachingCapture.js';
import type { TeachingDecision } from './TeachingReply.js';
import { countMaterialHistoryTokens, projectClassroomForAgent } from './MaterialEvidence.js';

interface GoalRevision {
  id: string;
  purpose: z.infer<typeof DefineTeachingGoalSchema>['purpose'];
  outcome: string;
  criteria: { id: string; description: string }[];
}

/** One original request; observations and failures survive individual SDK runs. */
export class TeachingLessonContext {
  readonly id = randomUUID();
  private goal: GoalRevision | null = null;
  private readonly revisions: { id: string; reason: string }[] = [];
  private readonly operations: Record<string, unknown>[] = [];
  private exchanges: AgentInputItem[][] = [];
  private capture: { metadata: z.infer<typeof DesktopCaptureSchema>; image: string } | null = null;
  private current: { proposal: PresentTeachingStep; receipt: TeachingPresentationReceipt } | null =
    null;
  private message: TeachingMessage | null = null;
  private sequence = 0;
  private readonly presentedHighlights: TeachingPresentationReceipt[] = [];
  private question: string | null = null;
  private answer: string | null = null;
  private waitingForStudent = false;

  constructor(
    readonly originalRequest: string,
    private readonly classroom?: TeachingContext,
  ) {}

  defineGoal(input: z.infer<typeof DefineTeachingGoalSchema>): Record<string, unknown> {
    if (this.goal) {
      return { admitted: false, reason: 'goal_already_defined', goal: this.goal };
    }
    return this.replaceGoal(input, 'Initial interpretation of original request');
  }

  reviseGoal(input: z.infer<typeof ReviseTeachingGoalSchema>): Record<string, unknown> {
    if (this.goal?.id !== input.previousRevisionId || this.readCaptureId() !== input.captureId) {
      return { admitted: false, reason: 'goal_or_capture_superseded', goal: this.goal };
    }
    if (this.revisions.length >= 8) {
      return { admitted: false, reason: 'goal_revision_limit' };
    }
    return this.replaceGoal(input.definition, input.reason);
  }

  private replaceGoal(
    input: z.infer<typeof DefineTeachingGoalSchema>,
    reason: string,
  ): Record<string, unknown> {
    this.goal = {
      id: randomUUID(),
      ...input,
      criteria: input.criteria.map((description) => ({ id: randomUUID(), description })),
    };
    this.revisions.push({ id: this.goal.id, reason });
    this.recordOperation({ operation: 'goal_revision', goal: this.goal, reason });
    return { admitted: true, goal: this.goal };
  }

  readGoal(): GoalRevision | null {
    return this.goal;
  }

  readCaptureId(): string | null {
    return this.capture?.metadata.capture_id ?? null;
  }

  recordObservation(result: CallToolResult): void {
    const metadata = DesktopCaptureSchema.safeParse(result.structuredContent);
    const images = result.content.flatMap((part) => {
      const parsed = EvidenceContentSchema.safeParse(part);
      return parsed.success && parsed.data.type === 'image' ? [parsed.data] : [];
    });
    const image = images[0];
    if (
      result.isError ||
      !metadata.success ||
      images.length !== 1 ||
      !image ||
      image.data.length > 4000000
    ) {
      this.capture = null;
      return;
    }
    this.capture = {
      metadata: metadata.data,
      image: `data:${image.mimeType};base64,${image.data}`,
    };
    this.recordOperation({ operation: 'observation', capture: metadata.data });
  }

  recordOperation(operation: Record<string, unknown>): void {
    this.operations.push(operation);
    while (
      this.operations.length > 24 ||
      Buffer.byteLength(JSON.stringify(this.operations)) > 64000
    ) {
      this.operations.shift();
    }
  }

  canPresent(proposal: PresentTeachingStep): string | null {
    if (this.goal?.id !== proposal.goalRevisionId) {
      return 'goal_revision_required';
    }
    if (this.readCaptureId() !== proposal.captureId) {
      return 'fresh_observation_required';
    }
    if (proposal.checkpointId !== null && proposal.checkpointId !== this.current?.receipt.stepId) {
      return 'unknown_checkpoint';
    }
    return null;
  }

  reserveMessage(proposal: PresentTeachingStep): TeachingMessage {
    return {
      lessonId: this.id,
      stepId: proposal.checkpointId ?? randomUUID(),
      sequence: ++this.sequence,
      kind: TeachingMessageKind.INSTRUCTION,
      text: proposal.instruction,
    };
  }

  commitPresentedStep(
    proposal: PresentTeachingStep,
    receipt: TeachingPresentationReceipt,
    message: TeachingMessage,
  ): void {
    this.current = { proposal, receipt };
    if (proposal.action.kind === 'highlight' && receipt.drawingPresented) {
      this.presentedHighlights.push(receipt);
      if (this.presentedHighlights.length > 8) {
        this.presentedHighlights.shift();
      }
    }
    this.message = message;
    this.question = null;
    this.recordOperation({ operation: 'step_presented', proposal, receipt });
  }

  readCurrentStep(): {
    proposal: PresentTeachingStep;
    receipt: TeachingPresentationReceipt;
  } | null {
    return this.current;
  }

  readMessage(): TeachingMessage | null {
    return this.message;
  }

  readInstruction(): string {
    return this.message?.text ?? '';
  }

  replaceMessageText(text: string): TeachingMessage | null {
    if (!this.message) {
      return null;
    }
    this.message = { ...this.message, sequence: ++this.sequence, text };
    if (this.question !== null) {
      this.question = text;
    }
    return this.message;
  }

  createStatusMessage(text: string): TeachingMessage | null {
    return this.message ? { ...this.message, sequence: ++this.sequence, text } : null;
  }

  askQuestion(question: string): void {
    this.question = question;
    this.answer = null;
    this.message = {
      lessonId: this.id,
      stepId: this.current?.receipt.stepId ?? randomUUID(),
      sequence: ++this.sequence,
      kind: TeachingMessageKind.QUESTION,
      text: question.slice(0, 600),
    };
  }

  canAnswer(): boolean {
    return this.question !== null && this.answer === null;
  }

  setWaitingForStudent(waiting: boolean): void {
    this.waitingForStudent = waiting;
  }

  hasAnswer(): boolean {
    return this.answer !== null;
  }

  submitAnswer(lessonId: string, answer: string): boolean {
    if (
      lessonId !== this.id ||
      this.answer !== null ||
      (!this.canAnswer() && !this.waitingForStudent)
    ) {
      return false;
    }
    this.answer = answer.slice(0, 4000);
    this.recordOperation({
      operation: 'student_answer',
      lessonId: this.id,
      question: this.question,
      answer: this.answer,
    });
    return true;
  }

  recordReply(history: AgentInputItem[], inputCount: number): void {
    const exchange = history.slice(inputCount);
    if (exchange.length) {
      this.exchanges.push(exchange);
    }
    while (
      this.exchanges.length > 2 ||
      Buffer.byteLength(JSON.stringify(this.exchanges)) > 4000000 ||
      (this.exchanges.length > 0 &&
        countMaterialHistoryTokens(this.classroom, this.exchanges) > 8000)
    ) {
      this.exchanges.shift();
    }
    if (this.answer !== null) {
      this.question = null;
      this.answer = null;
    }
  }

  buildInput(trigger: string, activity: unknown): AgentInputItem[] {
    const capture = this.capture;
    const packet = JSON.stringify({
      originalRequest: this.originalRequest,
      classroom: projectClassroomForAgent(this.classroom),
      classroomReferencePolicy: this.classroom ? ClassroomMaterialInstructions : null,
      goal: this.goal,
      revisions: this.revisions,
      checkpoint: this.current,
      presentedHighlights: this.presentedHighlights,
      question: this.question,
      answer: this.answer,
      trigger,
      activity,
      operations: this.operations,
      observation: capture?.metadata ?? null,
      instruction:
        'Assess checkpoint and original task separately. Three attempts without progress require investigation, not an identical unsupported retry.',
    });
    return [
      { role: 'user', content: this.originalRequest },
      ...this.exchanges.flat(),
      {
        role: 'user',
        content: [
          { type: 'input_text', text: packet },
          ...(capture ? [{ type: 'input_image' as const, image: capture.image }] : []),
        ],
      },
    ];
  }

  hasReachedGoal(decision: TeachingDecision): boolean {
    const goal = this.goal;
    const captureId = this.readCaptureId();
    return (
      goal !== null &&
      (goal.purpose !== 'tour' ||
        this.presentedHighlights.filter((receipt) => receipt.goalRevisionId === goal.id).length >=
          goal.criteria.length) &&
      captureId !== null &&
      decision.goalRevisionId === goal.id &&
      decision.captureId === captureId &&
      goal.criteria.every((criterion) =>
        decision.goalEvidence.some(
          (item) => item.criterionId === criterion.id && item.captureId === captureId,
        ),
      ) &&
      decision.goalEvidence.every(
        (item) =>
          goal.criteria.some((criterion) => criterion.id === item.criterionId) &&
          item.captureId === captureId,
      )
    );
  }
}
