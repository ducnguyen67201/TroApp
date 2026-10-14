import { StudentAccessKind } from '#contracts/StudentAccess.js';
import { useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import {
  StudentRosterRowsSchema,
  type StudentAccessCommand,
  type StudentAccessReply,
} from '#contracts/StudentAccess.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** Teachers approve admission scope once; importing metadata never verifies a scanner's identity. */
export function StudentAccessSettings({
  classId,
  name,
  disabled,
  t,
}: {
  classId: string;
  name: string;
  disabled: boolean;
  t: ClassroomTranslate;
}): ReactElement {
  const [schoolName, setSchoolName] = useState(name);
  const [mode, setMode] = useState<StudentDeviceMode>(StudentDeviceMode.PERSONAL);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StudentAccessReply | null>(null);
  const [rosterText, setRosterText] = useState('');
  const [preview, setPreview] = useState<Extract<
    StudentAccessReply,
    { kind: 'roster-preview' }
  > | null>(null);
  const blocked = busy || disabled;

  async function send(command: StudentAccessCommand): Promise<void> {
    if (blocked || !window.tro.controlStudentAccess) {
      return;
    }
    setBusy(true);
    try {
      const reply = await window.tro.controlStudentAccess(command);
      setResult(reply);
      if (reply.kind === 'roster-preview') {
        setPreview(reply);
      } else if (reply.kind === 'done') {
        setPreview(null);
      }
    } catch {
      setResult({
        kind: 'failed',
        message: t('Student access is unavailable.', 'Chưa dùng được truy cập học sinh.'),
      });
    } finally {
      setBusy(false);
    }
  }

  const rows = StudentRosterRowsSchema.safeParse(
    rosterText
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [externalId, ...parts] = line.replace(/\r$/, '').split('\t');
        return { externalId, name: parts.join('\t') };
      }),
  );

  return (
    <Stack
      gap="sm"
      component="section"
      aria-label={t('Student QR access', 'Truy cập bằng thẻ học sinh')}
    >
      <Text component="h2" fw={600}>
        {t('Student QR access', 'Truy cập bằng thẻ học sinh')}
      </Text>
      <Text size="sm" c="dimmed">
        {t(
          'Students set up a device using this class code, then scan their school card and enter a name. No email needed.',
          'Học sinh nhập mã lớp để thiết lập máy, rồi quét thẻ và nhập tên. Không cần email.',
        )}
      </Text>
      <TextInput
        label={t('School or center name', 'Tên trường hoặc trung tâm')}
        value={schoolName}
        maxLength={100}
        disabled={blocked}
        onChange={(event) => {
          setSchoolName(event.currentTarget.value);
        }}
      />
      <SegmentedControl
        value={mode}
        disabled={blocked}
        data={[
          { value: StudentDeviceMode.PERSONAL, label: t('Personal devices', 'Máy cá nhân') },
          {
            value: StudentDeviceMode.SHARED,
            label: t('One shared computer', 'Một máy dùng chung'),
          },
        ]}
        onChange={(value) => {
          setMode(value);
        }}
      />
      <Button
        disabled={blocked || !schoolName.trim()}
        onClick={() => {
          void send({
            kind: StudentAccessKind.CREATE_ADMISSION,
            classId,
            schoolName: schoolName.trim(),
            mode,
          });
        }}
      >
        {t('Create setup code', 'Tạo mã thiết lập')}
      </Button>
      {result?.kind === 'admission' && (
        <>
          <TextInput
            readOnly
            label={t('Share this setup code', 'Chia sẻ mã thiết lập này')}
            value={result.code}
          />
          <Text size="xs" c="dimmed">
            {t('Expires', 'Hết hạn')}: {new Date(result.expiresAt).toLocaleString()}.{' '}
            {result.mode === StudentDeviceMode.SHARED
              ? t(
                  'Activates one shared computer. Students are not remembered.',
                  'Kích hoạt một máy dùng chung. Không lưu đăng nhập học sinh.',
                )
              : t(
                  'For trusted personal devices. Each student login is remembered securely.',
                  'Dành cho máy cá nhân tin cậy. Đăng nhập học sinh được lưu an toàn.',
                )}
          </Text>
        </>
      )}
      {result?.kind === 'failed' && <Alert role="alert">{result.message}</Alert>}
      {result?.kind === 'done' && (
        <Text role="status" size="sm">
          {t('Changes saved.', 'Đã lưu thay đổi.')}
        </Text>
      )}
      <details>
        <summary>{t('Associate a school roster later', 'Liên kết danh sách trường sau')}</summary>
        <Stack gap="sm" mt="sm">
          <Text size="xs" c="dimmed">
            {t(
              'Paste student ID and name as two tab-separated columns. This associates metadata only; duplicate claims need review and no private accounts are merged.',
              'Dán hai cột mã học sinh và tên, ngăn bằng tab. Chỉ liên kết thông tin; mã trùng cần kiểm tra, không gộp tài khoản riêng tư.',
            )}
          </Text>
          <Textarea
            label={t('School roster', 'Danh sách trường')}
            value={rosterText}
            maxLength={100_000}
            minRows={4}
            disabled={blocked}
            onChange={(event) => {
              setRosterText(event.currentTarget.value);
              setPreview(null);
            }}
          />
          <Group>
            <Button
              variant="default"
              disabled={blocked || !rows.success}
              onClick={() => {
                if (rows.success) {
                  void send({ kind: StudentAccessKind.PREVIEW_ROSTER, classId, rows: rows.data });
                }
              }}
            >
              {t('Preview matches', 'Xem trước đối chiếu')}
            </Button>
            <Button
              disabled={blocked || !rows.success || !preview || preview.conflicts.length > 0}
              onClick={() => {
                if (rows.success && preview) {
                  void send({
                    kind: StudentAccessKind.APPLY_ROSTER,
                    classId,
                    rows: rows.data,
                    revision: preview.revision,
                  });
                }
              }}
            >
              {t('Apply metadata', 'Lưu thông tin đối chiếu')}
            </Button>
          </Group>
          {preview && (
            <Text size="sm" role="status">
              {t('Matched', 'Khớp')}: {preview.matched} · {t('Missing', 'Chưa có')}:{' '}
              {preview.missing} · {t('Conflicting IDs', 'Mã cần kiểm tra')}:{' '}
              {preview.conflicts.join(', ') || '0'}
            </Text>
          )}
        </Stack>
      </details>
      <Button
        variant="subtle"
        color="red"
        disabled={blocked}
        onClick={() => {
          void send({ kind: StudentAccessKind.REVOKE_ADMISSION, classId });
        }}
      >
        {t('Disable all QR access for this class', 'Vô hiệu toàn bộ truy cập QR của lớp')}
      </Button>
    </Stack>
  );
}
