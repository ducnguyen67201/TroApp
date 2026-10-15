import { StudentAccessKind } from '#contracts/StudentAccess.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconQrcode } from '@tabler/icons-react';
import {
  StudentAccessReplySchema,
  StudentExternalIdSchema,
  StudentActivationCodeSchema,
  type StudentAccessReply,
  type StudentDeviceContextSchema,
} from '#contracts/StudentAccess.js';
import { StudentDeviceMode, StudentQrLimits } from '#contracts/StudentIdentity.js';
import type { z } from 'zod';
import type { ComputerUseController } from '../UseComputerUse.js';
import { useLocale } from '../localization/UseLocale.js';
import { StudentQrScanner } from './StudentQrScanner.js';

export function StudentAccessForm({
  controller,
  onSuccess,
  mode = StudentDeviceMode.SHARED,
}: {
  controller: Pick<ComputerUseController, 'enrollStudent'> &
    Partial<Pick<ComputerUseController, 'refreshAccounts' | 'savedAccounts'>>;
  onSuccess: () => void;
  mode?: StudentDeviceMode;
}): ReactElement {
  const { locale } = useLocale();
  const t = (english: string, vietnamese: string): string =>
    locale === 'vi' ? vietnamese : english;
  const [context, setContext] = useState<z.infer<typeof StudentDeviceContextSchema> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [externalId, setExternalId] = useState('');
  const [name, setName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activationId = useRef(crypto.randomUUID());
  const enrollmentId = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const activeAccount = controller.savedAccounts?.accounts.find(
    (account) => account.id === controller.savedAccounts?.activeAccountId,
  );
  const hasActiveQrAccount = Boolean(
    controller.savedAccounts?.activeAccountId && (!activeAccount || activeAccount.user.learner),
  );

  useEffect(() => {
    let disposed = false;
    void window.tro
      .controlStudentAccess?.({ kind: StudentAccessKind.STATUS })
      .then((raw) => {
        if (!disposed) {
          const result = StudentAccessReplySchema.parse(raw);
          if (result.kind === 'ready') {
            setContext(result.context);
          } else if (result.kind === 'failed') {
            setError(result.message);
          }
        }
      })
      .catch(() => {
        if (!disposed) {
          setError('Student access is unavailable.');
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function submit(): Promise<void> {
    if (submitting.current || !window.tro.controlStudentAccess) {
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      let result: StudentAccessReply;
      if (!context) {
        result = await window.tro.controlStudentAccess({
          kind: StudentAccessKind.ACTIVATE,
          code,
          mode,
          requestId: activationId.current,
        });
      } else {
        if (!StudentExternalIdSchema.safeParse(externalId).success || !controller.enrollStudent) {
          setError(t('Scan your QR or enter its text.', 'Quét QR hoặc nhập nội dung của mã QR.'));
          return;
        }
        result = await controller.enrollStudent({
          kind: StudentAccessKind.ENROLL,
          externalId,
          name: name.trim(),
          requestId: enrollmentId.current,
        });
      }
      if (result.kind === 'ready') {
        setContext(result.context);
        await controller.refreshAccounts?.();
      } else if (result.kind === 'signed-in') {
        onSuccess();
      } else if (result.kind === 'failed') {
        setError(result.message);
      }
    } catch {
      setError(t('Could not sign in. Please retry.', 'Chưa đăng nhập được. Em thử lại nhé.'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function deactivateComputer(): Promise<void> {
    if (submitting.current || !window.tro.controlStudentAccess) {
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const reply = await window.tro.controlStudentAccess({ kind: StudentAccessKind.DEACTIVATE });
      if (reply.kind === 'done') {
        setContext(null);
        setError(null);
        setCode('');
        await controller.refreshAccounts?.();
      } else if (reply.kind === 'failed') {
        setError(reply.message);
      }
    } catch {
      setError(
        t(
          'Could not remove computer authorization. Please retry.',
          'Chưa gỡ được quyền máy tính. Vui lòng thử lại.',
        ),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Group role="status">
        <Loader size="sm" />
        <Text size="sm">{t('Checking this device…', 'Đang kiểm tra máy…')}</Text>
      </Group>
    );
  }

  return (
    <Stack gap="sm">
      {error && <Alert role="alert">{error}</Alert>}
      {context && (
        <Text size="sm" fw={600}>
          {context.schoolName}
          {context.className ? ` · ${context.className}` : ''}
        </Text>
      )}
      {scanning ? (
        <StudentQrScanner
          onRead={(value) => {
            setScanning(false);
            const decoded = StudentExternalIdSchema.safeParse(value);
            if (decoded.success) {
              setExternalId(value);
              enrollmentId.current = crypto.randomUUID();
              setError(null);
            } else {
              console.warn('student.qr.rejected', {
                stage: 'decoded-text-validation',
                reason: decoded.error.issues[0]?.code ?? 'invalid',
                characters: value.length,
              });
              setError(
                t(
                  `Use a QR containing non-empty text up to ${String(StudentQrLimits.TEXT_CHARACTERS)} characters, without null characters.`,
                  `Dùng QR có nội dung văn bản không rỗng, tối đa ${String(StudentQrLimits.TEXT_CHARACTERS)} ký tự và không chứa ký tự null.`,
                ),
              );
            }
          }}
          onClose={() => {
            setScanning(false);
          }}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Stack gap="sm">
            {!context ? (
              <>
                <Text size="sm" c="dimmed">
                  {t(
                    mode === StudentDeviceMode.PERSONAL
                      ? 'Enable QR login once using your organization code. Your saved Google accounts stay available on this personal computer.'
                      : 'Authorize this company computer once using the code from your organization administrator. Students can then sign in with their school QR.',
                    mode === StudentDeviceMode.PERSONAL
                      ? 'Dùng mã tổ chức để bật đăng nhập QR một lần. Các tài khoản Google đã lưu vẫn dùng được trên máy cá nhân này.'
                      : 'Dùng mã từ quản trị viên tổ chức để kích hoạt máy này một lần. Sau đó học sinh đăng nhập bằng QR của trường.',
                  )}
                </Text>
                <TextInput
                  label={t('Organization activation code', 'Mã kích hoạt tổ chức')}
                  description={t(
                    'Get the reusable TRO- code from Settings → Team → Company computers. This computer will be named automatically.',
                    'Lấy mã TRO- dùng chung trong Cài đặt → Đội nhóm → Máy tính của tổ chức. Máy này sẽ được đặt tên tự động.',
                  )}
                  error={
                    code && !StudentActivationCodeSchema.safeParse(code).success
                      ? t(
                          'Enter the full TRO- code followed by 16 letters or digits 2–7.',
                          'Nhập đủ mã TRO- kèm 16 chữ cái hoặc chữ số 2–7.',
                        )
                      : undefined
                  }
                  value={code}
                  required
                  maxLength={21}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => {
                    setCode(event.currentTarget.value.replace(/\s/g, '').toUpperCase());
                    activationId.current = crypto.randomUUID();
                  }}
                />
              </>
            ) : (
              <>
                <Button
                  variant="light"
                  leftSection={<IconQrcode size={18} />}
                  disabled={busy}
                  onClick={() => {
                    setScanning(true);
                  }}
                >
                  {t('Scan your student card', 'Quét thẻ học sinh')}
                </Button>
                <Textarea
                  label={t('Student ID or QR text', 'Mã học sinh hoặc nội dung QR')}
                  description={t(
                    'Random text and URLs are supported. Tro uses the exact text to find your account; it does not open the link.',
                    'Có thể dùng văn bản ngẫu nhiên hoặc đường dẫn. Tro dùng đúng nội dung để tìm tài khoản và không mở đường dẫn.',
                  )}
                  rows={2}
                  value={externalId}
                  required
                  maxLength={StudentQrLimits.TEXT_CHARACTERS}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => {
                    setExternalId(event.currentTarget.value);
                    enrollmentId.current = crypto.randomUUID();
                  }}
                />
                <TextInput
                  label={t('What should Tro call you?', 'Tro gọi em là gì?')}
                  description={t(
                    'Only needed for your first sign-in. Scan the same card to return to your account.',
                    'Chỉ cần khi đăng nhập lần đầu. Quét lại thẻ để vào tài khoản đã có.',
                  )}
                  value={name}
                  maxLength={80}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    enrollmentId.current = crypto.randomUUID();
                  }}
                />
                <Text size="xs" c="dimmed">
                  {context.mode === StudentDeviceMode.PERSONAL
                    ? t(
                        'Tro remembers your login on this personal device.',
                        'Tro ghi nhớ đăng nhập trên máy cá nhân này.',
                      )
                    : t(
                        'Company computer. Choose Change student when finished. Your account and work stay saved; this computer forgets your login.',
                        'Máy của tổ chức. Chọn Đổi học sinh khi học xong. Tài khoản và bài làm vẫn được lưu; máy không giữ đăng nhập của em.',
                      )}
                </Text>
              </>
            )}
            <Button
              type="submit"
              loading={busy}
              disabled={
                !window.tro.controlStudentAccess ||
                (context
                  ? !StudentExternalIdSchema.safeParse(externalId).success
                  : !StudentActivationCodeSchema.safeParse(code).success)
              }
            >
              {context
                ? t('Start learning', 'Bắt đầu học')
                : t('Activate computer', 'Kích hoạt máy tính')}
            </Button>
            {(context?.organizationId ||
              controller.savedAccounts?.deviceMode === StudentDeviceMode.SHARED) && (
              <Button
                variant="subtle"
                size="xs"
                disabled={busy || hasActiveQrAccount}
                onClick={() => {
                  void deactivateComputer();
                }}
              >
                {context?.mode === StudentDeviceMode.PERSONAL
                  ? t('Remove QR authorization', 'Gỡ quyền đăng nhập QR')
                  : t('Remove company authorization', 'Gỡ quyền máy của tổ chức')}
              </Button>
            )}
          </Stack>
        </form>
      )}
    </Stack>
  );
}

export function StudentSignInButton({
  controller,
}: {
  controller: ComputerUseController;
}): ReactElement {
  const { locale } = useLocale();
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Button
        variant="light"
        leftSection={<IconQrcode size={18} />}
        disabled={controller.isLoading || controller.isSigning || controller.isSwitchingAccount}
        onClick={() => {
          setOpened(true);
        }}
      >
        {locale === 'vi'
          ? 'Máy tính của tổ chức · Học sinh dùng QR'
          : 'Company computer · Student QR'}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          if (!controller.isSwitchingAccount) {
            setOpened(false);
          }
        }}
        closeOnClickOutside={!controller.isSwitchingAccount}
        closeOnEscape={!controller.isSwitchingAccount}
        title={locale === 'vi' ? 'Máy tính của tổ chức' : 'Company computer'}
        centered
        keepMounted
      >
        {opened && (
          <StudentAccessForm
            controller={controller}
            onSuccess={() => {
              setOpened(false);
            }}
          />
        )}
      </Modal>
    </>
  );
}
