import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Loader, Select, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { AccountRole } from '#contracts/AccountRole.js';
import { PetWorldCommandKind, PetWorldFailure, type PetWorldCommand } from '#contracts/PetWorld.js';
import { useLocale } from '../localization/UseLocale.js';
import { OwnPetWorldPanel } from './OwnPetWorldPanel.js';
import { PetNeighborhoodPanel } from './PetNeighborhoodPanel.js';
import { TeacherRecognitionPanel } from './TeacherRecognitionPanel.js';
import { formatPoints, type PetWorldTranslate } from './PetWorldLabels.js';
import { usePetWorld } from './UsePetWorld.js';
import './PetWorld.css';

interface PetWorldPageProps {
  userId: string;
  userName: string;
  initialClassId: string | null;
  onChooseClass: (classId?: string) => void;
  onRoleChange: (role: AccountRole) => void;
}

function describeFailure(failure: PetWorldFailure, t: PetWorldTranslate): string {
  switch (failure) {
    case PetWorldFailure.UNAUTHORIZED:
      return t('Sign in again to continue.', 'Đăng nhập lại để tiếp tục.');
    case PetWorldFailure.FORBIDDEN:
      return t(
        'Your class access changed. Refresh to see your current classes.',
        'Quyền truy cập lớp đã thay đổi. Cập nhật để xem các lớp hiện tại.',
      );
    case PetWorldFailure.INVALID:
      return t(
        'Check the selected students, amount and details, then try again.',
        'Kiểm tra học sinh, số điểm và thông tin rồi thử lại.',
      );
    case PetWorldFailure.INSUFFICIENT_POINTS:
      return t(
        'There are not enough points for this action. Your balance has not changed.',
        'Chưa đủ điểm cho thao tác này. Số dư không thay đổi.',
      );
    case PetWorldFailure.REVERSAL_UNAVAILABLE:
      return t(
        'This award cannot be reversed. If the points have been spent, you can void the recognition while leaving points and items with the student.',
        'Chưa thể hoàn tác lần tặng điểm này. Nếu điểm đã được tiêu, bạn có thể chỉ hủy ghi nhận và giữ nguyên điểm, vật phẩm của học sinh.',
      );
    case PetWorldFailure.STALE:
      return t(
        'Your world changed on another device. Refresh, review the current state and try again.',
        'Thế giới đã thay đổi trên thiết bị khác. Cập nhật, xem lại trạng thái rồi thử lại.',
      );
    case PetWorldFailure.STALE_CATALOG:
      return t(
        'The shop changed. Refresh and review the current price before buying again.',
        'Cửa hàng đã thay đổi. Cập nhật và xem lại giá trước khi mua.',
      );
    case PetWorldFailure.ALREADY_OWNED:
      return t(
        'You already own this item. Refresh to find it in your inventory.',
        'Bạn đã sở hữu vật phẩm này. Cập nhật để xem trong kho.',
      );
    case PetWorldFailure.INCOMPATIBLE_ITEM:
      return t(
        'This item cannot be used with the selected companion or spot.',
        'Vật phẩm không dùng được với thú cưng hoặc vị trí đã chọn.',
      );
    case PetWorldFailure.HOME_UNAVAILABLE:
      return t(
        'This home is no longer available in this class.',
        'Ngôi nhà không còn khả dụng trong lớp này.',
      );
    case PetWorldFailure.INITIALIZATION_REQUIRED:
      return t(
        'Your home is still being prepared. Refresh to continue.',
        'Nhà của bạn đang được chuẩn bị. Cập nhật để tiếp tục.',
      );
    case PetWorldFailure.REQUEST_CONFLICT:
      return t(
        'This request was already used for different details. Refresh and review the saved result.',
        'Yêu cầu này đã được dùng với thông tin khác. Cập nhật và xem lại kết quả đã lưu.',
      );
    case PetWorldFailure.UNAVAILABLE:
      return t(
        'Could not confirm the result. Check your connection, then retry any pending action below with its original request.',
        'Chưa xác nhận được kết quả. Kiểm tra kết nối rồi thử lại thao tác đang chờ bên dưới bằng yêu cầu ban đầu.',
      );
  }
}

