import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Alert,
  Badge,
  Button,
  FileInput,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { ClassroomPhase, type TeachingContext } from '#contracts/Classroom.js';
import {
  PracticeCheckStatus,
  PracticeFinding,
  PracticeLimits,
  type PracticeCommand,
  type PracticeEvidence,
  type PracticeRecord,
  type WorkSubmission,
} from '#contracts/PracticeCheck.js';
import { useLocale } from '../localization/UseLocale.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
export function formatPracticeFinding(
  finding: PracticeFinding | null,
  t: ClassroomTranslate,
): string {
  return finding === PracticeFinding.MET
    ? t('Meets checked requirements', 'Đạt yêu cầu đã kiểm tra')
    : finding === PracticeFinding.NEEDS_CHANGES
      ? t('Needs changes', 'Cần chỉnh sửa')
      : finding === PracticeFinding.INSUFFICIENT_EVIDENCE
        ? t('More evidence needed', 'Cần thêm bằng chứng')
        : t('Not checked', 'Chưa kiểm tra');
}

async function readPracticeFile(file: File): Promise<PracticeEvidence> {
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    if (file.size > PracticeLimits.IMAGE_BYTES) {
      throw new Error('Image too large.');
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Unreadable image.'));
        }
      };
      reader.onerror = () => {
        reject(new Error('Unreadable image.'));
      };
      reader.readAsDataURL(file);
    });
    const base64 = data.split(',')[1];
    if (!base64) {
      throw new Error('Unreadable image.');
    }
    return {
      id: crypto.randomUUID(),
      kind: 'image',
      name: file.name,
      mediaType: file.type,
      base64,
    };
  }
  if (!/\.(txt|md|py|js|ts|html|css)$/i.test(file.name) || file.size > 48000) {
    throw new Error('Unsupported file.');
  }
  const text = await file.text();
  if (!text.trim() || text.length > PracticeLimits.TEXT_CHARACTERS) {
    throw new Error('Text too large.');
  }
  return { id: crypto.randomUUID(), kind: 'text', name: file.name, text };
}

