import { Alert, Badge, Group, NativeSelect, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import type { OrganizationSetupView } from './UseOrganizationSetup.js';
import { useLocale } from '../localization/UseLocale.js';

interface AdminOrganizationSwitcherProps {
  view: OrganizationSetupView;
  disabled: boolean;
  onSelect: (organizationId: string | null) => Promise<void>;
}

/** Always-visible scope makes administrative edits attributable to the signed-in administrator. */
export function AdminOrganizationSwitcher({
  view,
  disabled,
  onSelect,
}: AdminOrganizationSwitcherProps): ReactElement {
  const { locale } = useLocale();
  const vietnamese = locale === 'vi';
  return (
    <Stack gap="xs" p="sm">
      <Group gap="sm" wrap="wrap">
        <Badge color="orange">{vietnamese ? 'Quản trị viên' : 'Admin'}</Badge>
        <NativeSelect
          aria-label={vietnamese ? 'Tổ chức đang quản trị' : 'Admin organization'}
          value={view.adminOrganizationId ?? ''}
          disabled={disabled || view.isBusy}
          data={[
            { value: '', label: vietnamese ? 'Không gian cá nhân' : 'Personal workspace' },
            ...view.organizations.map((organization) => ({
              value: organization.id,
              label: organization.name,
            })),
          ]}
          onChange={(event) => {
            void onSelect(event.currentTarget.value || null);
          }}
        />
        <Text size="xs" c="dimmed">
          {view.adminOrganizationId
            ? vietnamese
              ? 'Bạn đang xem và chỉnh sửa tổ chức này với quyền quản trị viên.'
              : 'Viewing and editing this organization as yourself, with admin access.'
            : vietnamese
              ? 'Chọn tổ chức để quản trị.'
              : 'Choose an organization to manage it.'}
        </Text>
      </Group>
      {view.failure && (
        <Alert color="red" role="alert">
          {vietnamese
            ? 'Chưa thể chuyển tổ chức. Hoàn tất thao tác đang chạy rồi thử lại.'
            : 'Could not load or switch organizations. Finish active work, then try again.'}
        </Alert>
      )}
    </Stack>
  );
}
