import { useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Stack, Text, Textarea } from '@mantine/core';
import { StudentQrLimits } from '#contracts/StudentIdentity.js';
import { StudentExternalIdSchema } from '#contracts/StudentAccess.js';
import { ClassroomEnrollmentKind, ClassroomReplySchema } from '#contracts/Classroom.js';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** A teacher assigns an existing organization QR identity; device activation grants no enrollment. */
export function OrganizationStudentEnrollment({
  classId,
  disabled,
  t,
}: {
  classId: string;
  disabled: boolean;
  t: ClassroomTranslate;
}): ReactElement {
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);

  async function enrollStudent(): Promise<void> {
    if (
      pending.current ||
      disabled ||
      !StudentExternalIdSchema.safeParse(externalId).success ||
      !window.tro.controlClassroom
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const reply = ClassroomReplySchema.parse(
        await window.tro.controlClassroom({
          kind: ClassroomEnrollmentKind.QR_STUDENT,
          classId,
          externalId,
        }),
      );
      setMessage(
        reply.kind === 'ok'
          ? t('Student added to this class.', 'Đã thêm học sinh vào lớp này.')
          : t(
              'The student must first sign in on an authorized organization computer. Check their exact QR text or student ID and your class assignment.',
              'Học sinh cần đăng nhập trên máy đã được tổ chức cấp quyền trước. Kiểm tra đúng nội dung QR hoặc mã học sinh và quyền phụ trách lớp của bạn.',
            ),
      );
    } catch {
      setMessage(
        t('Could not add the student. Please retry.', 'Chưa thêm được học sinh. Vui lòng thử lại.'),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Stack component="section" aria-label={t('Add a QR student', 'Thêm học sinh dùng QR')} gap="sm">
      <Text fw={600}>{t('Add a QR student', 'Thêm học sinh dùng QR')}</Text>
      <Text size="sm" c="dimmed">
        {t(
          'An organization owner activates computers in Settings → Team → Company computers. After a student first signs in there, enter the exact text from their QR or their student ID here to enroll them in this class.',
          'Chủ tổ chức kích hoạt máy trong Cài đặt → Đội nhóm → Máy tính của tổ chức. Sau khi học sinh đăng nhập lần đầu trên máy đó, nhập đúng nội dung QR hoặc mã học sinh ở đây để ghi danh lớp này.',
        )}
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void enrollStudent();
        }}
      >
        <Stack gap="sm">
          <Textarea
            label={t('School student ID or QR text', 'Mã học sinh hoặc nội dung QR')}
            rows={2}
            value={externalId}
            required
            maxLength={StudentQrLimits.TEXT_CHARACTERS}
            disabled={disabled || busy}
            onChange={(event) => {
              setExternalId(event.currentTarget.value);
              setMessage(null);
            }}
          />
          <Button
            type="submit"
            loading={busy}
            disabled={disabled || !StudentExternalIdSchema.safeParse(externalId).success}
          >
            {t('Enroll QR student', 'Ghi danh học sinh QR')}
          </Button>
        </Stack>
      </form>
      {message && <Alert role="status">{message}</Alert>}
    </Stack>
  );
}
