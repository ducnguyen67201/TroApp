import type { ReactElement } from 'react';
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconPlant2 } from '@tabler/icons-react';
import type { PetCatalog, PetWorldReply } from '#contracts/PetWorld.js';
import { PetMascot } from '../pets/PetMascot.js';
import { PetHomeScene } from './PetHomeScene.js';
import { usePetHomeVisit } from './UsePetHomeVisit.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

interface PetNeighborhoodPanelProps {
  userId: string;
  className: string;
  neighborhood: Extract<PetWorldReply, { kind: 'neighborhood' }>;
  catalog: PetCatalog | null;
  t: PetWorldTranslate;
}

/** Every enrolled account with a pet profile appears in its class neighborhood. */
export function PetNeighborhoodPanel({
  userId,
  className,
  neighborhood,
  catalog,
  t,
}: PetNeighborhoodPanelProps): ReactElement {
  const visit = usePetHomeVisit(userId, neighborhood.classId);
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
      <section className="pet-world-panel" aria-label={t('Class neighborhood', 'Khu phố của lớp')}>
        <h2>{t('Around the neighborhood.', 'Ghé thăm hàng xóm.')}</h2>
        <Text size="sm" c="dimmed" mb="lg">
          {t(
            'Every student in this class appears here once their pet’s home is set up. See classmates’ names, pets and decorations; points and teacher notes stay private.',
            'Nhà của mọi học sinh trong lớp xuất hiện tại đây khi thú cưng đã sẵn sàng. Bạn có thể xem tên bạn học, thú cưng và đồ trang trí; điểm và lời thầy cô nhận xét luôn riêng tư.',
          )}
        </Text>
        <div className="pet-world-neighbors">
          {neighborhood.homes.map((home) => {
            const petName = home.profile.names[home.profile.activePetId];
            return (
              <article className="pet-world-neighbor" key={home.studentId}>
                <div className="pet-world-neighbor-preview">
                  {/* Still portraits keep large class neighborhoods light to render. */}
                  <PetMascot
                    petId={home.profile.activePetId}
                    label={t(`Pet ${petName}`, `Thú cưng ${petName}`)}
                    reducedMotion
                  />
                </div>
                <Text fw={600}>{petName}</Text>
                <Text size="sm" c="dimmed" mt={4}>
                  {t(`Owned by ${home.displayName}`, `Chủ nhân: ${home.displayName}`)}
                </Text>
                <Button
                  variant="default"
                  size="xs"
                  mt="md"
                  fullWidth
                  aria-label={t(
                    `Visit ${home.displayName}'s home`,
                    `Ghé thăm nhà của ${home.displayName}`,
                  )}
                  onClick={() => {
                    void visit.visitHome(home.studentId);
                  }}
                >
                  {t('Visit home', 'Ghé thăm nhà')}
                </Button>
              </article>
            );
          })}
        </div>
        {!neighborhood.homes.length && (
          <Text className="pet-world-empty">
            {t(
              'No pet homes yet. Classmates appear here once their companions are set up.',
              'Chưa có nhà thú cưng. Các bạn sẽ xuất hiện tại đây khi thú cưng đã sẵn sàng.',
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
              'This home is not available to visit right now. Class membership may have changed.',
              'Hiện chưa thể ghé thăm nhà này. Thành viên của lớp có thể đã thay đổi.',
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
