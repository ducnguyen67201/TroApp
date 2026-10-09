import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import type { PracticeCaptureReply } from '#contracts/PracticeCapture.js';
import type { PracticeEvidence } from '#contracts/PracticeCheck.js';
import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** Local window selection never uploads evidence. The existing check action confirms transfer. */
export function PracticeCaptureControls({
  enabled,
  busy,
  practiceReview,
  onCaptured,
  t,
}: {
  enabled: boolean;
  busy: boolean;
  practiceReview?: PracticeShortcutEvent | undefined;
  onCaptured: (evidence: PracticeEvidence) => void;
  t: ClassroomTranslate;
}): ReactElement | null {
  const [windows, setWindows] = useState<
    Extract<PracticeCaptureReply, { kind: 'windows' }>['windows']
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  async function captureWork(captureId?: string, windowId?: string, choose = false): Promise<void> {
    const control = window.tro.controlPracticeCapture;
    if (!control || !enabled || busy || inFlight.current) {
      return;
    }
    const version = generation.current;
    inFlight.current = true;
    setCapturing(true);
    setError(null);
    try {
      if (choose) {
        await control({ kind: 'discard' });
      }
      const reply = await control(
        choose
          ? { kind: 'list' }
          : captureId
            ? { kind: 'read', captureId }
            : { kind: 'capture', ...(windowId ? { windowId } : {}) },
      );
      if (version !== generation.current) {
        return;
      }
      if (reply.kind === 'windows') {
        if (!reply.windows.length) {
          throw new Error('No windows.');
        }
        setWindows(reply.windows);
        setSelected(null);
        setSelecting(true);
      } else if (reply.kind === 'captured') {
        onCaptured(reply.evidence);
        setSelecting(false);
      } else if (reply.kind === 'failed' && reply.code === 'invalid' && !captureId) {
        const list = await control({ kind: 'list' });
        if (version !== generation.current) {
          return;
        }
        if (list.kind !== 'windows' || !list.windows.length) {
          throw new Error('No windows.');
        }
        setWindows(list.windows);
        setSelected(null);
        setSelecting(true);
      } else {
        throw new Error('Capture unavailable.');
      }
    } catch {
      if (version === generation.current) {
        setError(
          t(
            'Could not capture work. Check Screen Recording permission, select an available window, or upload evidence manually.',
            'Chưa chụp được bài. Kiểm tra quyền Ghi màn hình, chọn cửa sổ khả dụng hoặc tải bằng chứng thủ công.',
          ),
        );
      }
    } finally {
      if (version === generation.current) {
        setCapturing(false);
      }
      inFlight.current = false;
    }
  }

  useEffect(() => {
    if (practiceReview) {
      void captureWork(practiceReview.captureId);
    }
  }, [practiceReview?.requestId]);

  if (!window.tro.controlPracticeCapture) {
    return null;
  }
  return (
    <Stack gap="xs">
      <Group>
        <Button
          disabled={!enabled || busy || capturing}
          loading={capturing}
          onClick={() => {
            void captureWork();
          }}
        >
          {t('Check current window', 'Kiểm tra cửa sổ đang làm')}
        </Button>
        <Button
          variant="subtle"
          disabled={!enabled || busy || capturing}
          onClick={() => {
            void captureWork(undefined, undefined, true);
          }}
        >
          {t('Choose work window', 'Chọn cửa sổ bài làm')}
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        {t(
          'Capture stays local until you review and click Check my work.',
          'Ảnh chỉ ở máy bạn cho đến khi xem lại và bấm Kiểm tra bài.',
        )}
      </Text>
      {error && <Alert role="alert">{error}</Alert>}
      <Modal
        opened={selecting}
        onClose={() => {
          if (!capturing) {
            setSelecting(false);
          }
        }}
        title={t('Choose work window', 'Chọn cửa sổ bài làm')}
      >
        <Stack>
          <Select
            label={t('Work window', 'Cửa sổ bài làm')}
            data={windows.map((item) => ({ value: item.id, label: item.name }))}
            value={selected}
            onChange={setSelected}
            disabled={capturing}
          />
          <Button
            disabled={!selected || capturing}
            loading={capturing}
            onClick={() => {
              if (selected) {
                void captureWork(undefined, selected);
              }
            }}
          >
            {t('Capture and review', 'Chụp và xem lại')}
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
