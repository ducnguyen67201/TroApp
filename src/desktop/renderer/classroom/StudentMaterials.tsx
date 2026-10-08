import { useState, type ReactElement } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconDownload, IconFileDescription, IconLink } from '@tabler/icons-react';
import type { TeachingContext } from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import { MaterialPreviewButton } from './MaterialPreviewButton.js';

interface StudentMaterialsProps {
  context: TeachingContext;
  t: ClassroomTranslate;
}

/** Presents the same authorized original-download bridge as the activity panel. */
export function StudentMaterials({ context, t }: StudentMaterialsProps): ReactElement {
  const [downloadError, setDownloadError] = useState(false);
  const sources = context.materialContext?.sources ?? [];
  return (
    <Stack gap="lg">
      <div>
        <Text fw={600} size="lg">
          {t('For this session', 'Tài liệu cho buổi này')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('Materials shared by your teacher.', 'Tài liệu giáo viên chia sẻ với bạn.')}
        </Text>
      </div>
      {downloadError && (
        <Alert role="alert">
          {t(
            'The download was not saved. Try again or check your class connection.',
            'Chưa lưu bản tải xuống. Thử lại hoặc kiểm tra kết nối lớp.',
          )}
        </Alert>
      )}
      {sources.length === 0 && context.activity.materials.length === 0 && (
        <Text c="dimmed" size="sm">
          {t('There are no materials for this activity yet.', 'Hoạt động này chưa có tài liệu.')}
        </Text>
      )}
      <div className="classroom-material-list">
        {sources.map((source) => (
          <div key={source.id} className="classroom-material-row">
            <IconFileDescription size={24} stroke={1.4} aria-hidden="true" />
            <div>
              <Text size="sm" fw={500}>
                {source.name}
              </Text>
              {source.url && (
                <Text size="xs" className="material-link" c="dimmed">
                  {source.url}
                </Text>
              )}
            </div>
            {!source.url && (
              <MaterialPreviewButton classId={context.meeting.classId} source={source} t={t} />
            )}
            {!source.url && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconDownload size={15} />}
                onClick={() => {
                  setDownloadError(false);
                  void window.tro
                    .downloadClassMaterial?.(context.meeting.classId, source.id)
                    .then((saved) => {
                      setDownloadError(!saved);
                    });
                }}
              >
                {t('Download material', 'Tải tài liệu')}
              </Button>
            )}
          </div>
        ))}
        {context.activity.materials.map((material) => (
          <Group key={material.id} className="classroom-material-row" wrap="nowrap">
            <IconLink size={22} aria-hidden="true" />
            <div>
              <Text size="sm" fw={500}>
                {material.title}
              </Text>
              <Text size="xs" c="dimmed" className="material-link">
                {material.url}
              </Text>
            </div>
          </Group>
        ))}
      </div>
    </Stack>
  );
}
