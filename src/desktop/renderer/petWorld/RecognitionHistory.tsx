import { useState, type ReactElement } from 'react';
import { Button, Modal, Stack, Text, Textarea } from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  PetCorrectionKind,
  PetWorldCommandKind,
  PetWorldLimits,
  type PetRecognition,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import {
  describeRecognitionCategory,
  formatPetWorldDate,
  formatPoints,
  type PetWorldTranslate,
} from './PetWorldLabels.js';

type RecognitionView = Extract<PetWorldReply, { kind: 'class-recognition' }>;

interface RecognitionHistoryProps {
  userId: string;
  canManageAll?: boolean;
  recognition: RecognitionView;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
  readOlderRecognitions: () => Promise<void>;
}

/** Corrections explicitly distinguish a financial reversal from voiding recognition alone. */
export function RecognitionHistory({
  userId,
  canManageAll = false,
  recognition,
  isSaving,
  locale,
  t,
  sendCommand,
  readOlderRecognitions,
}: RecognitionHistoryProps): ReactElement {
  const [correction, setCorrection] = useState<{
    recognition: PetRecognition;
    kind: typeof PetWorldCommandKind.REVERSE_GRANT | typeof PetWorldCommandKind.VOID_RECOGNITION;
  } | null>(null);
  const [reason, setReason] = useState('');

  return (
    <>
      <section
        className="pet-world-panel"
        aria-label={t('Class recognition history', 'Lịch sử ghi nhận của lớp')}
      >
        <h2>{t('Moments you recognized.', 'Những khoảnh khắc đã ghi nhận.')}</h2>
        <div className="pet-world-scroll">
          <table className="pet-world-table">
            <thead>
              <tr>
                <th>{t('Student / moment', 'Học sinh / khoảnh khắc')}</th>
                <th>{t('Points', 'Điểm')}</th>
                <th>{t('Date', 'Thời gian')}</th>
                <th>{t('Correction', 'Sửa ghi nhận')}</th>
              </tr>
            </thead>
            <tbody>
              {recognition.recognitions.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Text size="sm" fw={600}>
                      {recognition.roster.find((student) => student.studentId === entry.studentId)
                        ?.displayName ?? t('Former student', 'Học sinh trước đây')}
                    </Text>
                    <Text size="sm">{describeRecognitionCategory(entry.category, t)}</Text>
                    {entry.note && (
                      <Text size="xs" c="dimmed">
                        {entry.note}
                      </Text>
                    )}
                  </td>
                  <td>{formatPoints(entry.points, locale)}</td>
                  <td>{formatPetWorldDate(entry.createdAt, locale)}</td>
                  <td>
                    {entry.correction ? (
                      <Text size="xs">
                        {entry.correction.kind === PetCorrectionKind.REVERSED
                          ? t('Points reversed', 'Đã hoàn tác điểm')
                          : t(
                              'Recognition voided · points kept',
                              'Đã hủy ghi nhận · giữ nguyên điểm',
                            )}
                        <br />
                        {entry.correction.reason}
                      </Text>
                    ) : entry.teacherId === userId || canManageAll ? (
                      <Stack gap={4}>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          disabled={isSaving}
                          onClick={() => {
                            setReason('');
                            setCorrection({
                              recognition: entry,
                              kind: PetWorldCommandKind.REVERSE_GRANT,
                            });
                          }}
                        >
                          {t('Reverse points', 'Hoàn tác điểm')}
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          disabled={isSaving}
                          onClick={() => {
                            setReason('');
                            setCorrection({
                              recognition: entry,
                              kind: PetWorldCommandKind.VOID_RECOGNITION,
                            });
                          }}
                        >
                          {t('Void recognition only', 'Chỉ hủy ghi nhận')}
                        </Button>
                      </Stack>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!recognition.recognitions.length && (
          <Text className="pet-world-empty">
            {t(
              'No recognition recorded in this period yet.',
              'Chưa có ghi nhận trong thời gian này.',
            )}
          </Text>
        )}
        {recognition.nextCursor && (
          <Button
            variant="subtle"
            mt="sm"
            disabled={isSaving}
            onClick={() => {
              void readOlderRecognitions();
            }}
          >
            {t('Show older moments', 'Xem khoảnh khắc trước')}
          </Button>
        )}
      </section>

      <Modal
        opened={correction !== null}
        onClose={() => {
          setCorrection(null);
        }}
        title={
          correction?.kind === PetWorldCommandKind.REVERSE_GRANT
            ? t('Reverse this point award', 'Hoàn tác lần tặng điểm này')
            : t('Void this recognition', 'Hủy sự ghi nhận này')
        }
      >
        <Stack>
          <Text size="sm">
            {correction?.kind === PetWorldCommandKind.REVERSE_GRANT
              ? t(
                  'This removes the exact original points if the student still has enough. Purchased items stay with the student. If points have been spent, you can void the recognition instead.',
                  'Thao tác sẽ trừ đúng số điểm ban đầu nếu học sinh còn đủ điểm. Vật phẩm đã mua vẫn thuộc học sinh. Nếu điểm đã được tiêu, bạn có thể chỉ hủy ghi nhận.',
                )
              : t(
                  'This corrects the recognition record and class coverage. The student keeps their points and items. It cannot later be reversed.',
                  'Thao tác sửa dữ liệu ghi nhận và thống kê lớp. Học sinh giữ điểm và vật phẩm. Sau đó không thể hoàn tác điểm.',
                )}
          </Text>
          <Textarea
            label={t('Reason for the correction', 'Lý do sửa')}
            value={reason}
            maxLength={PetWorldLimits.NOTE_LENGTH}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
            disabled={isSaving}
          />
          <Button
            disabled={isSaving || !reason.trim()}
            onClick={() => {
              if (correction) {
                void sendCommand({
                  kind: correction.kind,
                  requestId: crypto.randomUUID(),
                  recognitionId: correction.recognition.id,
                  reason: reason.trim(),
                }).then((saved) => {
                  if (saved) {
                    setCorrection(null);
                  }
                });
              }
            }}
          >
            {t('Save correction', 'Lưu chỉnh sửa')}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