/** Explicit preview/check/hand-in. Historical findings never assert that later edits pass. */
export function PracticeCheckPanel({
  context,
  practiceReview,
  t,
  onAskForHelp,
}: {
  context: TeachingContext;
  practiceReview?: PracticeShortcutEvent | undefined;
  t: ClassroomTranslate;
  onAskForHelp?: (message: string) => void;
}): ReactElement | null {
  const { locale } = useLocale();
  const checkpoints = context.activity.practiceCheckpoints?.filter((item) => item.approved) ?? [];
  const [checkpointId, setCheckpointId] = useState(checkpoints[0]?.id ?? null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PracticeEvidence[]>([]);
  const [check, setCheck] = useState<PracticeRecord | null>(null);
  const [history, setHistory] = useState<PracticeRecord[]>([]);
  const [submissions, setSubmissions] = useState<WorkSubmission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const workInput = useRef<HTMLTextAreaElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<PracticeEvidence[] | null>(null);
  const generation = useRef(0),
    inFlight = useRef(false),
    checkRequest = useRef<Extract<PracticeCommand, { kind: 'check' }> | null>(null),
    submitRequest = useRef<{ checkId: string; requestId: string } | null>(null);
  const binding = {
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
  };
  const mutation = {
    ...binding,
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
  };
  const checkpoint = checkpoints.find((item) => item.id === checkpointId);
  const enabled =
    context.meeting.phase === ClassroomPhase.PRACTICE && Boolean(window.tro.controlPractice);

  async function refresh(): Promise<void> {
    const version = generation.current;
    const reply = await window.tro.controlPractice?.({ kind: 'history', ...binding });
    if (version !== generation.current) {
      return;
    }
    if (reply?.kind === 'history') {
      setHistory(reply.checks);
      setSubmissions(reply.submissions);
      setCheck((current) =>
        current ? (reply.checks.find((item) => item.id === current.id) ?? current) : current,
      );
      setError(null);
    } else {
      setError(
        t(
          'Could not load check history. Try refresh.',
          'Chưa tải được lịch sử kiểm tra. Hãy cập nhật lại.',
        ),
      );
    }
  }

  useEffect(() => {
    generation.current += 1;
    setReview(false);
    setConfirm(false);
    setCheck(null);
    setHistory([]);
    setSubmissions([]);
    setError(null);
    setBusy(false);
    inFlight.current = false;
    checkRequest.current = null;
    submitRequest.current = null;
    if (checkpoints.length) {
      void refresh();
    }
    return () => {
      generation.current += 1;
    };
    // Authoritative context updates fence responses; evidence stays available for a fresh check.
  }, [context.attempt.id, context.meeting.contextVersion, context.attempt.progressVersion]);
  useEffect(() => {
    if (!check || check.status !== PracticeCheckStatus.RUNNING) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [check?.id, check?.status, context.attempt.id]);

  useEffect(() => {
    if (
      !practiceReview ||
      practiceReview.attemptId !== context.attempt.id ||
      practiceReview.participationId !== context.participation.id ||
      practiceReview.activityId !== context.activity.id ||
      practiceReview.contextVersion !== context.meeting.contextVersion ||
      !enabled ||
      busy
    ) {
      return;
    }
    panel.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setReview(true);
  }, [practiceReview?.requestId]);

  const canCheck =
    enabled &&
    Boolean(checkpoint) &&
    !busy &&
    Boolean(text.trim() || files.length) &&
    files.length + (text.trim() ? 1 : 0) <= 3 &&
    check?.status !== PracticeCheckStatus.RUNNING &&
    check?.status !== PracticeCheckStatus.COMPLETED;

  function checkWork(): void {
    if (!canCheck || !checkpoint || inFlight.current) {
      return;
    }
    const command = checkRequest.current ?? {
      kind: 'check' as const,
      ...mutation,
      checkpointId: checkpoint.id,
      requestId: crypto.randomUUID(),
      locale,
      evidence: [
        ...(text.trim()
          ? [
              {
                id: crypto.randomUUID(),
                kind: 'text' as const,
                name: t('Pasted work', 'Bài đã nhập'),
                text: text.trim(),
              },
            ]
          : []),
        ...files.map((item) => ({ ...item, id: crypto.randomUUID() })),
      ],
    };
    checkRequest.current = command;
    setReview(false);
    void run(command);
  }

  function changeWork(): void {
    setCheck(null);
    checkRequest.current = null;
    submitRequest.current = null;
    setError(null);
  }

  async function run(command: PracticeCommand): Promise<void> {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const version = generation.current;
    try {
      const reply = await window.tro.controlPractice?.(command);
      if (version !== generation.current) {
        return;
      }
      if (reply?.kind === 'check') {
        setCheck(reply.check);
        checkRequest.current = null;
        await refresh();
      } else if (reply?.kind === 'submitted') {
        submitRequest.current = null;
        setConfirm(false);
        await refresh();
      } else if (reply?.kind === 'evidence') {
        setPreview(reply.evidence);
      } else if (reply?.kind === 'help') {
        onAskForHelp?.(reply.message);
      } else {
        setError(
          reply?.kind === 'failed' && reply.code === 'limit'
            ? t(
                'Check allowance reached. Try later or ask your teacher.',
                'Đã hết lượt kiểm tra. Thử sau hoặc hỏi giáo viên.',
              )
            : t(
                'Could not complete this action. Refresh status before retrying; your work is kept.',
                'Chưa hoàn tất thao tác. Cập nhật trạng thái trước khi thử lại; bài của bạn được giữ.',
              ),
        );
      }
    } catch {
      if (version === generation.current) {
        setError(
          t(
            'Connection lost. Refresh check status before retrying.',
            'Mất kết nối. Cập nhật trạng thái kiểm tra trước khi thử lại.',
          ),
        );
      }
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  if (checkpoints.length === 0) {
    return null;
  }
  return (
    <Stack ref={panel} className="practice-check-panel" gap="sm">
      <Group justify="space-between">
        <Text fw={600}>{t('Check your practice', 'Kiểm tra bài thực hành')}</Text>
        <Badge variant="light">{t('Feedback, not a grade', 'Phản hồi, không phải điểm số')}</Badge>
      </Group>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {t('Cmd/Ctrl + Shift + Enter · Review work', 'Cmd/Ctrl + Shift + Enter · Xem lại bài')}
        </Text>
        <Button
          size="xs"
          variant="subtle"
          disabled={!enabled || busy}
          onClick={() => {
            setReview(true);
          }}
        >
          {t('Review work', 'Xem lại bài')}
        </Button>
      </Group>
      <Select
        label={t('Practice task', 'Bài thực hành')}
        value={checkpointId}
        data={checkpoints.map((item) => ({ value: item.id, label: item.title }))}
        disabled={busy}
        onChange={(id) => {
          setCheckpointId(id);
          changeWork();
        }}
      />
      {checkpoint && (
        <>
          <Text size="sm">{checkpoint.task}</Text>
          <details>
            <summary>{t('What will be checked', 'Các yêu cầu sẽ kiểm tra')}</summary>
            <Stack mt="xs">
              {checkpoint.criteria.map((item) => (
                <Text size="sm" key={item.id}>
                  {item.description} · {item.evidenceNeeded}
                  {!item.required ? ` · ${t('Optional', 'Không bắt buộc')}` : ''}
                </Text>
              ))}
            </Stack>
          </details>
        </>
      )}
      {!enabled && (
        <Alert>
          {t(
            'Checks and hand-in open during Practice.',
            'Kiểm tra và nộp bài mở trong giai đoạn Thực hành.',
          )}
        </Alert>
      )}
      <Textarea
        ref={workInput}
        label={t('Your work or code', 'Bài làm hoặc mã của bạn')}
        description={t(
          'Include output when the requirement is about behavior. Code is not executed.',
          'Thêm kết quả chạy nếu yêu cầu liên quan đến hành vi. Mã không được thực thi.',
        )}
        value={text}
        maxLength={12000}
        autosize
        minRows={3}
        maxRows={12}
        disabled={busy}
        onChange={(event) => {
          setText(event.currentTarget.value);
          changeWork();
        }}
      />
      <FileInput
        label={t('Add evidence', 'Thêm bằng chứng')}
        description={t(
          'PNG/JPEG up to 1 MB, or text/code. Up to 3 items.',
          'PNG/JPEG tối đa 1 MB, hoặc văn bản/mã. Tối đa 3 mục.',
        )}
        accept="image/png,image/jpeg,.txt,.md,.py,.js,.ts,.html,.css"
        value={null}
        disabled={busy || files.length >= 3}
        onChange={(file) => {
          if (file) {
            const version = generation.current;
            setBusy(true);
            void readPracticeFile(file)
              .then((item) => {
                if (version === generation.current) {
                  setFiles((current) => [...current, item]);
                  changeWork();
                }
              })
              .catch(() => {
                if (version === generation.current) {
                  setError(
                    t(
                      'Use PNG/JPEG under 1 MB or a text/code file under 12,000 characters.',
                      'Dùng PNG/JPEG dưới 1 MB hoặc tệp văn bản/mã dưới 12.000 ký tự.',
                    ),
                  );
                }
              })
              .finally(() => {
                if (version === generation.current) {
                  setBusy(false);
                }
              });
          }
        }}
      />
      {files.map((item) => (
        <Stack key={item.id} gap={4}>
          <Group justify="space-between">
            <Text size="sm">{item.name}</Text>
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              onClick={() => {
                setFiles((current) => current.filter((entry) => entry.id !== item.id));
                changeWork();
              }}
            >
              {t('Remove', 'Xóa')}
            </Button>
          </Group>
          {item.kind === 'image' ? (
            <img
              className="practice-evidence-preview"
              src={`data:${item.mediaType};base64,${item.base64}`}
              alt={item.name}
            />
          ) : (
            <details>
              <summary>{t('Preview text', 'Xem văn bản')}</summary>
              <pre className="practice-evidence-text">{item.text}</pre>
            </details>
          )}
        </Stack>
      ))}
      <Text size="xs" c="dimmed">
        {t(
          'Checking sends this evidence to AI and stores the selected version privately for you and your teacher. Review it before sending.',
          'Kiểm tra gửi bằng chứng này đến AI và lưu riêng phiên bản đã chọn cho bạn và giáo viên. Xem lại trước khi gửi.',
        )}
      </Text>
      {error && <Alert role="alert">{error}</Alert>}
      <Group>
        <Button loading={busy} disabled={!canCheck} onClick={checkWork}>
          {busy && checkRequest.current
            ? t('Checking…', 'Đang kiểm tra…')
            : check
              ? t('Check again', 'Kiểm tra lại')
              : checkRequest.current
                ? t('Retry same check', 'Thử lại lượt kiểm tra')
                : t('Check my work', 'Kiểm tra bài')}
        </Button>
        <Button
          variant="subtle"
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
        >
          {t('Refresh status', 'Cập nhật trạng thái')}
        </Button>
      </Group>
      {check?.status === PracticeCheckStatus.COMPLETED && (
        <Text size="xs" c="dimmed">
          {t(
            'Update the evidence above before checking changes in your app.',
            'Cập nhật bằng chứng ở trên trước khi kiểm tra thay đổi trong ứng dụng.',
          )}
        </Text>
      )}
      {check && (
        <Stack className="practice-feedback" gap="sm" aria-live="polite">
          <Text size="xs" c="dimmed">
            {t(
              'AI feedback for the saved evidence · not your later edits',
              'Phản hồi AI cho bằng chứng đã lưu · không áp dụng cho thay đổi sau đó',
            )}
          </Text>
          {check.status === PracticeCheckStatus.RUNNING ? (
            <Group role="status">
              <Loader size="sm" />
              <Text>{t('Checking…', 'Đang kiểm tra…')}</Text>
            </Group>
          ) : check.status === PracticeCheckStatus.FAILED ? (
            <Alert>
              {t(
                'This check could not finish. Refresh or start a fresh check. This is not a judgment of your work.',
                'Lượt kiểm tra chưa hoàn tất. Cập nhật hoặc tạo lượt mới. Đây không phải đánh giá bài của bạn.',
              )}
            </Alert>
          ) : (
            <>
              <Badge size="lg" color={check.finding === PracticeFinding.MET ? 'green' : 'orange'}>
                {formatPracticeFinding(check.finding, t)}
              </Badge>
              {check.results.map((result) => (
                <Stack key={result.criterionId} className="practice-criterion-result" gap={5}>
                  <Text fw={500} size="sm">
                    {
                      check.rubric.criteria.find((item) => item.id === result.criterionId)
                        ?.description
                    }
                  </Text>
                  <Text size="xs" fw={600}>
                    {formatPracticeFinding(result.finding, t)}
                  </Text>
                  <Text size="sm">{result.feedback}</Text>
                  {result.finding !== PracticeFinding.MET && onAskForHelp && (
                    <Button
                      size="xs"
                      variant="default"
                      disabled={busy || !enabled}
                      onClick={() => {
                        void run({
                          kind: 'help',
                          ...binding,
                          checkId: check.id,
                          criterionId: result.criterionId,
                          locale,
                        });
                      }}
                    >
                      {t('Help me with this', 'Giúp tôi phần này')}
                    </Button>
                  )}
                </Stack>
              ))}
              <Group>
                <Button
                  disabled={busy || !enabled}
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  {t('Hand in this version', 'Nộp phiên bản này')}
                </Button>
                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => {
                    void run({ kind: 'read-evidence', checkId: check.id });
                  }}
                >
                  {t('View saved evidence', 'Xem bằng chứng đã lưu')}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      )}
      {submissions[0] && (
        <Alert>
          {t('Hand-in saved. Revision', 'Đã lưu bài nộp. Phiên bản')} {submissions[0].sequence} ·{' '}
          {new Date(submissions[0].submittedAt).toLocaleString(locale)}.{' '}
          {t('A hand-in is not a passing result.', 'Nộp bài không có nghĩa là đạt yêu cầu.')}
        </Alert>
      )}
      {history.length > 0 && (
        <details>
          <summary>{t('Previous checks', 'Các lượt kiểm tra trước')}</summary>
          <Stack mt="xs">
            {history.map((item) => (
              <Button
                key={item.id}
                variant="subtle"
                disabled={busy}
                onClick={() => {
                  setCheckpointId(item.checkpointId);
                  setCheck(item);
                  checkRequest.current = null;
                }}
              >
                {item.rubric.title} · {new Date(item.createdAt).toLocaleString(locale)} ·{' '}
                {item.status === PracticeCheckStatus.COMPLETED
                  ? formatPracticeFinding(item.finding, t)
                  : item.status === PracticeCheckStatus.RUNNING
                    ? t('Checking', 'Đang kiểm tra')
                    : t('Could not check', 'Chưa kiểm tra được')}
              </Button>
            ))}
          </Stack>
        </details>
      )}
      <Modal
        opened={review}
        onClose={() => {
          setReview(false);
        }}
        title={t('Review your practice', 'Xem lại bài thực hành')}
      >
        <Stack>
          <Text fw={600}>
            {context.className} · {context.activity.title}
          </Text>
          <Text>{checkpoint?.title}</Text>
          {busy || check?.status === PracticeCheckStatus.RUNNING ? (
            <Group role="status">
              <Loader size="sm" />
              <Text>{t('Checking…', 'Đang kiểm tra…')}</Text>
            </Group>
          ) : check?.status === PracticeCheckStatus.COMPLETED ? (
            <>
              <Text>{formatPracticeFinding(check.finding, t)}</Text>
              <Text size="xs" c="dimmed">
                {t('Saved evidence from this check', 'Bằng chứng đã lưu từ lượt này')}
              </Text>
              {check.evidence.map((item) => (
                <Text key={item.id} size="sm">
                  {item.name}
                </Text>
              ))}
              <Button
                disabled={!enabled}
                onClick={() => {
                  setReview(false);
                  setConfirm(true);
                }}
              >
                {t('Hand in this version', 'Nộp phiên bản này')}
              </Button>
            </>
          ) : (
            <>
              <PracticeEvidencePreview
                evidence={[
                  ...(text.trim()
                    ? [
                        {
                          id: 'draft-text',
                          kind: 'text' as const,
                          name: t('Pasted work', 'Bài đã nhập'),
                          text: text.trim(),
                        },
                      ]
                    : []),
                  ...files,
                ]}
              />
              {!text.trim() && files.length === 0 && (
                <Text size="sm">
                  {t(
                    'Add your work, a file or an image first. This shortcut does not capture your open app.',
                    'Thêm bài làm, tệp hoặc ảnh trước. Phím tắt này không chụp ứng dụng đang mở.',
                  )}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {t(
                  'Checking sends only the evidence shown here. Hand-in is a separate confirmation.',
                  'Kiểm tra chỉ gửi bằng chứng hiển thị ở đây. Nộp bài cần xác nhận riêng.',
                )}
              </Text>
              <Button disabled={!canCheck} onClick={checkWork}>
                {t('Check my work', 'Kiểm tra bài')}
              </Button>
            </>
          )}
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              setReview(false);
              panel.current?.scrollIntoView({ block: 'center' });
              workInput.current?.focus();
            }}
          >
            {t('Edit evidence', 'Sửa bằng chứng')}
          </Button>
        </Stack>
      </Modal>
      <Modal
        opened={confirm}
        onClose={() => {
          if (!busy) {
            setConfirm(false);
          }
        }}
        title={t('Confirm hand-in', 'Xác nhận nộp bài')}
      >
        <Stack>
          <Text fw={600}>
            {context.className} · {context.activity.title}
          </Text>
          <Text>{check?.rubric.title}</Text>
          <Text size="xs" c="dimmed">
            {check && new Date(check.createdAt).toLocaleString(locale)}
          </Text>
          {check?.evidence.map((item) => (
            <Text key={item.id} size="sm">
              {item.name}
            </Text>
          ))}
          <Text size="sm">
            {t(
              'Hand in exactly the evidence from this check, including its feedback. Later edits in your app are not included. You may hand in a version that needs changes.',
              'Nộp đúng bằng chứng từ lượt kiểm tra này cùng phản hồi. Thay đổi sau đó trong ứng dụng không được bao gồm. Bạn vẫn có thể nộp phiên bản cần chỉnh sửa.',
            )}
          </Text>
          <Group>
            <Button
              variant="default"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t('Cancel', 'Hủy')}
            </Button>
            <Button
              loading={busy}
              onClick={() => {
                if (check) {
                  const request =
                    submitRequest.current?.checkId === check.id
                      ? submitRequest.current
                      : { checkId: check.id, requestId: crypto.randomUUID() };
                  submitRequest.current = request;
                  void run({ kind: 'submit-snapshot', locale, ...mutation, ...request });
                }
              }}
            >
              {t('Confirm hand-in', 'Xác nhận nộp bài')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={preview !== null}
        onClose={() => {
          setPreview(null);
        }}
        title={t('Saved evidence', 'Bằng chứng đã lưu')}
        size="lg"
      >
        <PracticeEvidencePreview evidence={preview ?? []} />
      </Modal>
    </Stack>
  );
}

export function PracticeEvidencePreview({
  evidence,
}: {
  evidence: PracticeEvidence[];
}): ReactElement {
  return (
    <Stack>
      {evidence.map((item) => (
        <Stack key={item.id}>
          <Text fw={500}>{item.name}</Text>
          {item.kind === 'image' ? (
            <img
              className="practice-evidence-preview"
              src={`data:${item.mediaType};base64,${item.base64}`}
              alt={item.name}
            />
          ) : (
            <pre className="practice-evidence-text">{item.text}</pre>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
