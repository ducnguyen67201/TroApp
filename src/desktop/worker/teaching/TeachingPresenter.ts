import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { CursorGuidanceResultSchema } from '#contracts/CursorCompanion.js';
import {
  TeachingPresentationReceiptSchema,
  type PresentTeachingStep,
  type TeachingMessage,
  type TeachingPresentationReceipt,
} from '#contracts/TeachingStep.js';
import type { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import type { StudentInteractionTracker } from '../observation/StudentInteractionTracker.js';
import { createTeachingActionPresentation } from './TeachingActionPresentation.js';
import type { TeachingLessonContext } from './TeachingLessonContext.js';
import type { TeachingPresentationBudget } from './TeachingPresentationBudget.js';
import { describeTeachingProposal } from './TeachingStepDiagnostics.js';
import { logAgentExchange } from '../agent/AgentExchangeLog.js';

/** Commit a checkpoint only after its complete presentation has been acknowledged. */
export class TeachingPresenter {
  private receipt: TeachingPresentationReceipt | null = null;

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
    this.receipt = null;
  }

  readReceipt(): TeachingPresentationReceipt | null {
    return this.receipt;
  }

  async presentStep(
    proposal: PresentTeachingStep,
    locale: DesktopLocale,
  ): Promise<Record<string, unknown>> {
    this.receipt = null;
    const reason = this.lesson.canPresent(proposal);
    if (reason) {
      return this.refuse(proposal, reason);
    }
    const geometry = createTeachingActionPresentation(proposal.action);
    const message = this.lesson.reserveMessage(proposal);
    const presentationId = randomUUID();
    const textOnly = geometry.steps.length === 0;
    this.assertCanCommit();
    this.lesson.recordOperation({
      operation: 'presentation_requested',
      proposal,
      presentationId,
      stepId: message.stepId,
    });
    // Input may arrive while native rendering is pending. Stage the matcher for
    // this action; history records approximate attempts, not proof of visibility.
    this.tracker.registerStep(message.stepId, geometry.interaction);
    this.prepareMessage(message);
    let published = false;
    try {
      const native = await this.server.showTeachingCue(
        {
          capture_id: proposal.captureId,
          presentation_version: 2,
          presentation_id: presentationId,
          text_only: textOnly,
          steps: geometry.steps,
          targets: geometry.targets,
        },
        message,
        locale,
      );
      this.assertCanCommit();
      const parsed = CursorGuidanceResultSchema.safeParse(native.structuredContent);
      if (
        native.isError ||
        !parsed.success ||
        parsed.data.status !== 'presented' ||
        parsed.data.receipt.presentation_id !== presentationId ||
        parsed.data.receipt.lesson_id !== this.lesson.id ||
        parsed.data.receipt.step_id !== message.stepId ||
        parsed.data.receipt.text_only !== textOnly ||
        (!textOnly && !parsed.data.receipt.drawing_presented)
      ) {
        this.tracker.invalidateTarget();
        const refusal = z.object({ code: z.string().max(160) }).safeParse(native.structuredContent);
        return this.refuse(
          proposal,
          refusal.success ? refusal.data.code : 'paired_presentation_missing',
        );
      }
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
      this.tracker.registerStep(message.stepId, geometry.interaction);
      this.receipt = receipt;
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
      // Pending narration may already be playing before the final receipt arrives.
      if (!published) {
        this.revokeMessage(message);
      }
    }
  }

  private refuse(proposal: PresentTeachingStep, reason: string): Record<string, unknown> {
    this.lesson.recordOperation({ operation: 'presentation_refused', reason, proposal });
    this.log.warn(
      { ...describeTeachingProposal(proposal), reason },
      'agent.teaching.presentation.refused',
    );
    return this.budget.reject(reason);
  }
}
