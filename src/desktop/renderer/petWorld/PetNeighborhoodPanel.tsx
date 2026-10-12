import type { ReactElement } from 'react';
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Switch, Text } from '@mantine/core';
import { IconPlant2 } from '@tabler/icons-react';
import {
  PetWorldCommandKind,
  type PetCatalog,
  type PetOwnWorld,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import { PetHomeScene } from './PetHomeScene.js';
import { usePetHomeVisit } from './UsePetHomeVisit.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

interface PetNeighborhoodPanelProps {
  userId: string;
  className: string;
  neighborhood: Extract<PetWorldReply, { kind: 'neighborhood' }>;
  world: PetOwnWorld | null;
  catalog: PetCatalog | null;
  isSaving: boolean;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
}

/** Sharing belongs to the student and this class; visitors never receive wallet data. */
export function PetNeighborhoodPanel({
  userId,
  className,
  neighborhood,
  world,
  catalog,
  isSaving,
  t,
  sendCommand,
}: PetNeighborhoodPanelProps): ReactElement {
  const visit = usePetHomeVisit(userId, neighborhood.classId);
  const share = world?.shares.find((entry) => entry.classId === neighborhood.classId);
  return (
    <Stack gap="lg">
      <section className="pet-world-panel" aria-label={t('Class garden', 'Khu vườn của lớp')}>
        <Group justify="space-between">
          <div>
            <Text className="pet-world-eyebrow">{className}</Text>
            <h2>{t('A little garden, grown together.', 'Cùng nhau vun trồng khu vườn nhỏ.')}</h2>
          </div>
          <Badge size="lg" variant="light">
            {t(
              `Garden stage ${neighborhood.garden.gardenMilestone.toString()}`,
              `Khu vườn cấp ${neighborhood.garden.gardenMilestone.toString()}`,
            )}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {t(
            `${neighborhood.garden.classroomMoments.toString()} classroom moments have helped this garden grow. Each group award is one shared moment.`,
            `${neighborhood.garden.classroomMoments.toString()} khoảnh khắc của lớp đã giúp khu vườn lớn lên. Mỗi lần tặng điểm nhóm là một khoảnh khắc chung.`,
          )}
        </Text>
        <div className="pet-world-garden-plants" aria-hidden="true">
          {Array.from(
            { length: Math.min(neighborhood.garden.gardenMilestone + 1, 12) },
            (_, index) => (
              <IconPlant2 key={index} size={32 + (index % 3) * 14} stroke={1.2} />
            ),
          )}
        </div>
        <Text size="xs" c="dimmed">
          {t(
            'Since this class began · teacher-recorded recognition moments',
            'Từ khi lớp bắt đầu · khoảnh khắc được thầy cô ghi nhận',
          )}
        </Text>
        <Text size="xs" c="dimmed" mt="sm">
          {t(
            'Garden growth is shared scenery. It does not award points or compare students.',
            'Sự phát triển của vườn là khung cảnh chung. Không tặng thêm điểm hay so sánh học sinh.',
          )}
        </Text>
      </section>
      {world?.profile && (
        <section className="pet-world-panel" aria-label={t('Home sharing', 'Chia sẻ ngôi nhà')}>
          <Group justify="space-between" align="start">
            <div>
              <h2>{t('Invite your classmates in.', 'Mời các bạn ghé thăm.')}</h2>
              <Text size="sm" c="dimmed">
                {t(
                  'Only this class can visit your pet and decorations. Your points and teacher notes stay private.',
                  'Chỉ lớp này được xem thú cưng và đồ trang trí. Điểm và lời thầy cô nhận xét luôn riêng tư.',
                )}
              </Text>
            </div>
            <Switch
              label={t('Share my home with this class', 'Chia sẻ nhà với lớp này')}
              checked={share?.enabled ?? false}
              disabled={isSaving}
              onChange={(event) => {
                void sendCommand({
                  kind: PetWorldCommandKind.SET_HOME_SHARING,
                  requestId: crypto.randomUUID(),
                  classId: neighborhood.classId,
                  enabled: event.currentTarget.checked,
                  expectedShareRevision: share?.revision ?? 0,
                });
              }}
            />
          </Group>
        </section>
      )}
      <section className="pet-world-panel" aria-label={t('Class neighborhood', 'Khu phố của lớp')}>
        <h2>{t('Around the neighborhood.', 'Ghé thăm hàng xóm.')}</h2>
        <Text size="sm" c="dimmed" mb="lg">
          {t(
            'Homes appear when their owners choose to share with this class.',
            'Ngôi nhà xuất hiện khi chủ nhà chọn chia sẻ với lớp.',
          )}
        </Text>
        <div className="pet-world-neighbors">
          {neighborhood.homes.map((home) => (
            <article className="pet-world-neighbor" key={home.studentId}>
              <Text fw={600}>{home.displayName}</Text>
              <Text size="sm" c="dimmed" mt={4}>
                {home.profile.names[home.profile.activePetId]}
              </Text>
              <Button
                variant="default"
                size="xs"
                mt="md"
                onClick={() => {
                  void visit.visitHome(home.studentId);
                }}
              >
                {t('Visit home', 'Ghé thăm nhà')}
              </Button>
            </article>
          ))}
        </div>
        {!neighborhood.homes.length && (
          <Text className="pet-world-empty">
            {t(
              'A quiet neighborhood for now. Sharing a home is always a choice.',
              'Khu phố hiện còn yên tĩnh. Chia sẻ ngôi nhà luôn là lựa chọn của bạn.',
            )}
          </Text>
        )}
      </section>
      <Modal
        size="lg"
        opened={visit.isOpen}
        onClose={visit.closeHome}
        title={visit.home?.displayName ?? t('Visiting a home', 'Ghé thăm nhà')}
      >
        {visit.isLoading && (
          <Group justify="center" py="xl">
            <Loader size="sm" />
            <Text size="sm">{t('Opening the door…', 'Đang mở cửa…')}</Text>
          </Group>
        )}
        {visit.isUnavailable && (
          <Alert role="status">
            {t(
              'This home is not available to visit right now. The owner may have changed their sharing choice.',
              'Hiện chưa thể ghé thăm nhà này. Chủ nhà có thể đã thay đổi lựa chọn chia sẻ.',
            )}
          </Alert>
        )}
        {visit.home && (
          <section className="pet-home-card">
            <PetHomeScene
              profile={visit.home.profile}
              catalog={catalog}
              ownerName={visit.home.displayName}
              t={t}
            />
          </section>
        )}
      </Modal>
    </Stack>
  );
}
