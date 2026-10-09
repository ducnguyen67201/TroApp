import { StudentInteractionTracker } from '../observation/StudentInteractionTracker.js';
import type { ClassroomTeachingSession } from './ClassroomTeachingTools.js';
import type { StudentActivity } from '#contracts/StudentActivity.js';
import { logAgentExchange } from '../agent/AgentExchangeLog.js';
import { AgentLogRole, withAgentLogContext } from '../agent/AgentDebugLog.js';
import type { Logger } from 'pino';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { TeachingLessonPhase, type DesktopObservation } from '#contracts/DesktopObservation.js';
import {
  GuidanceReason,
  TeachingOutcome,
  type TeachingResult,
} from '#contracts/CursorCompanion.js';
import { createTeachingAgent } from '../agent/CreateComputerUseAgent.js';
import { CuaCompanionClient, GuidanceTaskError } from '../cua/CuaCompanionClient.js';
import {
  DesktopObservationClient,
  type DesktopObservationPort,
} from '../observation/DesktopObservationClient.js';
import type { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import { runComputerUseAgent, type ComputerUseAnswer } from '../agent/RunComputerUseAgent.js';
import { TeachingDisposition } from './TeachingReply.js';
import { TeachingLessonContext } from './TeachingLessonContext.js';
import { TeachingPresenter } from './TeachingPresenter.js';
import { TeachingPresentationBudget } from './TeachingPresentationBudget.js';
import {
  TeachingObservationLimits,
  TeachingObservationPolicy,
} from '../observation/TeachingObservationPolicy.js';
import { randomUUID } from 'node:crypto';
import { TeachingMessageKind, type TeachingMessage } from '#contracts/TeachingStep.js';
import { describeTeachingMessage } from './TeachingStepDiagnostics.js';
import { translateTeachingMessage } from './TranslateTeachingMessage.js';
import {
  TeachingFailure,
  TeachingFailureCode,
  TeachingFailureStage,
  describeTeachingFailure,
  readTeachingModelRetryReason,
  TeachingModelRetryReason,
  describeTeachingObservation,
} from './TeachingFailure.js';

export type ReceiveTeachingStep = (
  instruction: string,
  phase?: TeachingLessonPhase,
  lessonId?: string,
  message?: TeachingMessage,
  locale?: DesktopLocale,
  presentationPending?: boolean,
  presentationRevoked?: boolean,
  canAcceptAnswer?: boolean,
) => void;

/** Local waits have no SDK request. Abort always removes their pending timer. */
async function waitForLessonPoll(
  signal: AbortSignal,
  durationMs: number = TeachingObservationLimits.POLL_MS,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error('Lesson stopped.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class TeachingTaskRunner {
  private readonly interactionTracker = new StudentInteractionTracker();
  recordStudentActivity(activity: StudentActivity): void {
    this.interactionTracker.recordActivity(activity);
  }

  private lesson: TeachingLessonContext | null = null;
  private readonly observation: DesktopObservationPort;
  private locale: DesktopLocale = DesktopLocale.ENGLISH;
  private requestedLocale: DesktopLocale = DesktopLocale.ENGLISH;
  private localeAbort = new AbortController();
  private receiveStep: ReceiveTeachingStep | undefined;
  private classroom: ClassroomTeachingSession | undefined;

  updateLocale(locale: DesktopLocale): boolean {
    if (!this.lesson) {
      return false;
    }
    if (locale !== this.requestedLocale) {
      this.requestedLocale = locale;
      this.localeAbort.abort();
      this.localeAbort = new AbortController();
    }
    return true;
  }

  constructor(
    private readonly server: LoggedCuaServer,
    private readonly companion: CuaCompanionClient,
    private readonly log: Logger,
    private readonly runAgent: typeof runComputerUseAgent = runComputerUseAgent,
    observation?: DesktopObservationPort,
    private readonly translateMessage: typeof translateTeachingMessage = translateTeachingMessage,
  ) {
    this.observation = observation ?? new DesktopObservationClient(server);
  }

  submitAnswer(lessonId: string, answer: string): boolean {
    const accepted = this.lesson?.submitAnswer(lessonId, answer) ?? false;
    this.log.debug({ lessonId, accepted }, 'agent.teaching.student_input.admission');
    return accepted;
  }

  async run(
    message: string,
    locale: DesktopLocale,
    signal: AbortSignal,
    receiveStep?: ReceiveTeachingStep,
    classroom?: ClassroomTeachingSession,
  ): Promise<TeachingResult> {
    this.classroom = classroom;
    const lesson = new TeachingLessonContext(message, classroom?.context);
    const policy = new TeachingObservationPolicy();
    const budget = new TeachingPresentationBudget();
    this.lesson = lesson;
    this.locale = locale;
    this.requestedLocale = locale;
    this.receiveStep = receiveStep;
    this.localeAbort = new AbortController();
    const presenter = new TeachingPresenter(
      lesson,
      this.server,
      this.interactionTracker,
      budget,
      this.log,
      (presented) => {
        receiveStep?.(
          presented.text,
          TeachingLessonPhase.WAITING,
          lesson.id,
          presented,
          this.locale,
        );
      },
      () => {
        signal.throwIfAborted();
        if (this.locale !== this.requestedLocale) {
          throw new Error('Teaching locale changed.');
        }
      },
      (message) =>
        receiveStep?.(
          message.text,
          TeachingLessonPhase.OBSERVING,
          lesson.id,
          message,
          this.locale,
          true,
        ),
      (message) =>
        receiveStep?.(
          message.text,
          TeachingLessonPhase.OBSERVING,
          lesson.id,
          message,
          this.locale,
          false,
          true,
        ),
    );
    this.server.setTeachingPresenterRequired(true);
    this.server.setObservationListener((result) => {
      this.observation.recordCapture(result);
      lesson.recordObservation(result);
    });
    this.server.setPreviewAdmission(() => this.isObservationCurrent());
    let trigger = 'Initial request: assess the fresh current screen';
    let segmentNumber = 0;
    let stage: TeachingFailureStage = TeachingFailureStage.START_COMPANION;
    try {
      await this.companion.startFollowing();
      stage = TeachingFailureStage.START_OBSERVATION;
      await this.server.bindTeachingLesson(lesson.id);
      await this.beginObservation(lesson, signal);
      for (;;) {
        signal.throwIfAborted();
        this.companion.assertFollowingAvailable();
        await this.refreshLocale(lesson, signal);
        if (!policy.admitRun()) {
          stage = TeachingFailureStage.PAUSE_LESSON;
          await this.pauseLesson(lesson, this.locale, signal, receiveStep, true);
          trigger = 'Resource cooldown ended; original request remains unfinished';
          continue;
        }
        segmentNumber += 1;
        presenter.beginSegment();
        stage = TeachingFailureStage.RUN_MODEL;
        let result: { reply: ComputerUseAnswer; inputCount: number };
        try {
          result = await withAgentLogContext(
            { taskId: lesson.id, agentRole: AgentLogRole.MAIN, attemptNumber: segmentNumber },
            () => this.runSegment(lesson, trigger, presenter, budget, signal),
          );
        } catch (error) {
          signal.throwIfAborted();
          if (this.locale !== this.requestedLocale) {
            lesson.recordOperation({
              operation: 'locale_interrupted',
              locale: this.requestedLocale,
            });
            await this.refreshLocale(lesson, signal);
            trigger = 'Locale changed; assess the original request again';
            continue;
          }
          const retryReason = readTeachingModelRetryReason(error);
          if (retryReason) {
            const failure = describeTeachingFailure(error);
            this.log.warn(
              { ...failure, retryReason, lessonId: lesson.id, segmentNumber, stage },
              'agent.teaching.model_retry.paused',
            );
            stage = TeachingFailureStage.PAUSE_LESSON;
            const retryMessage =
              retryReason === TeachingModelRetryReason.CONNECTION_INTERRUPTED
                ? this.locale === DesktopLocale.VIETNAMESE
                  ? 'Kết nối đến mô hình bị gián đoạn. Mình đã giữ lại yêu cầu của bạn. Hãy trả lời để thử lại, hoặc nhấn Esc để dừng.'
                  : 'The model connection was interrupted. Your request is saved. Reply to retry, or press Esc to stop.'
                : retryReason === TeachingModelRetryReason.SERVICE_UNAVAILABLE
                  ? this.locale === DesktopLocale.VIETNAMESE
                    ? 'Dịch vụ mô hình hiện chưa phản hồi. Mình đã giữ lại yêu cầu của bạn. Hãy trả lời để thử lại, hoặc nhấn Esc để dừng.'
                    : 'The model service is temporarily unavailable. Your request is saved. Reply to retry, or press Esc to stop.'
                  : undefined;
            await this.pauseLesson(lesson, this.locale, signal, receiveStep, false, retryMessage);
            trigger = 'Student answered model-access retry question';
            continue;
          }
          throw error;
        }
        stage = TeachingFailureStage.CHECK_MODEL_RESULT;
        const { reply, inputCount } = result;
        // Retain tool/result pairs before deciding whether input superseded the screen.
        lesson.recordReply(reply.history, inputCount);
        const decision = reply.decision;
        logAgentExchange(this.log, {
          operation: 'teaching.decision',
          context: { lessonId: lesson.id, segmentNumber },
          input: { trigger, activity: this.interactionTracker.readEvidence() },
          output: decision,
        });
        const baseline = this.observation.readBaseline();
        if (!baseline) {
          throw new TeachingFailure(
            TeachingFailureCode.CAPTURE_BASELINE_MISSING,
            GuidanceReason.TRANSPORT_FAILED,
          );
        }
        policy.recordCapturedInput(baseline.input_revision);
        const current = await this.observation.read();
        const changedDuringRun =
          !current.ready ||
          current.buttons_down ||
          current.input_revision !== baseline.input_revision ||
          current.screen_width !== baseline.screen_width ||
          current.screen_height !== baseline.screen_height;
        this.log.debug(
          {
            segmentNumber,
            disposition: decision?.disposition ?? null,
            changedDuringRun,
            baseline: describeTeachingObservation(baseline),
            current: describeTeachingObservation(current),
            ...describeTeachingMessage(lesson.readMessage()),
          },
          'agent.teaching.observed',
        );
        if (changedDuringRun) {
          await this.waitForStableScreen(signal);
          trigger =
            'Real input or display geometry superseded the previous observation; assess fresh evidence without blaming the student';
          continue;
        }
        if (
          !decision ||
          decision.captureId !== lesson.readCaptureId() ||
          decision.goalRevisionId !== (lesson.readGoal()?.id ?? null)
        ) {
          lesson.recordOperation({
            operation: 'decision_refused',
            ...budget.reject('current_decision_required'),
          });
          trigger = 'Repair decision using current observation and current goal IDs';
          continue;
        }
        if (decision.disposition === TeachingDisposition.COMPLETE) {
          if (!decision.message || !lesson.hasReachedGoal(decision)) {
            lesson.recordOperation({
              operation: 'completion_refused',
              ...budget.reject('goal_evidence_required'),
            });
            trigger = 'Original goal has insufficient current evidence; continue teaching';
            continue;
          }
          const currentMessage = lesson.readMessage();
          receiveStep?.(
            decision.message,
            TeachingLessonPhase.WAITING,
            lesson.id,
            {
              lessonId: lesson.id,
              stepId: currentMessage?.stepId ?? randomUUID(),
              sequence: (currentMessage?.sequence ?? 0) + 1,
              kind: TeachingMessageKind.COMPLETION,
              text: decision.message,
            },
            this.locale,
          );
          return { outcome: TeachingOutcome.GOAL_REACHED, answer: decision.message };
        }
        if (decision.disposition === TeachingDisposition.ASK) {
          if (!decision.message || !decision.reason) {
            lesson.recordOperation({
              operation: 'question_refused',
              ...budget.reject('scoped_question_required'),
            });
            trigger = 'Ask only one specific question with a concrete missing-information reason';
            continue;
          }
          budget.confirm();
          lesson.askQuestion(decision.message);
          receiveStep?.(
            decision.message,
            TeachingLessonPhase.NEEDS_INPUT,
            lesson.id,
            lesson.readMessage() ?? undefined,
            this.locale,
          );
        } else {
          const receipt = presenter.readReceipt();
          if (!receipt || receipt.presentationId !== decision.presentationId) {
            lesson.recordOperation({
              operation: 'decision_refused',
              ...budget.reject('this_segment_presentation_required'),
            });
            trigger =
              'Call present_teaching_step successfully before yielding; final chat does not display a drawing';
            continue;
          }
          if (
            decision.disposition === TeachingDisposition.OBSERVE_AGAIN &&
            lesson.readGoal()?.purpose === 'tour'
          ) {
            trigger =
              'Requested tour: continue to the next grounded highlight after the acknowledged cue';
            continue;
          }
          if (
            decision.disposition === TeachingDisposition.OBSERVE_AGAIN &&
            (lesson.readCurrentStep()?.proposal.action.kind !== 'wait' || !decision.reason)
          ) {
            lesson.recordOperation({
              operation: 'decision_refused',
              ...budget.reject('loading_evidence_required'),
            });
            trigger =
              'Observe-again requires an acknowledged wait action and visible loading reason';
            continue;
          }
          policy.recordAssessment(decision.disposition !== TeachingDisposition.OBSERVE_AGAIN);
        }
        lesson.setWaitingForStudent(true);
        if (decision.disposition !== TeachingDisposition.ASK) {
          receiveStep?.(
            lesson.readInstruction(),
            TeachingLessonPhase.WAITING,
            lesson.id,
            lesson.readMessage() ?? undefined,
            this.locale,
            false,
            false,
            true,
          );
        }
        stage = TeachingFailureStage.WAIT_FOR_STUDENT;
        this.log.debug({ segmentNumber, canAcceptAnswer: true }, 'agent.teaching.waiting.locally');
        try {
          trigger = await this.waitForResume(lesson, baseline, policy, signal);
        } finally {
          lesson.setWaitingForStudent(false);
        }
        receiveStep?.(
          lesson.readInstruction(),
          TeachingLessonPhase.OBSERVING,
          lesson.id,
          lesson.readMessage() ?? undefined,
          this.locale,
        );
      }
    } catch (error) {
      if (!signal.aborted) {
        this.log.error({ stage, ...describeTeachingFailure(error) }, 'agent.teaching.failed');
      }
      return signal.aborted
        ? { outcome: TeachingOutcome.CANCELED, reason: GuidanceReason.EXPLICIT_STOP }
        : {
            outcome: TeachingOutcome.FAILED,
            reason:
              error instanceof GuidanceTaskError ? error.reason : GuidanceReason.TRANSPORT_FAILED,
          };
    } finally {
      this.lesson = null;
      this.receiveStep = undefined;
      this.server.setTeachingPresenterRequired(false);
      this.server.setObservationListener(null);
      this.server.setPreviewAdmission(null);
      this.companion.setFollowingFailureListener(null);
      await this.observation.end().catch(() => {});
      this.server.endTeachingTask();
    }
  }

  private async runSegment(
    lesson: TeachingLessonContext,
    trigger: string,
    presenter: TeachingPresenter,
    budget: TeachingPresentationBudget,
    signal: AbortSignal,
  ): Promise<{ reply: ComputerUseAnswer; inputCount: number }> {
    const epoch = randomUUID();
    const terminal = new AbortController();
    const locale = this.locale;
    this.companion.setFollowingFailureListener(() => {
      terminal.abort();
    });
    this.server.beginTeachingTask(epoch, () => {
      if (!this.server.taskEvidence.wasInterruptedByStudent()) {
        terminal.abort();
      }
    });
    let started = false;
    try {
      await this.waitForStableScreen(signal);
      await this.companion.beginGuidanceTask(epoch);
      started = true;
      const capture = await this.server.callToolResult('get_desktop_state', {});
      if (capture.isError || !lesson.readCaptureId()) {
        throw new TeachingFailure(
          TeachingFailureCode.CAPTURE_BASELINE_MISSING,
          GuidanceReason.TRANSPORT_FAILED,
        );
      }
      const input = lesson.buildInput(trigger, this.interactionTracker.readEvidence());
      logAgentExchange(this.log, {
        operation: 'teaching.segment.input',
        context: { lessonId: lesson.id },
        input,
        output: null,
      });
      const reply = await this.runAgent(
        createTeachingAgent(
          this.server,
          locale,
          {
            defineGoal: (definition) => lesson.defineGoal(definition),
            reviseGoal: (revision) => lesson.reviseGoal(revision),
            reportInvalidProposal: (rejection) => {
              lesson.recordOperation({
                operation: 'invalid_proposal',
                issues: rejection.issues,
                ...budget.reject('invalid_tool_input'),
              });
            },
            presentStep: async (proposal) => {
              const baseline = this.observation.readBaseline();
              const current = await this.observation.read();
              if (
                baseline &&
                (baseline.input_revision !== current.input_revision || current.buttons_down)
              ) {
                lesson.recordOperation({
                  operation: 'presentation_superseded_by_input',
                  captureId: proposal.captureId,
                });
                return {
                  admitted: false,
                  reason: 'student_input_superseded',
                  repair:
                    'Yield; the host will provide a fresh screen after physical input settles.',
                };
              }
              return presenter.presentStep(proposal, locale);
            },
          },
          this.classroom,
        ),
        input,
        AbortSignal.any([
          signal,
          terminal.signal,
          this.localeAbort.signal,
          AbortSignal.timeout(TeachingObservationLimits.MODEL_STEP_MS),
        ]),
        TeachingObservationLimits.MAXIMUM_MODEL_TURNS,
      );
      signal.throwIfAborted();
      this.companion.assertFollowingAvailable();
      if (locale !== this.requestedLocale) {
        throw new Error('Teaching locale changed.');
      }
      if (
        this.server.taskEvidence.hasTerminalGuidance() &&
        !this.server.taskEvidence.wasInterruptedByStudent()
      ) {
        const native = this.server.taskEvidence.readTeachingResult('');
        throw new GuidanceTaskError(
          'reason' in native ? native.reason : GuidanceReason.TRANSPORT_FAILED,
        );
      }
      return { reply, inputCount: input.length };
    } finally {
      this.companion.setFollowingFailureListener(null);
      await this.server.settleCalls();
      if (started && !signal.aborted) {
        await this.endGuidanceSegment(epoch);
      }
    }
  }

  private async endGuidanceSegment(epoch: string): Promise<void> {
    try {
      await this.companion.endGuidanceTask(epoch);
    } catch (error) {
      if (!(error instanceof GuidanceTaskError) || error.reason !== GuidanceReason.USER_TAKEOVER) {
        throw error;
      }
    }
  }

  private async beginObservation(
    lesson: TeachingLessonContext,
    signal: AbortSignal,
  ): Promise<void> {
    await this.observation.begin(lesson.id);
    const startedAt = performance.now();
    const timeoutMs = TeachingObservationLimits.OBSERVATION_READY_MS;
    let pollCount = 0;
    for (;;) {
      signal.throwIfAborted();
      const current = await this.observation.read();
      pollCount += 1;
      signal.throwIfAborted();
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (current.ready) {
        this.log.debug(
          { elapsedMs, pollCount, observation: describeTeachingObservation(current) },
          'agent.teaching.observation_ready',
        );
        return;
      }
      if (elapsedMs >= timeoutMs) {
        throw new TeachingFailure(
          TeachingFailureCode.OBSERVATION_READY_TIMEOUT,
          GuidanceReason.TRANSPORT_FAILED,
          { timeoutMs, elapsedMs, pollCount, observation: describeTeachingObservation(current) },
        );
      }
      await waitForLessonPoll(signal);
    }
  }

  private async isObservationCurrent(): Promise<boolean> {
    const baseline = this.observation.readBaseline();
    const current = await this.observation.read();
    return (
      baseline !== null &&
      current.ready &&
      !current.buttons_down &&
      current.quiet_ms >= TeachingObservationLimits.QUIET_MS &&
      baseline.input_revision === current.input_revision &&
      baseline.screen_width === current.screen_width &&
      baseline.screen_height === current.screen_height
    );
  }

  /** Wait for settled physical input without requiring a globally still desktop. */
  private async waitForStableScreen(signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + TeachingObservationLimits.OBSERVATION_READY_MS;
    for (;;) {
      signal.throwIfAborted();
      this.companion.assertFollowingAvailable();
      const current = await this.observation.read();
      if (
        current.ready &&
        !current.buttons_down &&
        current.quiet_ms >= TeachingObservationLimits.QUIET_MS
      ) {
        return;
      }
      if (performance.now() >= deadline) {
        throw new TeachingFailure(
          TeachingFailureCode.OBSERVATION_READY_TIMEOUT,
          GuidanceReason.TRANSPORT_FAILED,
        );
      }
      await waitForLessonPoll(signal);
    }
  }

  private async waitForResume(
    lesson: TeachingLessonContext,
    baseline: DesktopObservation,
    policy: TeachingObservationPolicy,
    signal: AbortSignal,
  ): Promise<string> {
    for (;;) {
      signal.throwIfAborted();
      this.companion.assertFollowingAvailable();
      await this.refreshLocale(lesson, signal);
      if (lesson.hasAnswer()) {
        return 'The student supplied a question answer or follow-up instruction';
      }
      const current = await this.observation.read();
      if (policy.canObserve(baseline, current) && !lesson.canAnswer()) {
        const reason = policy.readWakeReason(baseline, current);
        this.log.debug(
          { wakeReason: reason, observation: describeTeachingObservation(current) },
          'agent.teaching.woke',
        );
        return `${reason}: observe fresh evidence; activity is not proof of success`;
      }
      await waitForLessonPoll(signal);
    }
  }

  private async refreshLocale(lesson: TeachingLessonContext, signal: AbortSignal): Promise<void> {
    while (this.locale !== this.requestedLocale) {
      const locale = this.requestedLocale;
      const current = lesson.readMessage();
      if (!current) {
        this.locale = locale;
        return;
      }
      const status =
        locale === DesktopLocale.VIETNAMESE ? 'Đang đổi ngôn ngữ…' : 'Changing language…';
      const pending = lesson.createStatusMessage(status);
      this.receiveStep?.(
        status,
        TeachingLessonPhase.OBSERVING,
        lesson.id,
        pending ?? undefined,
        locale,
      );
      try {
        const text = await this.translateMessage(
          current.text,
          locale,
          AbortSignal.any([
            signal,
            this.localeAbort.signal,
            AbortSignal.timeout(TeachingObservationLimits.MODEL_STEP_MS),
          ]),
        );
        signal.throwIfAborted();
        if (locale !== this.requestedLocale) {
          continue;
        }
        const message = lesson.replaceMessageText(text);
        this.locale = locale;
        this.receiveStep?.(
          text,
          lesson.canAnswer() ? TeachingLessonPhase.NEEDS_INPUT : TeachingLessonPhase.WAITING,
          lesson.id,
          message ?? undefined,
          locale,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (locale !== this.requestedLocale) {
          continue;
        }
        this.locale = locale;
        const question =
          locale === DesktopLocale.VIETNAMESE
            ? 'Chưa đổi được ngôn ngữ. Trả lời để mình thử lại nhé.'
            : 'Could not change the language. Reply to retry.';
        lesson.askQuestion(question);
        this.receiveStep?.(
          question,
          TeachingLessonPhase.NEEDS_INPUT,
          lesson.id,
          lesson.readMessage() ?? undefined,
          locale,
        );
        this.log.warn(
          { errorType: error instanceof Error ? error.name : typeof error },
          'agent.teaching.translation_failed',
        );
      }
    }
  }

  private async pauseLesson(
    lesson: TeachingLessonContext,
    locale: DesktopLocale,
    signal: AbortSignal,
    receiveStep: ReceiveTeachingStep | undefined,
    cooldown: boolean,
    screenQuestion?: string,
  ): Promise<void> {
    await this.observation.end();
    const instruction =
      locale === DesktopLocale.VIETNAMESE
        ? 'Yêu cầu của bạn chưa hoàn tất. Mình sẽ tiếp tục hướng dẫn sau một chút.'
        : 'Your request is still unfinished. I will continue guiding you shortly.';
    const question =
      screenQuestion ??
      (cooldown
        ? instruction
        : locale === DesktopLocale.VIETNAMESE
          ? 'Hiện chưa thể truy cập mô hình. Yêu cầu vẫn chưa hoàn tất. Hãy trả lời khi bạn muốn mình thử lại.'
          : 'Model access is unavailable. Your task is unfinished. Reply when you want me to retry.');
    lesson.askQuestion(question);
    receiveStep?.(
      question,
      TeachingLessonPhase.PAUSED,
      lesson.id,
      lesson.readMessage() ?? undefined,
      this.locale,
    );
    const deadline = performance.now() + (cooldown ? 60000 : Number.POSITIVE_INFINITY);
    while (cooldown ? performance.now() < deadline : !lesson.hasAnswer()) {
      this.companion.assertFollowingAvailable();
      await this.refreshLocale(lesson, signal);
      await waitForLessonPoll(signal);
    }
    await this.beginObservation(lesson, signal);
  }
}
