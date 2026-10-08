import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconEye, IconDownload } from '@tabler/icons-react';
import type { MaterialSource } from '#contracts/ClassroomMaterials.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import {
  decodeMaterialPreview,
  MaterialPreviewKind,
  readMaterialPreviewKind,
  readMaterialTextPreview,
} from './MaterialPreviewContent.js';
import { PdfMaterialPreview } from './PdfMaterialPreview.js';

/** Closing or changing class unmounts the viewer and drops its private bytes. */
export function MaterialPreviewButton({
  classId,
  source,
  t,
}: {
  classId: string;
  source: MaterialSource;
  t: ClassroomTranslate;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconEye size={14} aria-hidden="true" />}
        aria-label={`${t('Preview', 'Xem trước')} ${source.name}`}
        onClick={() => {
          setOpened(true);
        }}
      >
        {t('Preview', 'Xem trước')}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
        }}
        title={source.name}
        size="xl"
        centered
        closeButtonProps={{ 'aria-label': t('Close preview', 'Đóng bản xem trước') }}
      >
        {opened && (
          <MaterialPreview
            key={`${classId}:${source.id}`}
            classId={classId}
            source={source}
            t={t}
          />
        )}
      </Modal>
    </>
  );
}

function MaterialPreview({
  classId,
  source,
  t,
}: {
  classId: string;
  source: MaterialSource;
  t: ClassroomTranslate;
}): ReactElement {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const kind = readMaterialPreviewKind(source.name);
  useEffect(() => {
    let current = true;
    if (kind === MaterialPreviewKind.DOWNLOAD) {
      return;
    }
    const loadOriginal = async (): Promise<void> => {
      try {
        const reply = await window.tro.previewClassMaterial?.(classId, source.id);
        if (!current) {
          return;
        }
        if (reply?.kind !== 'download' || reply.name !== source.name) {
          setFailed(true);
          return;
        }
        const original = decodeMaterialPreview(reply.data);
        if (kind === MaterialPreviewKind.TEXT) {
          setText(readMaterialTextPreview(original));
        } else {
          setBytes(original);
        }
      } catch {
        if (current) {
          setFailed(true);
        }
      }
    };
    void loadOriginal();
    return () => {
      current = false;
    };
  }, [classId, source.id, source.name, kind]);

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {t('Original file · Read only', 'Tệp gốc · Chỉ xem')}
        </Text>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={15} aria-hidden="true" />}
          onClick={() => {
            setDownloadFailed(false);
            void window.tro
              .downloadClassMaterial?.(classId, source.id)
              .then((saved) => {
                setDownloadFailed(!saved);
              })
              .catch(() => {
                setDownloadFailed(true);
              });
          }}
        >
          {t('Download original', 'Tải tệp gốc')}
        </Button>
      </Group>
      {downloadFailed && (
        <Alert role="alert">{t('The download was not saved.', 'Chưa lưu bản tải xuống.')}</Alert>
      )}
      {failed ? (
        <Alert role="alert">
          {t(
            'Could not preview this file. Close and try again, or download the original.',
            'Không thể xem trước tệp này. Đóng rồi thử lại hoặc tải tệp gốc.',
          )}
        </Alert>
      ) : kind === MaterialPreviewKind.DOWNLOAD ? (
        <Text>
          {t(
            'For PowerPoint and Scratch projects, download the original and open it in its app.',
            'Với PowerPoint và dự án Scratch, hãy tải tệp gốc rồi mở bằng ứng dụng tương ứng.',
          )}
        </Text>
      ) : text ? (
        <>
          {text.truncated && (
            <Text size="sm" c="dimmed">
              {t(
                'This preview is shortened. Download the original to read the full file.',
                'Bản xem trước đã được rút gọn. Tải tệp gốc để đọc đầy đủ.',
              )}
            </Text>
          )}
          <pre className="material-text-preview">{text.text}</pre>
        </>
      ) : bytes ? (
        <PdfMaterialPreview bytes={bytes} name={source.name} t={t} />
      ) : (
        <Group role="status">
          <Loader size="sm" />
          <Text>{t('Loading preview…', 'Đang tải bản xem trước…')}</Text>
        </Group>
      )}
    </Stack>
  );
}