function describePendingCommand(command: PetWorldCommand, t: PetWorldTranslate): string {
  switch (command.kind) {
    case PetWorldCommandKind.GRANT_POINTS:
      return t(
        `Point award to ${command.studentIds.length.toString()} students`,
        `Tặng điểm cho ${command.studentIds.length.toString()} học sinh`,
      );
    case PetWorldCommandKind.BUY_ITEM:
      return t('Shop purchase', 'Mua vật phẩm');
    case PetWorldCommandKind.REVERSE_GRANT:
    case PetWorldCommandKind.VOID_RECOGNITION:
      return t('Recognition correction', 'Sửa ghi nhận');
    case PetWorldCommandKind.SET_HOME_SHARING:
      return t('Previous home setting', 'Cài đặt nhà trước đây');
    default:
      return t('Companion or home update', 'Cập nhật thú cưng hoặc ngôi nhà');
  }
}

function createDateValue(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Composes independent owner, teacher and visitor views around the narrow desktop bridge. */
export function PetWorldPage({
  userId,
  userName,
  initialClassId,
  onChooseClass,
  onRoleChange,
}: PetWorldPageProps): ReactElement {
  const { locale } = useLocale();
  const t = useCallback<PetWorldTranslate>(
    (english, vietnamese) => (locale === 'vi' ? vietnamese : english),
    [locale],
  );
  const [fromDate, setFromDate] = useState(() => createDateValue(-6));
  const [toDate, setToDate] = useState(() => createDateValue(0));
  const period = useMemo(
    () => ({
      from: `${fromDate || createDateValue(-6)}T00:00:00.000Z`,
      to: new Date(
        Date.parse(`${toDate || createDateValue(0)}T00:00:00.000Z`) + 86_400_000,
      ).toISOString(),
    }),
    [fromDate, toDate],
  );
  const view = usePetWorld(userId, initialClassId, period);
  const isTeacher = view.classroom?.role === AccountRole.TEACHER;
  const disabled = view.isSaving || view.pendingCommands.length > 0;
  const selectedClass = view.classroom?.classes.find(
    (entry) => entry.schoolClass.id === initialClassId,
  )?.schoolClass;

  useEffect(() => {
    if (view.classroom) {
      onRoleChange(view.classroom.role);
      if (!initialClassId) {
        const firstClass = view.classroom.classes[0];
        if (firstClass) {
          onChooseClass(firstClass.schoolClass.id);
        }
      }
    }
  }, [view.classroom, initialClassId, onChooseClass, onRoleChange]);

  return (
    <main className="pet-world-page">
      <Group className="pet-world-heading" justify="space-between" align="start">
        <div>
          <Text className="pet-world-eyebrow">
            {t('A world that grows with you', 'Thế giới lớn lên cùng bạn')}
          </Text>
          <h1>
            {isTeacher
              ? t('Good moments deserve a little room.', 'Dành chỗ cho những khoảnh khắc đẹp.')
              : t(`Welcome home, ${userName}.`, `Chào mừng về nhà, ${userName}.`)}
          </h1>
          <Text c="dimmed" size="sm">
            {isTeacher
              ? t(
                  'Recognize curiosity, persistence and contributions in your classroom.',
                  'Ghi nhận sự tò mò, kiên trì và đóng góp trong lớp học.',
                )
              : t(
                  'Little moments of learning. A world that feels like you.',
                  'Những khoảnh khắc học tập nhỏ. Một thế giới mang dấu ấn của bạn.',
                )}
          </Text>
        </div>
        {view.world && (
          <div className="pet-world-wallet" aria-label={t('Your wallet', 'Ví của bạn')}>
            <strong>{formatPoints(view.world.wallet.balance, locale)}</strong>
            <small>{t('Points to spend', 'Điểm có thể dùng')}</small>
          </div>
        )}
      </Group>
      {!view.isAvailable && (
        <Alert role="status" mb="lg">
          {t(
            'Pet world is unavailable in this desktop version.',
            'Thế giới thú cưng chưa khả dụng trong phiên bản này.',
          )}
        </Alert>
      )}
      {view.failure && (
        <Alert role="alert" mb="lg">
          {describeFailure(view.failure, t)}
        </Alert>
      )}
      {view.pendingCommands.length > 0 && (
        <Alert
          color="yellow"
          title={t('An action is waiting for confirmation', 'Một thao tác đang chờ xác nhận')}
          mb="lg"
        >
          <Stack gap="sm">
            <Text size="sm">
              {t(
                'Retry the original action to safely check its saved result. New actions stay paused until it is resolved.',
                'Thử lại thao tác ban đầu để kiểm tra kết quả đã lưu. Các thao tác mới tạm dừng đến khi hoàn tất.',
              )}
            </Text>
            {view.pendingCommands.map((command) => (
              <Group
                key={'requestId' in command ? command.requestId : command.kind}
                justify="space-between"
              >
                <Text size="sm">{describePendingCommand(command, t)}</Text>
                <Button
                  variant="default"
                  size="xs"
                  disabled={view.isSaving}
                  onClick={() => {
                    void view.sendCommand(command);
                  }}
                >
                  {t('Retry original action', 'Thử lại thao tác ban đầu')}
                </Button>
              </Group>
            ))}
          </Stack>
        </Alert>
      )}
      <Group justify="space-between" mb="lg" align="end">
        <Select
          label={t('Class community', 'Cộng đồng lớp học')}
          placeholder={t('No class selected', 'Chưa chọn lớp')}
          value={initialClassId}
          data={
            view.classroom?.classes.map((entry) => ({
              value: entry.schoolClass.id,
              label: entry.schoolClass.name,
            })) ?? []
          }
          onChange={(classId) => {
            onChooseClass(classId ?? undefined);
          }}
          w={280}
        />
        <Button
          variant="subtle"
          size="sm"
          leftSection={<IconRefresh size={16} />}
          disabled={view.isSaving}
          onClick={() => {
            void view.refresh();
          }}
        >
          {t('Refresh', 'Cập nhật')}
        </Button>
      </Group>
      {view.isLoading && (
        <Group justify="center" py="xl" role="status">
          <Loader size="sm" />
          <Text size="sm">{t('Opening your world…', 'Đang mở thế giới của bạn…')}</Text>
        </Group>
      )}
      {!view.isLoading && (
        <Tabs defaultValue={isTeacher ? 'recognition' : 'home'} keepMounted={false}>
          <Tabs.List mb="lg">
            {isTeacher && (
              <Tabs.Tab value="recognition">
                {t('Teacher recognition', 'Thầy cô ghi nhận')}
              </Tabs.Tab>
            )}
            {view.world && (
              <Tabs.Tab value="home">{t('My home & shop', 'Nhà & cửa hàng')}</Tabs.Tab>
            )}
            {selectedClass && (
              <Tabs.Tab value="neighborhood">{t('Class neighborhood', 'Khu phố của lớp')}</Tabs.Tab>
            )}
          </Tabs.List>
          {isTeacher && (
            <Tabs.Panel value="recognition">
              <Group mb="lg" align="end">
                <TextInput
                  type="date"
                  label={t('Recognition from (UTC)', 'Ghi nhận từ (UTC)')}
                  value={fromDate}
                  max={toDate}
                  onChange={(event) => {
                    if (event.currentTarget.value) {
                      setFromDate(event.currentTarget.value);
                    }
                  }}
                />
                <TextInput
                  type="date"
                  label={t('Through (UTC)', 'Đến hết (UTC)')}
                  value={toDate}
                  min={fromDate}
                  onChange={(event) => {
                    if (event.currentTarget.value) {
                      setToDate(event.currentTarget.value);
                    }
                  }}
                />
              </Group>
              {view.recognition ? (
                <TeacherRecognitionPanel
                  key={view.recognition.classId}
                  userId={userId}
                  recognition={view.recognition}
                  isSaving={disabled}
                  locale={locale}
                  t={t}
                  sendCommand={view.sendCommand}
                  readOlderRecognitions={view.readOlderRecognitions}
                />
              ) : (
                <Text className="pet-world-empty">
                  {t(
                    'Choose one of your classes to recognize its students.',
                    'Chọn một lớp của bạn để ghi nhận học sinh.',
                  )}
                </Text>
              )}
            </Tabs.Panel>
          )}
          {view.world && (
            <Tabs.Panel value="home">
              <OwnPetWorldPanel
                userName={userName}
                world={view.world}
                catalog={view.catalog}
                history={view.history}
                isSaving={disabled}
                locale={locale}
                t={t}
                sendCommand={view.sendCommand}
                readOlderHistory={view.readOlderHistory}
              />
            </Tabs.Panel>
          )}
          {selectedClass && (
            <Tabs.Panel value="neighborhood">
              {view.neighborhood ? (
                <PetNeighborhoodPanel
                  key={selectedClass.id}
                  userId={userId}
                  className={selectedClass.name}
                  neighborhood={view.neighborhood}
                  catalog={view.catalog}
                  t={t}
                />
              ) : (
                <Text className="pet-world-empty">
                  {t('Refresh to open this class neighborhood.', 'Cập nhật để mở khu phố của lớp.')}
                </Text>
              )}
            </Tabs.Panel>
          )}
          {!isTeacher && !view.world && (
            <Text className="pet-world-empty">
              {t('Refresh to prepare your own home.', 'Cập nhật để chuẩn bị ngôi nhà của bạn.')}
            </Text>
          )}
        </Tabs>
      )}
    </main>
  );
}
