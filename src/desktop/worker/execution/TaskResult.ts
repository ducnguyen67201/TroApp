import type { AgentResult } from '#contracts/AgentSession.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import type { CompletionProposal } from './TaskCompletionProposal.js';
import type { TaskAssessment } from './TaskVerification.js';

const ReplyText = {
  [DesktopLocale.ENGLISH]: {
    succeeded: 'The requested task is complete.',
    partial: 'Part of the task is complete, but Tro could not confirm all required results.',
    blocked: 'Tro could not continue the requested task.',
    unverified: 'Tro could not confirm the requested result.',
    invalid: 'Tro could not produce a valid task result.',
  },
  [DesktopLocale.VIETNAMESE]: {
    succeeded: 'Đã hoàn tất yêu cầu.',
    partial: 'Đã hoàn tất một phần yêu cầu, nhưng Tro chưa thể xác nhận tất cả kết quả cần thiết.',
    blocked: 'Tro không thể tiếp tục yêu cầu này.',
    unverified: 'Tro chưa thể xác nhận kết quả yêu cầu.',
    invalid: 'Tro chưa thể tạo kết quả hợp lệ cho yêu cầu này.',
  },
} satisfies Record<DesktopLocale, Record<TaskAssessment['status'] | 'invalid', string>>;

/** Never display a model's unsupported "Done" as a successful outcome. */
export function createTaskResult(
  assessment: TaskAssessment,
  proposal: CompletionProposal | null,
  locale: DesktopLocale,
): AgentResult {
  if (assessment.mode === CompletionMode.RESPONSE && proposal) {
    return {
      kind: 'completed',
      answer: proposal.answer,
      completion: { kind: CompletionMode.RESPONSE },
    };
  }
  if (assessment.required === 0) {
    return { kind: 'failed', message: ReplyText[locale].invalid };
  }
  const succeeded = assessment.status === TaskOutcomeStatus.SUCCEEDED;
  const limitation = succeeded
    ? null
    : assessment.limitation
      ? assessment.limitation
      : ReplyText[locale][assessment.status];
  return {
    kind: 'completed',
    answer:
      succeeded && proposal
        ? proposal.answer
        : (limitation ?? ReplyText[locale][assessment.status]),
    completion: {
      kind: CompletionMode.TASK,
      outcome: {
        status: assessment.status,
        requiredCriteriaCount: assessment.required,
        supportedCriteriaCount: assessment.supported,
        remainingCriteriaCount: assessment.required - assessment.supported,
        limitation,
      },
    },
  };
}
