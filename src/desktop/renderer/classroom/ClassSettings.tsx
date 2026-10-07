import { useState, type ReactElement } from 'react';
import { Button, Stack, Text, TextInput } from '@mantine/core';
import type {
  ClassroomCommand,
  ClassroomInvitation,
  ClassroomRosterSchema,
} from '#contracts/Classroom.js';
import { ClassDeletion } from './ClassDeletion.js';
import type { z } from 'zod';
import type { ClassroomTranslate } from './ClassroomLabels.js';

/** Class management stays scoped to the selected, backend-authorized teacher class. */
export function ClassSettings({
  classId,
  name,
  live,
  busy,
  invitation,
  roster,
  sessionId,
  send,
  t,
}: {
  classId: string;
  name: string;
  live: boolean;
  busy: boolean;
  invitation: ClassroomInvitation | null;
  roster: z.infer<typeof ClassroomRosterSchema> | null;
  sessionId: string | null;
  send: (command: ClassroomCommand) => Promise<void>;
  t: ClassroomTranslate;
}): ReactElement {
  const [email, setEmail] = useState('');
  return (
    <Stack gap="xl">
      <section aria-label={t('Invite students', 'Mời học sinh')}>
        <Text component="h2" fw={600} mb="xs">
          {t('Invite students', 'Mời học sinh')}
        </Text>
        <Text size="sm" c="dimmed" mb="md">
          {t(
            'Add a student by the email they use to sign in to Tro. They will see this class automatically; joining a live session is still their choice.',
            'Thêm học sinh bằng email dùng để đăng nhập Tro. Lớp sẽ tự hiện trong tài khoản của họ; học sinh vẫn tự chọn tham gia buổi học.',
          )}
        </Text>
        <form
          aria-label={t('Add student', 'Thêm học sinh')}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && email.trim()) {
              void send({ kind: 'enroll', classId, email: email.trim().toLowerCase() });
            }
          }}
        >
          <Stack gap="sm">
            <TextInput
              label={t('Student email', 'Email học sinh')}
              type="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
              }}
            />
            <Button type="submit" disabled={busy || !email.trim()}>
              {t('Add student', 'Thêm học sinh')}
            </Button>
            <Text size="xs" c="dimmed">
              {t(
                'The student must have signed in once. This does not send an email.',
                'Học sinh cần đăng nhập ít nhất một lần. Thao tác này không gửi email.',
              )}
            </Text>
          </Stack>
        </form>
      </section>
      {sessionId && (
        <section aria-label={t('Enrolled students', 'Học sinh trong lớp')}>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              void send({ kind: 'session-roster', classSessionId: sessionId });
            }}
          >
            {t('Refresh students', 'Cập nhật học sinh')}
          </Button>
          {roster?.map((student) => (
            <div className="classroom-settings-student" key={student.studentId}>
              <Text size="sm">{student.name}</Text>
              <Button
                size="xs"
                variant="subtle"
                disabled={busy}
                onClick={() => {
                  void send({ kind: 'revoke', classId, studentId: student.studentId });
                }}
              >
                {t('Remove enrollment', 'Hủy ghi danh')}
              </Button>
            </div>
          ))}
        </section>
      )}
      <details className="classroom-disclosure">
        <summary>{t('Share an invitation code instead', 'Chia sẻ mã mời')}</summary>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t(
              'Students enter this code to enroll. Codes expire after seven days.',
              'Học sinh nhập mã để vào lớp. Mã hết hạn sau bảy ngày.',
            )}
          </Text>
          <Button
            disabled={busy}
            onClick={() => {
              void send({ kind: 'create-invitation', classId });
            }}
          >
            {t('Create invitation code', 'Tạo mã mời')}
          </Button>
          {invitation?.classId === classId && (
            <Stack gap="xs">
              <TextInput
                readOnly
                label={t('Share this code', 'Chia sẻ mã này')}
                value={invitation.code}
              />
              <Text size="xs" c="dimmed">
                {t('Expires', 'Hết hạn')}: {new Date(invitation.expiresAt).toLocaleDateString()}
              </Text>
            </Stack>
          )}
          <Button
            variant="subtle"
            disabled={busy}
            onClick={() => {
              void send({ kind: 'revoke-invitations', classId });
            }}
          >
            {t('Disable existing codes', 'Vô hiệu mã hiện có')}
          </Button>
        </Stack>
      </details>
      <section className="classroom-settings-danger">
        <Text component="h2" fw={600} mb="sm">
          {t('Delete class', 'Xóa lớp học')}
        </Text>
        <ClassDeletion
          name={name}
          live={live}
          busy={busy}
          t={t}
          onDelete={() => send({ kind: 'delete-class', classId })}
        />
      </section>
    </Stack>
  );
}
