import { PracticeCheckpointEditor } from './PracticeCheckpointEditor.js';
import { DocumentBriefReview } from './DocumentBriefReview.js';
import type { ReactElement } from 'react';
import { Alert, Button, Stack, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import type { MaterialCollection } from '#contracts/ClassroomMaterials.js';
import { formatMaterialLocation, type ClassroomTranslate } from './ClassroomLabels.js';

/** Displays readable notes first; editing preserves the original source and citations. */
export function MaterialReview({
  collection,
  editable,
  onChange,
  t,
}: {
  collection: MaterialCollection;
  editable: boolean;
  onChange: (collection: MaterialCollection) => void;
  t: ClassroomTranslate;
}): ReactElement | null {
  const draft = collection.draft;
  if (!draft) {
    return null;
  }
  return (
    <>
      <Tabs defaultValue="summary" className="material-review-tabs">
        <Tabs.List>
          <Tabs.Tab value="summary">{t('Summary', 'Tóm tắt')}</Tabs.Tab>
          <Tabs.Tab value="sections">{t('Sections', 'Các phần học')}</Tabs.Tab>
          <Tabs.Tab value="notes">{t('Material notes', 'Ghi chú tài liệu')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="summary" pt="sm">
          <Text className="material-prose material-summary">{draft.summary}</Text>
          <details className="material-edit">
            <summary>{t('Edit summary', 'Sửa tóm tắt')}</summary>
            <Textarea
              aria-label={t('Lesson summary', 'Tóm tắt bài học')}
              autosize
              minRows={4}
              maxLength={4000}
              value={draft.summary}
              disabled={!editable}
              onChange={(event) => {
                onChange({
                  ...collection,
                  draft: { ...draft, summary: event.currentTarget.value },
                });
              }}
            />
          </details>
          <Text fw={600} mt="md">
            {t('Sections for today', 'Các phần học hôm nay')}
          </Text>
          {draft.sections.map((section, index) => (
            <Text key={section.id} size="sm" mt="xs">
              {index + 1}. {section.title}
            </Text>
          ))}
          <Text size="xs" c="dimmed" mt="md">
            {'schemaVersion' in draft ? draft.documents.length : draft.pages.length}{' '}
            {'schemaVersion' in draft
              ? t(
                  'document briefs retained. Original files stay available.',
                  'ghi chú tài liệu được giữ lại. Tệp gốc vẫn có thể tải xuống.',
                )
              : t(
                  'source notes retained. Original files stay available.',
                  'ghi chú nguồn được giữ lại. Tệp gốc vẫn có thể tải xuống.',
                )}
          </Text>
        </Tabs.Panel>
        <Tabs.Panel value="sections" pt="sm">
          <Text size="xs" c="dimmed" mb="md">
            {t(
              'A suggested order based on your materials. Edit it to fit how you teach.',
              'Thứ tự gợi ý từ tài liệu. Bạn có thể sửa cho phù hợp với cách dạy.',
            )}
          </Text>
          <Stack gap="xs">
            {draft.sections.map((section, index) => (
              <div key={section.id} className="material-section">
                <Text fw={600}>
                  {index + 1}. {section.title}
                </Text>
                <Text size="sm" className="material-prose">
                  {section.instruction}
                </Text>
                <Text size="xs" c="dimmed">
                  {section.sourcePageIds
                    .map((id) => {
                      const page = draft.pages.find((item) => item.id === id);
                      return page
                        ? `${collection.sources.find((source) => source.id === page.materialId)?.name ?? ''} · ${formatMaterialLocation(page.location, t)}`
                        : '';
                    })
                    .join('; ')}
                </Text>
                <PracticeCheckpointEditor
                  checkpoints={section.practiceCheckpoints ?? []}
                  sourceIds={section.sourcePageIds}
                  disabled={!editable}
                  t={t}
                  onChange={(practiceCheckpoints) => {
                    onChange({
                      ...collection,
                      draft: {
                        ...draft,
                        sections: draft.sections.map((item) =>
                          item.id === section.id ? { ...item, practiceCheckpoints } : item,
                        ),
                      },
                    });
                  }}
                />
                <details className="material-edit">
                  <summary>{t('Edit section', 'Sửa phần học')}</summary>
                  <Stack gap="sm" mt="sm">
                    <TextInput
                      label={t('Section title', 'Tên phần học')}
                      maxLength={200}
                      value={section.title}
                      disabled={!editable}
                      onChange={(event) => {
                        onChange({
                          ...collection,
                          draft: {
                            ...draft,
                            sections: draft.sections.map((item) =>
                              item.id === section.id
                                ? { ...item, title: event.currentTarget.value }
                                : item,
                            ),
                          },
                        });
                      }}
                    />
                    <Textarea
                      label={t('Instructions', 'Hướng dẫn')}
                      autosize
                      minRows={3}
                      maxLength={4000}
                      value={section.instruction}
                      disabled={!editable}
                      onChange={(event) => {
                        onChange({
                          ...collection,
                          draft: {
                            ...draft,
                            sections: draft.sections.map((item) =>
                              item.id === section.id
                                ? {
                                    ...item,
                                    instruction: event.currentTarget.value,
                                    practiceCheckpoints: (item.practiceCheckpoints ?? []).map(
                                      (checkpoint) => ({ ...checkpoint, approved: false }),
                                    ),
                                  }
                                : item,
                            ),
                          },
                        });
                      }}
                    />
                  </Stack>
                </details>
              </div>
            ))}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="notes" pt="sm">
          <Stack>
            {'schemaVersion' in draft ? (
              <DocumentBriefReview
                collection={collection}
                draft={draft}
                editable={editable}
                onChange={onChange}
                t={t}
              />
            ) : (
              draft.pages.map((page) => (
                <div key={page.id} className="material-section">
                  <Stack gap="xs">
                    <Text fw={500}>
                      {collection.sources.find((source) => source.id === page.materialId)?.name} ·{' '}
                      {formatMaterialLocation(page.location, t)}
                    </Text>
                    {page.warnings.length > 0 && (
                      <Text size="xs" c="dimmed">
                        {t(
                          'Check diagrams, text order and unrecognized content against the original.',
                          'Đối chiếu sơ đồ, thứ tự văn bản và nội dung chưa rõ với tệp gốc.',
                        )}
                      </Text>
                    )}
                    <Textarea
                      label={t('Teaching notes', 'Ghi chú giảng dạy')}
                      autosize
                      minRows={3}
                      maxRows={12}
                      maxLength={10000}
                      value={page.teacherNote ?? page.preparedNote}
                      disabled={!editable}
                      onChange={(event) => {
                        onChange({
                          ...collection,
                          draft: {
                            ...draft,
                            pages: draft.pages.map((item) =>
                              item.id === page.id
                                ? { ...item, teacherNote: event.currentTarget.value }
                                : item,
                            ),
                          },
                        });
                      }}
                    />
                    <details>
                      <summary>
                        {t('Original extracted content', 'Nội dung trích xuất gốc')}
                      </summary>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {page.extractedText ||
                          t(
                            'No text extracted; review the original and prepared note.',
                            'Chưa trích xuất được văn bản; xem tệp gốc và ghi chú đã chuẩn bị.',
                          )}
                      </Text>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {page.preparedNote}
                      </Text>
                    </details>
                    {page.teacherNote !== null && (
                      <Button
                        size="xs"
                        variant="subtle"
                        disabled={!editable}
                        onClick={() => {
                          onChange({
                            ...collection,
                            draft: {
                              ...draft,
                              pages: draft.pages.map((item) =>
                                item.id === page.id ? { ...item, teacherNote: null } : item,
                              ),
                            },
                          });
                        }}
                      >
                        {t('Restore prepared note', 'Khôi phục ghi chú đã chuẩn bị')}
                      </Button>
                    )}
                  </Stack>
                </div>
              ))
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
      {draft.questions.length > 0 && (
        <Alert title={t('Things to clarify', 'Thông tin cần làm rõ')}>
          <Stack gap="xs">
            {draft.questions.map((question, index) => (
              <Text key={index} size="sm">
                {question}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </>
  );
}
