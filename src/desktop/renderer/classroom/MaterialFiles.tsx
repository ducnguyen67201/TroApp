import { useRef, useState, type ReactElement } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { IconUpload, IconTrash } from '@tabler/icons-react';
import {
  MaterialCommandSchema,
  MaterialState,
  type MaterialCollection,
} from '#contracts/ClassroomMaterials.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** File selection and dropping share one upload path; links remain references only. */
export function MaterialFiles({
  collection,
  disabled,
  t,
  onAddFiles,
  onAddLink,
  onRemove,
  onDownload,
}: {
  collection: MaterialCollection | null;
  disabled: boolean;
  t: ClassroomTranslate;
  onAddFiles: (files: File[]) => Promise<void>;
  onAddLink: (url: string, name: string) => Promise<boolean>;
  onRemove: (materialId: string) => void;
  onDownload: (materialId: string) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState('');
  const [removalId, setRemovalId] = useState<string | null>(null);
  const removal = collection?.sources.find((source) => source.id === removalId);
  const trimmedLink = link.trim();
  const linkCommand = MaterialCommandSchema.safeParse({
    kind: 'add-link',
    classId: collection?.classId,
    version: collection?.version,
    name: readLinkName(trimmedLink),
    url: trimmedLink,
  });
  return (
    <>
      {collection && collection.sources.length > 0 && (
        <div>
          {collection.sources.map((source) => {
            const status = readProcessingStatus(collection, source.id, t);
            return (
              <div key={source.id} className="material-file">
                <span className="material-file-icon">
                  {source.url
                    ? 'URL'
                    : (source.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}
                </span>
                <div className="material-file-info">
                  <Text size="sm" fw={500}>
                    {source.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {source.url
                      ? t('Reference link', 'Đường dẫn tham khảo')
                      : `${String(Math.max(1, Math.round(source.bytes / 1000)))} KB`}
                  </Text>
                  <div className="material-file-actions">
                    <Badge
                      size="sm"
                      variant="light"
                      color={status.color}
                      className="material-processing-tag"
                      leftSection={
                        !source.url &&
                        (collection.state === MaterialState.QUEUED ||
                          collection.state === MaterialState.PREPARING) ? (
                          <Loader size={10} />
                        ) : undefined
                      }
                    >
                      {status.label}
                    </Badge>
                    {!source.url && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => {
                          onDownload(source.id);
                        }}
                      >
                        {t('Download', 'Tải xuống')}
                      </Button>
                    )}
                  </div>
                  {source.url && (
                    <Text size="xs" c="dimmed">
                      {t('Link contents are not read.', 'Chưa đọc nội dung đường dẫn.')}
                    </Text>
                  )}
                </div>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  disabled={disabled}
                  color="red"
                  leftSection={<IconTrash size={15} aria-hidden="true" />}
                  aria-label={`${t('Delete', 'Xóa')} ${source.name}`}
                  onClick={() => {
                    setRemovalId(source.id);
                  }}
                >
                  {t('Delete', 'Xóa')}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className="material-drop"
        data-dragging={dragging && !disabled}
        aria-disabled={disabled}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) {
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(
              event.relatedTarget instanceof Node ? event.relatedTarget : null,
            )
          ) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) {
            void onAddFiles(Array.from(event.dataTransfer.files));
          }
        }}
      >
        <IconUpload size={24} aria-hidden="true" />
        <Text size="sm" mt="sm">
          {t('Drop your files here', 'Thả tệp vào đây')}
        </Text>
        <Text size="xs" c="dimmed" mt="xs">
          {t('PDF, slides, Python or Scratch projects', 'PDF, slide, Python hoặc dự án Scratch')}
        </Text>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          accept=".pdf,.pptx,.sb3,.py,.md,.txt"
          disabled={disabled}
          aria-label={t('Add files', 'Thêm tệp')}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (!disabled) {
              void onAddFiles(files);
            }
          }}
        />
        <Button
          variant="default"
          size="sm"
          mt="md"
          disabled={disabled}
          onClick={() => {
            input.current?.click();
          }}
        >
          {t('Choose files', 'Chọn tệp')}
        </Button>
      </div>
      {removal && (
        <Alert color="red" role="alert" title={t('Remove this material?', 'Gỡ tài liệu này?')}>
          <Text size="sm" fw={600}>
            {removal.name}
          </Text>
          <Text size="sm" mt="xs">
            {t(
              'Remove it from the next preparation. Prepare and approve again to update student materials. Previously approved sources and class history are kept; unused files are deleted.',
              'Gỡ khỏi lần chuẩn bị tiếp theo. Chuẩn bị và duyệt lại để cập nhật tài liệu cho học sinh. Nguồn đã duyệt và lịch sử lớp vẫn được giữ; tệp chưa sử dụng sẽ bị xóa.',
            )}
          </Text>
          <Group mt="sm" gap="xs">
            <Button
              size="sm"
              variant="default"
              disabled={disabled}
              onClick={() => {
                setRemovalId(null);
              }}
            >
              {t('Cancel', 'Hủy')}
            </Button>
            <Button
              size="sm"
              color="red"
              disabled={disabled}
              onClick={() => {
                onRemove(removal.id);
                setRemovalId(null);
              }}
            >
              {t('Confirm remove material', 'Xác nhận gỡ tài liệu')}
            </Button>
          </Group>
        </Alert>
      )}
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {t('Or add a material link', 'Hoặc thêm đường dẫn tài liệu')}
        </Text>
        <Group gap="xs" wrap="nowrap" align="end">
          <TextInput
            className="material-link"
            aria-label={t('Material link (HTTPS)', 'Đường dẫn tài liệu (HTTPS)')}
            placeholder="https://…"
            value={link}
            maxLength={2000}
            disabled={disabled}
            onChange={(event) => {
              setLink(event.currentTarget.value);
            }}
          />
          <Button
            variant="default"
            disabled={disabled || !linkCommand.success}
            onClick={() => {
              if (linkCommand.success && linkCommand.data.kind === 'add-link') {
                void onAddLink(linkCommand.data.url, linkCommand.data.name).then((added) => {
                  if (added) {
                    setLink('');
                  }
                });
              }
            }}
          >
            {t('Add', 'Thêm')}
          </Button>
        </Group>
      </Stack>
    </>
  );
}

function readLinkName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Saved draft bindings identify completed files even after more materials are uploaded. */
function readProcessingStatus(
  collection: MaterialCollection,
  materialId: string,
  t: ClassroomTranslate,
): { label: string; color: string } {
  if (collection.sources.find((source) => source.id === materialId)?.url) {
    return { label: t('Reference only', 'Chỉ tham khảo'), color: 'gray' };
  }
  const wasProcessed = collection.draft?.pages.some((page) => page.materialId === materialId);
  if (collection.state === MaterialState.QUEUED) {
    return { label: t('Queued', 'Chờ xử lý'), color: 'blue' };
  }
  if (collection.state === MaterialState.PREPARING) {
    return {
      label: wasProcessed ? t('Processing again', 'Đang xử lý lại') : t('Processing', 'Đang xử lý'),
      color: 'blue',
    };
  }
  return wasProcessed
    ? { label: t('Processed', 'Đã xử lý'), color: 'teal' }
    : { label: t('Not processed', 'Chưa xử lý'), color: 'orange' };
}
