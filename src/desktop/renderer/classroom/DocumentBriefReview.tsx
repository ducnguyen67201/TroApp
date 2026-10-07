import { Button, Stack, Text, Textarea } from '@mantine/core';
import type { ReactElement } from 'react';
import type { MaterialCollection, MaterialDraftV2 } from '#contracts/ClassroomMaterials.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** A short brief per document; original source and generated interpretation remain inspectable. */
export function DocumentBriefReview({
  collection,
  draft,
  editable,
  onChange,
  t,
}: {
  collection: MaterialCollection;
  draft: MaterialDraftV2;
  editable: boolean;
  onChange: (collection: MaterialCollection) => void;
  t: ClassroomTranslate;
}): ReactElement {
  return (
    <Stack>
      {draft.documents.map((document) => {
        const name =
          collection.sources.find((source) => source.id === document.materialId)?.name ?? '';
        const editNote = (text: string | null): void => {
          onChange({
            ...collection,
            draft: {
              ...draft,
              documents: draft.documents.map((item) =>
                item.materialId === document.materialId ? { ...item, teacherNote: text } : item,
              ),
            },
          });
        };
        return (
          <div className="material-section" key={document.materialId}>
            <Text fw={600}>{name}</Text>
            <Text size="sm" className="material-prose">
              {document.teacherNote ?? document.purpose.text}
            </Text>
            <Text size="xs" c="dimmed">
              {document.topics.join(' · ')}
            </Text>
            <details className="material-edit">
              <summary>{t('Edit document brief', 'Sửa ghi chú tài liệu')}</summary>
              <Textarea
                aria-label={`${t('Document brief', 'Ghi chú tài liệu')}: ${name}`}
                value={document.teacherNote ?? document.purpose.text}
                maxLength={4000}
                autosize
                minRows={3}
                disabled={!editable}
                onChange={(event) => {
                  editNote(event.currentTarget.value);
                }}
              />
              {document.teacherNote !== null && (
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!editable}
                  onClick={() => {
                    editNote(null);
                  }}
                >
                  {t('Restore prepared brief', 'Khôi phục ghi chú đã chuẩn bị')}
                </Button>
              )}
            </details>
            <details>
              <summary>{t('Setup, practice and examples', 'Chuẩn bị, thực hành và ví dụ')}</summary>
              {[...document.setup, ...document.practice, ...document.examples].map(
                (note, index) => (
                  <div key={index}>
                    <Text size="sm" className="material-prose">
                      {note.text}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {note.origin === 'suggestion'
                        ? t('Suggestion', 'Gợi ý')
                        : note.sourceIds
                            .map(
                              (id) =>
                                draft.passages.find((passage) => passage.id === id)?.location ?? '',
                            )
                            .join('; ')}
                    </Text>
                  </div>
                ),
              )}
              {document.uncertainties.map((warning, index) => (
                <Text size="sm" key={index}>
                  {warning}
                </Text>
              ))}
            </details>
            <details>
              <summary>
                {t('Original source and page corrections', 'Nguồn gốc và chỉnh sửa trang')}
              </summary>
              {draft.pages
                .filter((page) => page.materialId === document.materialId)
                .map((page) => (
                  <details key={page.id}>
                    <summary>{page.location}</summary>
                    <Text size="sm" className="material-prose">
                      {page.extractedText ||
                        t(
                          'Review the original for visual content.',
                          'Xem tệp gốc để kiểm tra hình ảnh.',
                        )}
                    </Text>
                    {page.warnings.map((warning, index) => (
                      <Text size="xs" c="dimmed" key={index}>
                        {warning}
                      </Text>
                    ))}
                    <Textarea
                      label={t('Your source note', 'Ghi chú của bạn')}
                      maxLength={10000}
                      autosize
                      minRows={2}
                      value={page.teacherNote ?? ''}
                      disabled={!editable}
                      onChange={(event) => {
                        onChange({
                          ...collection,
                          draft: {
                            ...draft,
                            pages: draft.pages.map((item) =>
                              item.id === page.id
                                ? { ...item, teacherNote: event.currentTarget.value || null }
                                : item,
                            ),
                          },
                        });
                      }}
                    />
                  </details>
                ))}
            </details>
          </div>
        );
      })}
    </Stack>
  );
}
