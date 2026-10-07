import { MaterialFailure } from '#contracts/ClassroomMaterials.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Title,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import {
  MaterialLimits,
  MaterialState,
  MaterialIssue,
  type MaterialCollection,
  type MaterialCommand,
  type MaterialReply,
} from '#contracts/ClassroomMaterials.js';
import { useLocale } from '../localization/UseLocale.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import { MaterialFiles } from './MaterialFiles.js';
import { MaterialReview } from './MaterialReview.js';

/** Teacher edits are separate from extraction, and polling never replaces unsaved review changes. */
export function MaterialEditor({
  classId,
  live,
  t,
  onApproved,
  sessionControls,
  preparationSidebar,
}: {
  classId: string;
  live: boolean;
  t: ClassroomTranslate;
  onApproved: () => Promise<void>;
  sessionControls?: ReactElement;
  preparationSidebar?: HTMLElement | null;
}): ReactElement {
  const { locale } = useLocale();
  const [collection, setCollection] = useState<MaterialCollection | null>(null);
  const [intent, setIntent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [hasReviewEdits, setReviewEdits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isRequestingPreparation, setRequestingPreparation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [revisionRequest, setRevisionRequest] = useState('');
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const mounted = useRef(true);
  const activeClassId = useRef(classId);
  activeClassId.current = classId;
  const requestScope = useRef(0);
  const latestVersion = useRef(-1);
  const isPreparing =
    collection?.state === MaterialState.QUEUED || collection?.state === MaterialState.PREPARING;

  function isMounted(): boolean {
    return mounted.current && activeClassId.current === classId;
  }

  function accept(
    reply: MaterialReply | undefined,
    preserveIntent = false,
    scope = requestScope.current,
  ): MaterialCollection | null {
    if (!isMounted() || scope !== requestScope.current) {
      return null;
    }
    if (reply?.kind !== 'collection') {
      setError(
        reply?.kind === 'failed' && reply.issue === MaterialIssue.PROVIDER_UNAVAILABLE
          ? t(
              'Preparation is unavailable. Ask your operator to configure the model provider.',
              'Chưa thể chuẩn bị tài liệu. Nhờ quản trị viên cấu hình dịch vụ mô hình.',
            )
          : reply?.kind === 'failed' && reply.code === MaterialFailure.STALE
            ? t(
                'The class changed. Refresh your materials; approval is unavailable during a live session.',
                'Lớp đã thay đổi. Cập nhật tài liệu; không thể duyệt khi đang có buổi học.',
              )
            : reply?.kind === 'failed' && reply.code === MaterialFailure.FORBIDDEN
              ? t(
                  'You no longer have access to these materials. Sign in again or ask the class owner.',
                  'Bạn không còn quyền xem tài liệu này. Đăng nhập lại hoặc hỏi chủ lớp.',
                )
              : t(
                  'Could not complete this action. Check file limits, your connection and the current revision.',
                  'Chưa thực hiện được thao tác. Kiểm tra giới hạn tệp, kết nối và phiên bản hiện tại.',
                ),
      );
      return null;
    }
    if (reply.collection.classId !== classId || reply.collection.version < latestVersion.current) {
      return null;
    }
    latestVersion.current = reply.collection.version;
    setCollection(reply.collection);
    if (!preserveIntent) {
      setIntent(reply.collection.teacherInstructions);
      setDirty(false);
    }
    setReviewEdits(false);
    setError(null);
    return reply.collection;
  }

  useEffect(() => {
    mounted.current = true;
    requestScope.current += 1;
    latestVersion.current = -1;
    setCollection(null);
    setIntent('');
    setDirty(false);
    setReviewEdits(false);
    setReviewed(false);
    setRevisionRequest('');
    setConfirmRefresh(false);
    setBusy(false);
    setRequestingPreparation(false);
    setError(null);
    void refreshMaterials();
    return () => {
      mounted.current = false;
    };
  }, [classId]);
  useEffect(() => {
    if (!isPreparing || error) {
      return;
    }
    const timer = setInterval(() => {
      void send({ kind: 'read', classId, materialSchemaVersion: 2 });
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [classId, isPreparing, error]);

  async function send(
    command: Exclude<MaterialCommand, { kind: 'download' }>,
  ): Promise<MaterialCollection | null> {
    const scope = requestScope.current;
    try {
      return accept(
        await window.tro.controlClassMaterials?.({ ...command, materialSchemaVersion: 2 }),
        command.kind === 'upload' || command.kind === 'add-link' || command.kind === 'remove',
        scope,
      );
    } catch {
      return accept(undefined, false, scope);
    }
  }

  async function refreshMaterials(): Promise<void> {
    const scope = requestScope.current;
    setLoading(true);
    try {
      await send({ kind: 'read', classId });
    } finally {
      if (isMounted() && requestScope.current === scope) {
        setLoading(false);
      }
    }
  }

  async function prepareMaterials(request?: string): Promise<void> {
    if (!collection || busy || isPreparing) {
      return;
    }
    const scope = requestScope.current;
    setBusy(true);
    setRequestingPreparation(true);
    try {
      /* Save teacher edits before AI reads the previous suggestions. Approval remains a separate action. */
      const current = hasReviewEdits ? await saveReview() : collection;
      if (!current || !isMounted() || requestScope.current !== scope) {
        return;
      }
      setReviewed(false);
      await send({
        kind: 'prepare',
        classId,
        version: current.version,
        teacherInstructions: intent,
        locale,
        ...(request ? { revisionRequest: request } : {}),
      });
    } finally {
      if (isMounted() && requestScope.current === scope) {
        setRequestingPreparation(false);
        setBusy(false);
      }
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    if (busy || isPreparing || hasReviewEdits || !collection) {
      return;
    }
    setBusy(true);
    let current = collection;
    try {
      for (const file of files) {
        if (!isMounted()) {
          return;
        }
        if (!file.size || file.size > MaterialLimits.FILE_BYTES) {
          setError(t('Each file must be smaller than 8 MB.', 'Mỗi tệp phải nhỏ hơn 8 MB.'));
          break;
        }
        const data = await encodeFile(file);
        if (!isMounted()) {
          return;
        }
        const next = await send({
          kind: 'upload',
          classId,
          version: current.version,
          name: file.name,
          data,
        });
        if (!next) {
          break;
        }
        current = next;
      }
      setReviewed(false);
    } catch {
      setError(t('Could not read this file.', 'Không đọc được tệp này.'));
    } finally {
      if (isMounted()) {
        setBusy(false);
      }
    }
  }

  async function saveReview(): Promise<MaterialCollection | null> {
    if (!collection?.draft) {
      return null;
    }
    return send({
      kind: 'save-review',
      materialSchemaVersion: 2,
      ...('schemaVersion' in collection.draft
        ? {
            documentNotes: collection.draft.documents.map((document) => ({
              materialId: document.materialId,
              text: document.teacherNote,
            })),
          }
        : {}),
      classId,
      version: collection.version,
      teacherInstructions: intent,
      summary: collection.draft.summary,
      sections: collection.draft.sections,
      notes: collection.draft.pages.map((page) => ({ pageId: page.id, text: page.teacherNote })),
      resolvedQuestions: reviewed,
    });
  }

  const showPreparationLoading = isRequestingPreparation || isPreparing;
  const editable = !busy && !isPreparing && !isLoading;
  const draft = collection?.draft;
  const canReview = Boolean(
    draft &&
    (collection.state === MaterialState.REVIEW || collection.state === MaterialState.APPROVED),
  );
  const approved = collection?.state === MaterialState.APPROVED && !dirty;
  const currentStep = approved ? 3 : canReview ? 2 : 1;
  const preparationGuide = (
    <section aria-label={t('Prepare your materials', 'Chuẩn bị tài liệu')}>
      <header className="material-heading">
        <Title order={2}>{t('Prepare your materials', 'Chuẩn bị tài liệu')}</Title>
        <Text c="dimmed" size="sm">
          {t(
            'Add what you already teach with. Review once, then start your class.',
            'Thêm tài liệu bạn đang dùng. Kiểm tra một lần, rồi bắt đầu buổi học.',
          )}
        </Text>
      </header>
      <ol className="material-steps" aria-label={t('Prepare your class', 'Chuẩn bị lớp học')}>
        {[
          t('Add materials', 'Thêm tài liệu'),
          t('Review materials', 'Kiểm tra tài liệu'),
          t('Start class', 'Bắt đầu lớp'),
        ].map((label, index) => (
          <li key={label} aria-current={currentStep === index + 1 ? 'step' : undefined}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
  return (
    <div className="material-workspace">
      {preparationSidebar ? createPortal(preparationGuide, preparationSidebar) : preparationGuide}
      {error && (
        <Alert role="alert" mb="md">
          {error}
          <Button
            variant="subtle"
            disabled={isLoading || busy}
            onClick={() => {
              if (hasReviewEdits) {
                setConfirmRefresh(true);
              } else {
                void refreshMaterials();
              }
            }}
          >
            {t('Refresh materials', 'Cập nhật tài liệu')}
          </Button>
        </Alert>
      )}
      {confirmRefresh && (
        <Alert
          mb="md"
          title={t('Refresh and discard unsaved edits?', 'Cập nhật và bỏ chỉnh sửa chưa lưu?')}
        >
          <Text size="sm">
            {t(
              'Your unsaved review edits will be replaced by the saved version.',
              'Chỉnh sửa chưa lưu sẽ được thay bằng phiên bản đã lưu.',
            )}
          </Text>
          <Group mt="sm">
            <Button
              variant="default"
              disabled={isLoading || busy}
              onClick={() => {
                setConfirmRefresh(false);
              }}
            >
              {t('Keep edits', 'Giữ chỉnh sửa')}
            </Button>
            <Button
              disabled={isLoading || busy}
              onClick={() => {
                setConfirmRefresh(false);
                void refreshMaterials();
              }}
            >
              {t('Discard edits and refresh', 'Bỏ chỉnh sửa và cập nhật')}
            </Button>
          </Group>
        </Alert>
      )}
      <div className="material-grid">
        <Card
          withBorder
          radius="lg"
          padding="lg"
          component="section"
          aria-label={t('Class materials', 'Tài liệu lớp học')}
        >
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600} size="lg">
                {t('Class materials', 'Tài liệu lớp học')}
              </Text>
              {collection && (
                <Badge variant="light">
                  {collection.sources.length} {t('materials', 'tài liệu')}
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              {t(
                'Original files stay available for students to download.',
                'Học sinh có thể tải xuống các tệp gốc.',
              )}
            </Text>
            {isLoading && (
              <Group role="status" aria-label={t('Loading materials', 'Đang tải tài liệu')}>
                <Loader size="xs" />
                <Text>{t('Loading materials…', 'Đang tải tài liệu…')}</Text>
              </Group>
            )}
            {!collection && !isLoading && (
              <Text size="sm" c="dimmed">
                {t(
                  'Materials could not be loaded. Refresh to try again.',
                  'Chưa tải được tài liệu. Cập nhật để thử lại.',
                )}
              </Text>
            )}
            <Stack gap="xs" className="material-prepare-actions">
              <Button
                fullWidth
                loading={showPreparationLoading}
                disabled={!collection?.sources.length || !editable}
                onClick={() => {
                  void prepareMaterials();
                }}
              >
                {showPreparationLoading
                  ? t('Processing…', 'Đang xử lý…')
                  : draft
                    ? t('Process materials again', 'Xử lý lại tài liệu')
                    : t('Process materials', 'Xử lý tài liệu')}
              </Button>
              <Text size="xs" c="dimmed">
                {hasReviewEdits
                  ? t(
                      'Your edits will be saved before processing again.',
                      'Chỉnh sửa sẽ được lưu trước khi xử lý lại.',
                    )
                  : t(
                      'Process all files together, then review the results. Links remain references only.',
                      'Xử lý tất cả tệp cùng lúc, rồi kiểm tra kết quả. Đường dẫn chỉ dùng để tham khảo.',
                    )}
              </Text>
              <Text size="xs" c="dimmed">
                {t(
                  'Processing sends selected content to the configured AI provider.',
                  'Xử lý sẽ gửi nội dung đã chọn đến dịch vụ AI.',
                )}
              </Text>
            </Stack>
            <MaterialFiles
              collection={collection}
              disabled={!editable || !collection || hasReviewEdits}
              t={t}
              onAddFiles={addFiles}
              onAddLink={async (url, name) => {
                if (!collection) {
                  return false;
                }
                setBusy(true);
                try {
                  const next = await send({
                    kind: 'add-link',
                    classId,
                    version: collection.version,
                    name,
                    url,
                  });
                  if (next) {
                    setReviewed(false);
                  }
                  return Boolean(next);
                } finally {
                  setBusy(false);
                }
              }}
              onRemove={(materialId) => {
                if (!collection) {
                  return;
                }
                setBusy(true);
                void send({
                  kind: 'remove',
                  classId,
                  version: collection.version,
                  materialId,
                }).finally(() => {
                  setBusy(false);
                });
              }}
              onDownload={(materialId) => {
                void window.tro.downloadClassMaterial?.(classId, materialId).then((saved) => {
                  if (!saved && isMounted()) {
                    setError(t('The download was not saved.', 'Chưa lưu bản tải xuống.'));
                  }
                });
              }}
            />
            <Textarea
              label={t(
                'Anything Tro should know? (optional)',
                'Tro cần biết thêm gì? (không bắt buộc)',
              )}
              placeholder={t(
                'For example: students are new to Scratch. Today, make the cat move and speak.',
                'Ví dụ: học sinh mới làm quen với Scratch. Hôm nay, cho mèo di chuyển và nói.',
              )}
              autosize
              minRows={3}
              maxLength={4000}
              value={intent}
              disabled={!editable}
              onChange={(event) => {
                setIntent(event.currentTarget.value);
                setDirty(true);
                setReviewed(false);
              }}
            />
            <details className="material-limits">
              <summary>{t('File limits and links', 'Giới hạn tệp và đường dẫn')}</summary>
              <Text size="xs" c="dimmed" mt="xs">
                {t(
                  'Up to 12 materials · 8 MB per file · 24 MB stored per class. Links are references; their contents are not fetched.',
                  'Tối đa 12 tài liệu · 8 MB mỗi tệp · 24 MB lưu trữ mỗi lớp. Đường dẫn dùng để tham khảo; chưa đọc nội dung trang.',
                )}
              </Text>
            </details>
          </Stack>
        </Card>
        <Card
          withBorder
          radius="lg"
          padding="lg"
          component="section"
          aria-label={t('Review your materials', 'Kiểm tra tài liệu của bạn')}
          aria-busy={showPreparationLoading}
        >
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600} size="lg">
                {t('Review your materials', 'Kiểm tra tài liệu của bạn')}
              </Text>
              {draft && (
                <Badge variant="light">
                  {!canReview || showPreparationLoading
                    ? t('Previous review', 'Bản trước')
                    : approved
                      ? t('Reviewed', 'Đã duyệt')
                      : t('Draft', 'Bản nháp')}
                </Badge>
              )}
            </Group>
            {collection?.state === MaterialState.FAILED && !showPreparationLoading && (
              <Alert>
                {t(
                  'Preparation failed. Try again or use a smaller collection. Your original files are saved.',
                  'Chuẩn bị thất bại. Thử lại hoặc dùng ít tài liệu hơn. Tệp gốc vẫn được giữ.',
                )}
              </Alert>
            )}
            {collection?.state === MaterialState.COLLECTING && draft && (
              <Alert>
                {t(
                  'Materials changed. Prepare this collection again before reviewing it.',
                  'Tài liệu đã thay đổi. Chuẩn bị lại trước khi duyệt.',
                )}
              </Alert>
            )}
            {showPreparationLoading && draft && (
              <Group
                role="status"
                aria-live="polite"
                aria-label={t('Preparing materials', 'Đang chuẩn bị tài liệu')}
              >
                <Loader size="sm" />
                <Text size="sm">
                  {t(
                    'Updating suggestions… Your previous review stays below.',
                    'Đang cập nhật gợi ý… Bản trước vẫn hiển thị bên dưới.',
                  )}
                  {collection.preparationProgress
                    ? ` (${String(collection.preparationProgress.completed)}/${String(collection.preparationProgress.total)})`
                    : ''}
                </Text>
              </Group>
            )}
            {collection && draft ? (
              <>
                <MaterialReview
                  collection={collection}
                  editable={editable && canReview}
                  t={t}
                  onChange={(next) => {
                    setCollection(next);
                    setDirty(true);
                    setReviewEdits(true);
                    setReviewed(false);
                  }}
                />
                <Stack gap="sm" className="material-ai-revision">
                  <Textarea
                    label={t('Ask AI to adjust suggestions', 'Nhờ AI chỉnh sửa gợi ý')}
                    placeholder={t(
                      'For example: combine the first two sections and add more practice with input().',
                      'Ví dụ: gộp hai phần đầu và thêm bài thực hành với input().',
                    )}
                    value={revisionRequest}
                    onChange={(event) => {
                      setRevisionRequest(event.currentTarget.value);
                    }}
                    autosize
                    minRows={2}
                    maxLength={4000}
                    disabled={!editable || !collection.sources.length}
                  />
                  <Text size="xs" c="dimmed">
                    {t(
                      'Uses your existing files, notes and suggestions. Review the new draft before using it in class.',
                      'Dùng các tệp, ghi chú và gợi ý hiện có. Kiểm tra bản nháp mới trước khi dùng trong lớp.',
                    )}
                  </Text>
                  <Button
                    variant="default"
                    loading={showPreparationLoading}
                    disabled={!editable || !collection.sources.length || !revisionRequest.trim()}
                    onClick={() => {
                      void prepareMaterials(revisionRequest.trim());
                    }}
                  >
                    {t('Update suggestions with AI', 'Cập nhật gợi ý bằng AI')}
                  </Button>
                </Stack>
                {!approved && canReview && !showPreparationLoading && (
                  <>
                    <Checkbox
                      label={t(
                        'I reviewed the notes, source limitations and questions; my edits reflect what I will teach.',
                        'Tôi đã kiểm tra ghi chú, giới hạn trích xuất và câu hỏi; các chỉnh sửa phù hợp với bài dạy.',
                      )}
                      checked={reviewed}
                      disabled={!editable}
                      onChange={(event) => {
                        setReviewed(event.currentTarget.checked);
                      }}
                    />
                    <Group justify="space-between" className="material-review-actions">
                      <Button
                        variant="default"
                        disabled={!editable || !dirty}
                        onClick={() => {
                          setBusy(true);
                          void saveReview().finally(() => {
                            setBusy(false);
                          });
                        }}
                      >
                        {t('Save changes', 'Lưu thay đổi')}
                      </Button>
                      <Button
                        disabled={
                          !editable ||
                          !reviewed ||
                          live ||
                          (collection.state === MaterialState.APPROVED && !dirty)
                        }
                        onClick={() => {
                          setBusy(true);
                          void saveReview()
                            .then(async (saved) => {
                              if (saved) {
                                const approved = await send({
                                  kind: 'approve',
                                  classId,
                                  version: saved.version,
                                });
                                if (approved?.state === MaterialState.APPROVED) {
                                  await onApproved();
                                }
                              }
                            })
                            .finally(() => {
                              setBusy(false);
                            });
                        }}
                      >
                        {t('Use reviewed materials', 'Dùng tài liệu đã duyệt')}
                      </Button>
                    </Group>
                    {live && (
                      <Text size="sm" c="dimmed">
                        {t(
                          'End the live session before approving new materials.',
                          'Kết thúc buổi học hiện tại trước khi duyệt tài liệu mới.',
                        )}
                      </Text>
                    )}
                  </>
                )}
                {approved && editable && sessionControls}
              </>
            ) : (
              <div
                className="material-review-empty"
                role={showPreparationLoading ? 'status' : undefined}
                aria-label={
                  showPreparationLoading
                    ? t('Preparing materials', 'Đang chuẩn bị tài liệu')
                    : undefined
                }
                aria-live="polite"
              >
                <div>
                  {showPreparationLoading && collection?.preparationProgress && (
                    <Text size="sm" mb="md">
                      {collection.preparationProgress.completed} /{' '}
                      {collection.preparationProgress.total}{' '}
                      {t('preparation stages complete', 'giai đoạn đã hoàn tất')}
                    </Text>
                  )}
                  {showPreparationLoading ? (
                    <Group justify="center" mb="lg" aria-hidden="true">
                      <Loader size="lg" />
                    </Group>
                  ) : (
                    <div className="material-preview-lines" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  <Text fw={600}>
                    {showPreparationLoading
                      ? t('Preparing your materials…', 'Đang chuẩn bị tài liệu…')
                      : error && !collection
                        ? t('Load your materials to continue.', 'Tải tài liệu để tiếp tục.')
                        : t(
                            'Your materials, ready to teach with.',
                            'Tài liệu của bạn, sẵn sàng để giảng dạy.',
                          )}
                  </Text>
                  <Text size="sm" c="dimmed" mt="sm">
                    {showPreparationLoading
                      ? t(
                          'You can leave this page. Your draft will appear here when it is ready.',
                          'Bạn có thể rời trang này. Bản nháp sẽ xuất hiện tại đây khi sẵn sàng.',
                        )
                      : t(
                          'Add your files, then prepare them together. Review the summary, sections and material notes here.',
                          'Thêm tệp, rồi chuẩn bị cùng lúc. Tóm tắt, các phần học và ghi chú tài liệu sẽ xuất hiện ở đây.',
                        )}
                  </Text>
                </div>
              </div>
            )}
          </Stack>
        </Card>
      </div>
    </div>
  );
}

function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('File encoding failed.'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => {
      reject(new Error('File read failed.'));
    };
    reader.readAsDataURL(file);
  });
}
