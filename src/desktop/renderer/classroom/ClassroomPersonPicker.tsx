import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Popover, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomViewAs,
  type ClassroomPeoplePage,
  type ClassroomPerson,
} from '#contracts/ClassroomViewAs.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** A person switcher in the existing toolbar; selecting a person keeps the same classroom UI. */
export function ClassroomPersonPicker({
  person,
  onSelect,
  t,
}: {
  person: ClassroomPerson | null;
  onSelect: (userId: string | null) => Promise<boolean>;
  t: ClassroomTranslate;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ClassroomPeoplePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!opened) {
      return;
    }
    let disposed = false;
    setPage(null);
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const reply = await window.tro.controlClassroom?.({
            kind: 'admin-people',
            search,
            offset,
          });
          if (!disposed) {
            setPage(reply?.kind === 'admin-people' ? reply : null);
            setFailed(reply?.kind !== 'admin-people');
          }
        } catch {
          if (!disposed) {
            setFailed(true);
          }
        } finally {
          if (!disposed) {
            setLoading(false);
          }
        }
      })();
    }, 200);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [opened, search, offset, revision]);

  async function select(userId: string | null): Promise<void> {
    if (switching) {
      return;
    }
    setSwitching(true);
    try {
      if (await onSelect(userId)) {
        setOpened(false);
      }
    } catch {
      setFailed(true);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Popover opened={opened} onChange={setOpened} width={360} position="bottom-end" withinPortal>
      <Popover.Target>
        <Button
          variant={person ? 'light' : 'default'}
          rightSection={<IconChevronDown size={15} />}
          onClick={() => {
            setOpened(!opened);
          }}
        >
          {t('View as', 'Xem với tư cách')}: {person?.name ?? t('Me', 'Tôi')}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t(
              'Changes are saved to the selected person’s classroom.',
              'Thay đổi được lưu vào lớp học của người được chọn.',
            )}
          </Text>
          <Button
            variant="subtle"
            disabled={switching}
            onClick={() => {
              void select(null);
            }}
          >
            {t('Return to my account', 'Trở về tài khoản của tôi')}
          </Button>
          <TextInput
            autoFocus
            aria-label={t('Find a person', 'Tìm người')}
            placeholder={t('Name or email', 'Tên hoặc email')}
            leftSection={<IconSearch size={16} />}
            value={search}
            maxLength={200}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setOffset(0);
            }}
          />
          {failed && (
            <Alert role="alert">
              {t('Could not load people.', 'Chưa tải được danh sách người dùng.')}
              <Button
                variant="subtle"
                onClick={() => {
                  setRevision(revision + 1);
                }}
              >
                {t('Retry', 'Thử lại')}
              </Button>
            </Alert>
          )}
          {loading && (
            <Text role="status" size="sm">
              {t('Loading…', 'Đang tải…')}
            </Text>
          )}
          <ScrollArea.Autosize mah={300}>
            <Stack gap={4}>
              {page?.people.map((entry) => (
                <Button
                  key={entry.id}
                  variant={person?.id === entry.id ? 'light' : 'subtle'}
                  justify="start"
                  h="auto"
                  py="xs"
                  disabled={switching}
                  onClick={() => {
                    void select(entry.id);
                  }}
                >
                  <Stack gap={2} align="start">
                    <Text size="sm" fw={600}>
                      {entry.name} ·{' '}
                      {entry.role === AccountRole.TEACHER
                        ? t('Teacher', 'Giáo viên')
                        : t('Student', 'Học sinh')}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {entry.email}
                    </Text>
                  </Stack>
                </Button>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {page?.people.length === 0 && (
            <Text size="sm">{t('No matching people.', 'Không tìm thấy người phù hợp.')}</Text>
          )}
          {(offset > 0 || page?.hasMore) && (
            <Group justify="space-between">
              <Button
                size="xs"
                variant="default"
                disabled={loading || switching || offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - ClassroomViewAs.PAGE_SIZE));
                }}
              >
                {t('Previous', 'Trước')}
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={loading || switching || !page?.hasMore}
                onClick={() => {
                  setOffset(offset + ClassroomViewAs.PAGE_SIZE);
                }}
              >
                {t('Next', 'Tiếp')}
              </Button>
            </Group>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
