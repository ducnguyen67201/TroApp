import type { ReactElement } from 'react';
import { Button, Group, Text } from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  PetCorrectionKind,
  PetWalletEntryKind,
  type PetOwnWorld,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import {
  describeRecognitionCategory,
  formatPetWorldDate,
  formatPoints,
  type PetWorldTranslate,
} from './PetWorldLabels.js';

interface PetWorldHistoryProps {
  world: PetOwnWorld;
  history: Extract<PetWorldReply, { kind: 'history' }> | null;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  readOlderHistory: () => Promise<void>;
}

/** Recognition words and wallet accounting remain separate views of the same saved history. */
export function PetWorldHistory({
  world,
  history,
  isSaving,
  locale,
  t,
  readOlderHistory,
}: PetWorldHistoryProps): ReactElement {
  const recognitions = history?.recognitions ?? world.recognitions;
  const entries = history?.entries ?? world.entries;
  return (
    <>
      <section
        className="pet-world-panel"
        aria-label={t('Recognition memories', 'Kỷ niệm được ghi nhận')}
      >
        <h2>{t('Small wins, kept.', 'Giữ lại những niềm vui nhỏ.')}</h2>
        <Text size="sm" c="dimmed" mb="sm">
          {t(
            'Words from your teachers, for moments that mattered.',
            'Lời thầy cô dành cho những khoảnh khắc đáng nhớ.',
          )}
        </Text>
        {recognitions.map((recognition) => (
          <article className="pet-world-memory" key={recognition.id}>
            <Group justify="space-between">
              <Text size="sm" fw={650}>
                {describeRecognitionCategory(recognition.category, t)}
              </Text>
              <Text size="xs">
                {recognition.correction?.kind === PetCorrectionKind.REVERSED
                  ? t('Reversed', 'Đã hoàn tác')
                  : `+${formatPoints(recognition.points, locale)}`}
              </Text>
            </Group>
            {recognition.note && (
              <Text size="sm" mt={5}>
                {recognition.note}
              </Text>
            )}
            <Text size="xs" c="dimmed" mt={5}>
              {formatPetWorldDate(recognition.createdAt, locale)}
            </Text>
            {recognition.correction && (
              <Text size="xs" c="dimmed" mt={5}>
                {t('Your teacher corrected this recognition:', 'Thầy cô đã sửa ghi nhận này:')}{' '}
                {recognition.correction.reason}
              </Text>
            )}
          </article>
        ))}
        {!recognitions.length && (
          <Text className="pet-world-empty">
            {t(
              'Your teacher can recognize curiosity, persistence and helping others. Your home is already yours to enjoy.',
              'Thầy cô có thể ghi nhận sự tò mò, kiên trì và giúp đỡ bạn bè. Bạn đã có mái ấm của riêng mình.',
            )}
          </Text>
        )}
      </section>
      <section
        className="pet-world-panel pet-world-section"
        aria-label={t('Wallet history', 'Lịch sử ví điểm')}
      >
        <h2>{t('Your point history.', 'Lịch sử điểm của bạn.')}</h2>
        {entries.map((entry) => (
          <article className="pet-world-memory" key={entry.id}>
            <Group justify="space-between">
              <Text size="sm">
                {entry.kind === PetWalletEntryKind.TEACHER_GRANT
                  ? t('Teacher recognition', 'Thầy cô ghi nhận')
                  : entry.kind === PetWalletEntryKind.PURCHASE
                    ? t('A new treasure', 'Mua vật phẩm')
                    : t('Award corrected', 'Sửa lần tặng điểm')}
              </Text>
              <Text size="sm" fw={600}>
                {entry.delta.startsWith('-') ? '−' : '+'}
                {formatPoints(entry.delta.replace(/^-/, ''), locale)}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {formatPetWorldDate(entry.createdAt, locale)}
            </Text>
          </article>
        ))}
        {!entries.length && (
          <Text className="pet-world-empty">
            {t(
              'Your wallet starts at zero. Only your teachers can give points.',
              'Ví của bạn bắt đầu từ 0. Chỉ thầy cô mới có thể tặng điểm.',
            )}
          </Text>
        )}
        {(!history || history.nextCursor) && (
          <Button
            variant="subtle"
            size="xs"
            mt="sm"
            disabled={isSaving}
            onClick={() => {
              void readOlderHistory();
            }}
          >
            {history
              ? t('Show older history', 'Xem lịch sử trước')
              : t('Browse history', 'Xem lịch sử')}
          </Button>
        )}
      </section>
    </>
  );
}
