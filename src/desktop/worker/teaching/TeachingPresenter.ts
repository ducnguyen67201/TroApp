import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  CursorGuidanceResultSchema,
  GuidanceCoordinateTraceSchema,
  hasValidPresentedStrokes,
} from '#contracts/CursorCompanion.js';
import {
  TeachingPresentationReceiptSchema,
  PresentTeachingStepSchema,
  type PresentTeachingStep,
  type TeachingMessage,
  type TeachingPresentationReceipt,
} from '#contracts/TeachingStep.js';
import type { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import type { StudentInteractionTracker } from '../observation/StudentInteractionTracker.js';
import { createTeachingActionTargets } from './TeachingActionTargets.js';
import type { TeachingLessonContext } from './TeachingLessonContext.js';
import type { TeachingPresentationBudget } from './TeachingPresentationBudget.js';
import { describeTeachingProposal } from './TeachingStepDiagnostics.js';
import { logAgentExchange } from '../agent/AgentExchangeLog.js';

interface StagedTeachingPresentation {
  generation: number;
  message: TeachingMessage;
}

/** Commit a checkpoint only after its complete presentation has been acknowledged. */
export class TeachingPresenter {
  private receipt: TeachingPresentationReceipt | null = null;
  private segmentGeneration = 0;
  private segmentOpen = false;
  private stagedPresentation: StagedTeachingPresentation | null = null;

  constructor(
    private readonly lesson: TeachingLessonContext,
    private readonly server: LoggedCuaServer,
    private readonly tracker: StudentInteractionTracker,
    private readonly budget: TeachingPresentationBudget,
    private readonly log: Logger,
    private readonly publish: (message: TeachingMessage) => void,
    private readonly assertCanCommit: () => void = () => {},
    private readonly prepareMessage: (message: TeachingMessage) => void = () => {},
    private readonly revokeMessage: (message: TeachingMessage) => void = () => {},
  ) {}

  beginSegment(): void {
    this.segmentOpen = false;
    this.segmentGeneration += 1;
    this.clearStagedPresentation();
    this.segmentOpen = true;
    this.receipt = null;
  }

  /** Close pending ownership before an SDK segment settles or its native task ends.
   * A committed receipt remains readable by the runner after the model returns. */
  endSegment(): void {
    this.segmentOpen = false;
    this.segmentGeneration += 1;
    this.clearStagedPresentation();
  }

  readReceipt(): TeachingPresentationReceipt | null {
    return this.receipt;
  }

  async presentStep(
    proposal: PresentTeachingStep,
    locale: DesktopLocale,
  ): Promise<Record<string, unknown>> {
    const generation = this.segmentGeneration;
    if (!this.isCurrentSegment(generation)) {
      return { admitted: false, reason: 'presentation_superseded' };
    }
    this.receipt = null;
    const validationStarted = performance.now();
    if (!PresentTeachingStepSchema.safeParse(proposal).success) {
      return this.refuse(proposal, 'invalid_tool_input');
    }
    const reason = this.lesson.canPresent(proposal);
    if (reason) {
      return this.refuse(proposal, reason);
    }
    const actionTargets = createTeachingActionTargets(proposal.action);
    const message = this.lesson.reserveMessage(proposal);
    const presentationId = randomUUID();
    const textOnly = proposal.drawing === null;
    this.assertCanCommit();
    if (!this.isCurrentSegment(generation)) {
      return { admitted: false, reason: 'presentation_superseded' };
    }
    this.lesson.recordOperation({
      operation: 'presentation_requested',
      proposal,
      presentationId,
      stepId: message.stepId,
    });
    // Input may arrive while native rendering is pending. Stage the matcher for
    // this action; history records approximate attempts, not proof of visibility.
    const staged = { generation, message };
    this.clearStagedPresentation();
    this.stagedPresentation = staged;
    this.tracker.registerStep(message.stepId, actionTargets.interaction);
    let published = false;
    let committed = false;
    const nativeStarted = performance.now();
    try {
      this.prepareMessage(message);
      if (!this.isCurrentPresentation(staged)) {
        return { admitted: false, reason: 'presentation_superseded' };
      }
      this.log.info(
        {
          lessonId: this.lesson.id,
          stepId: message.stepId,
          presentationId,
          captureId: proposal.captureId,
          actionKind: proposal.action.kind,
          targetsNormalized: actionTargets.targets,
          strokesNormalized: proposal.drawing?.strokes ?? [],
          strokeCount: proposal.drawing?.strokes.length ?? 0,
          pointCount:
            proposal.drawing?.strokes.reduce((count, stroke) => count + stroke.points.length, 0) ??
            0,
          proposalValidationMs: Math.round(performance.now() - validationStarted),
        },
        'agent.teaching.coordinates.requested',
      );
      const native = await this.server.showTeachingCue(
        {
          capture_id: proposal.captureId,
          presentation_version: 3,
          presentation_id: presentationId,
          text_only: textOnly,
          drawing: proposal.drawing,
          targets: actionTargets.targets,
        },
        message,
        locale,
      );
      if (!this.isCurrentPresentation(staged)) {
        return { admitted: false, reason: 'presentation_superseded' };
      }
      this.assertCanCommit();
      if (!this.isCurrentPresentation(staged)) {
        return { admitted: false, reason: 'presentation_superseded' };
      }
      const parsed = CursorGuidanceResultSchema.safeParse(native.structuredContent);
      if (
        native.isError ||
        !parsed.success ||
        parsed.data.status !== 'presented' ||
        parsed.data.receipt.presentation_id !== presentationId ||
        parsed.data.receipt.lesson_id !== this.lesson.id ||
        parsed.data.receipt.step_id !== message.stepId ||
        parsed.data.receipt.text_only !== textOnly ||
        !hasValidPresentedStrokes(parsed.data.receipt, proposal.drawing?.strokes.length ?? 0)
      ) {
        this.tracker.invalidateTarget();
        const refusal = z.object({ code: z.string().max(160) }).safeParse(native.structuredContent);
        return this.refuse(
          proposal,
          refusal.success ? refusal.data.code : 'paired_presentation_missing',
          presentationId,
        );
      }
      const coordinateTrace = GuidanceCoordinateTraceSchema.safeParse(parsed.data.coordinate_trace);
      this.log.info(
        {
          lessonId: this.lesson.id,
          stepId: message.stepId,
          presentationId,
          captureId: proposal.captureId,
          coordinateTrace: coordinateTrace.success ? coordinateTrace.data : null,
          coordinateTraceAvailable: coordinateTrace.success,
          drawingPresented: parsed.data.receipt.drawing_presented,
          interrupted: parsed.data.receipt.interrupted,
          strokesPresented: parsed.data.receipt.strokes_presented,
          nativePresentationMs: Math.round(performance.now() - nativeStarted),
        },
        'agent.teaching.coordinates.converted',
      );
      const interrupted = parsed.data.receipt.interrupted;
      const receipt = TeachingPresentationReceiptSchema.parse({
        lessonId: this.lesson.id,
        stepId: message.stepId,
        presentationId,
        goalRevisionId: proposal.goalRevisionId,
        captureId: proposal.captureId,
        messagePresented: true,
        drawingPresented: !textOnly,
        textOnly,
        interrupted,
      });
      this.lesson.commitPresentedStep(proposal, receipt, message);
      this.tracker.registerStep(message.stepId, actionTargets.interaction);
      this.receipt = receipt;
      committed = true;
      this.budget.confirm();
      if (!interrupted) {
        this.publish(message);
        published = true;
      }
      this.log.debug(
        { ...describeTeachingProposal(proposal), ...receipt },
        'agent.teaching.presentation.acknowledged',
      );
      logAgentExchange(this.log, {
        operation: 'teaching.presentation',
        context: { lessonId: this.lesson.id },
        input: proposal,
        output: receipt,
      });
      return { admitted: true, ...receipt };
    } finally {
      // A late completion must not revoke narration or clear a newer step's matcher.
      if (this.stagedPresentation === staged) {
        this.stagedPresentation = null;
        if (!committed) {
          this.tracker.invalidateTarget();
        }
        if (!published) {
          this.revokeMessage(message);
        }
      }
    }
  }

  private isCurrentSegment(generation: number): boolean {
    return this.segmentOpen && generation === this.segmentGeneration;
  }

  private isCurrentPresentation(staged: StagedTeachingPresentation): boolean {
    return this.stagedPresentation === staged && this.isCurrentSegment(staged.generation);
  }

  private clearStagedPresentation(): void {
    const staged = this.stagedPresentation;
    this.stagedPresentation = null;
    if (staged) {
      this.tracker.invalidateTarget();
      this.revokeMessage(staged.message);
    }
  }

  private refuse(
    proposal: PresentTeachingStep,
    reason: string,
    presentationId?: string,
  ): Record<string, unknown> {
    this.lesson.recordOperation({ operation: 'presentation_refused', reason, proposal });
    this.log.warn(
      {
        ...describeTeachingProposal(proposal),
        lessonId: this.lesson.id,
        captureId: proposal.captureId,
        goalRevisionId: proposal.goalRevisionId,
        ...(presentationId ? { presentationId } : {}),
        reason,
      },
      'agent.teaching.presentation.refused',
    );
    return this.budget.reject(reason);
  }
}
