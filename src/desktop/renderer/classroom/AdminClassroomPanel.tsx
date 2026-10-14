import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconRefresh, IconSearch } from '@tabler/icons-react';
import {
  ClassroomFailure,
  type AdminClassroomPage,
  type ClassroomReply,
} from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';
import { AdminClassroomDetail } from './AdminClassroomDetail.js';

interface AdminClassroomPanelProps {
  userId: string;
  onAccessLost: () => void;
  t: ClassroomTranslate;
}

/** Account changes discard all cross-class data; the backend authorizes every read. */
export function AdminClassroomPanel(props: AdminClassroomPanelProps): ReactElement {
  return <AdminClassroomBrowser key={props.userId} {...props} />;
}

function AdminClassroomBrowser({ onAccessLost, t }: AdminClassroomPanelProps): ReactElement {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offsets, setOffsets] = useState([0]);
  const [page, setPage] = useState<AdminClassroomPage | null>(null);
  const [classId, setClassId] = useState<string | null>(null);
  const [classSessionId, setClassSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Extract<ClassroomReply, { kind: 'admin-class' }> | null>(
    null,
  );
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const accessAllowed = useRef(true);
  const offset = offsets.at(-1) ?? 0;

  const rejectAccess = useCallback(
    (reply: ClassroomReply | undefined): boolean => {
      if (
        reply?.kind !== 'failed' ||
        (reply.code !== ClassroomFailure.FORBIDDEN && reply.code !== ClassroomFailure.UNAUTHORIZED)
      ) {
        return false;
      }
      accessAllowed.current = false;
      setPage(null);
      setDetail(null);
      setClassId(null);
      onAccessLost();
      return true;
    },
    [onAccessLost],
  );

  useEffect(() => {
    let disposed = false;
    setPage(null);
    setDetail(null);
    setClassId(null);
    setClassSessionId(null);
    setError(null);
    setListBusy(true);

    async function fetchClasses(): Promise<void> {
      try {
        const reply = await window.tro.controlClassroom?.({
          kind: 'admin-classes',
          search,
          offset,
        });
        if (disposed || !accessAllowed.current || rejectAccess(reply)) {
          return;
        }
        if (reply?.kind !== 'admin-classes') {
          setError(
            t(
              'Could not load classes. Try refreshing.',
              'Chưa tải được các lớp. Hãy cập nhật lại.',
            ),
          );
          return;
        }
        setPage(reply);
        setClassId(reply.classes[0]?.schoolClass.id ?? null);
      } catch {
        if (!disposed && accessAllowed.current) {
          setError(
            t(
              'Could not load classes. Try refreshing.',
              'Chưa tải được các lớp. Hãy cập nhật lại.',
            ),
          );
        }
      } finally {
        if (!disposed) {
          setListBusy(false);
        }
      }
    }

    void fetchClasses();
    return () => {
      disposed = true;
    };
  }, [search, offset, version, rejectAccess, t]);

  useEffect(() => {
    let disposed = false;
    setDetail(null);
    setDetailBusy(classId !== null);
    if (!classId) {
      return;
    }
    setError(null);

    async function fetchClass(selectedClassId: string): Promise<void> {
      try {
        const reply = await window.tro.controlClassroom?.({
          kind: 'admin-class',
          classId: selectedClassId,
          ...(classSessionId ? { classSessionId } : {}),
        });
        if (disposed || !accessAllowed.current || rejectAccess(reply)) {
          return;
        }
        if (
          reply?.kind !== 'admin-class' ||
          reply.schoolClass.id !== selectedClassId ||
          (classSessionId &&
            !reply.rosters.some((roster) => roster.classSessionId === classSessionId))
        ) {
          setError(
            t(
              'Could not load this class. Try refreshing.',
              'Chưa tải được lớp này. Hãy cập nhật lại.',
            ),
          );
          return;
        }
        setDetail(reply);
      } catch {
        if (!disposed && accessAllowed.current) {
          setError(
            t(
              'Could not load this class. Try refreshing.',
              'Chưa tải được lớp này. Hãy cập nhật lại.',
            ),
          );
        }
      } finally {
        if (!disposed) {
          setDetailBusy(false);
        }
      }
    }

    void fetchClass(classId);
    return () => {
      disposed = true;
    };
  }, [classId, classSessionId, rejectAccess, t]);

  function clearSelection(): void {
    setPage(null);
    setClassId(null);
    setClassSessionId(null);
    setDetail(null);
    setError(null);
  }

  return (
    <Stack gap="lg" aria-label={t('Admin class browser', 'Xem lớp dành cho quản trị viên')}>
      <Alert title={t('Read-only admin view', 'Chế độ xem quản trị viên · Chỉ đọc')}>
        {t(
          'View any teacher’s class, course and session rosters. Viewing does not enroll you or change the class.',
          'Xem lớp, khóa học và danh sách học sinh theo buổi của mọi giáo viên. Việc xem không ghi danh bạn hoặc thay đổi lớp.',
        )}
      </Alert>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          clearSelection();
          setSearch(searchInput.trim());
          setOffsets([0]);
          setVersion((current) => current + 1);
        }}
      >
        <Group align="end">
          <TextInput
            flex={1}
            label={t('Find classes or teachers', 'Tìm lớp hoặc giáo viên')}
            placeholder={t(
              'Class name, teacher name or email',
              'Tên lớp, tên giáo viên hoặc email',
            )}
            leftSection={<IconSearch size={17} />}
            value={searchInput}
            maxLength={200}
            onChange={(event) => {
              setSearchInput(event.currentTarget.value);
            }}
          />
          <Button type="submit">{t('Search', 'Tìm kiếm')}</Button>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            disabled={listBusy || detailBusy}
            onClick={() => {
              clearSelection();
              setVersion((current) => current + 1);
            }}
          >
            {t('Refresh classes', 'Cập nhật các lớp')}
          </Button>
        </Group>
      </form>
      {error && <Alert role="alert">{error}</Alert>}
      {listBusy && <Text role="status">{t('Loading classes…', 'Đang tải các lớp…')}</Text>}
      {page && page.classes.length === 0 && (
        <Text c="dimmed">{t('No classes found.', 'Không tìm thấy lớp học.')}</Text>
      )}
      {page && (
        <>
          {page.classes.length > 0 && (
            <Select
              label={t('Class to view', 'Lớp muốn xem')}
              value={classId}
              data={page.classes.map((entry) => ({
                value: entry.schoolClass.id,
                label: `${entry.schoolClass.name} · ${entry.teacherName} (${entry.teacherEmail})`,
              }))}
              allowDeselect={false}
              onChange={(selectedClassId) => {
                setDetail(null);
                setClassId(selectedClassId);
                setClassSessionId(null);
              }}
            />
          )}
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {t('Page', 'Trang')} {offsets.length}
            </Text>
            <Group gap="xs">
              <Button
                variant="default"
                disabled={offsets.length === 1}
                onClick={() => {
                  clearSelection();
                  setOffsets((current) => current.slice(0, -1));
                }}
              >
                {t('Previous page', 'Trang trước')}
              </Button>
              <Button
                variant="default"
                disabled={!page.hasMore || page.classes.length === 0}
                onClick={() => {
                  clearSelection();
                  setOffsets((current) => [...current, offset + page.classes.length]);
                }}
              >
                {t('Next page', 'Trang sau')}
              </Button>
            </Group>
          </Group>
        </>
      )}
      {detailBusy && <Text role="status">{t('Loading class…', 'Đang tải lớp…')}</Text>}
      {detail && detail.schoolClass.id === classId && (
        <AdminClassroomDetail
          detail={detail}
          t={t}
          onSessionChange={(selectedSessionId) => {
            setDetail(null);
            setClassSessionId(selectedSessionId);
          }}
        />
      )}
    </Stack>
  );
}
