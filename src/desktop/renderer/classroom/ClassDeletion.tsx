import { useState, type ReactElement } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** Confirms deletion of the selected class without changing membership or ending a live session. */
export function ClassDeletion({
  name,
  live,
  busy,
  t,
  onDelete,
}: {
  name: string;
  live: boolean;
  busy: boolean;
  t: ClassroomTranslate;
  onDelete: () => Promise<void>;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-label={t('Delete class', 'Xóa lớp học')}>
      {confirming ? (
        <Alert color="red" role="alert" title={t('Delete this class?', 'Xóa lớp học này?')}>
          <Text size="sm" fw={600}>
            {name}
          </Text>
          <Text size="sm" mt="xs">
            {t(
              'This class will disappear from teacher and student lists. Invitation codes will stop working. Submitted work and history are retained.',
              'Lớp sẽ được gỡ khỏi danh sách của giáo viên và học sinh. Mã mời sẽ ngừng hoạt động. Bài đã nộp và lịch sử vẫn được giữ.',
            )}
          </Text>
          <Group mt="sm" gap="xs">
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('Cancel', 'Hủy')}
            </Button>
            <Button color="red" size="sm" disabled={busy || live} onClick={() => void onDelete()}>
              {t('Confirm delete class', 'Xác nhận xóa lớp')}
            </Button>
          </Group>
        </Alert>
      ) : (
        <Button
          variant="subtle"
          color="red"
          fullWidth
          leftSection={<IconTrash size={16} />}
          disabled={busy || live}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t('Delete class', 'Xóa lớp học')}
        </Button>
      )}
      {live && (
        <Text size="xs" c="dimmed" mt="xs">
          {t(
            'End the live session before deleting this class.',
            'Kết thúc buổi học trước khi xóa lớp này.',
          )}
        </Text>
      )}
    </section>
  );
}
