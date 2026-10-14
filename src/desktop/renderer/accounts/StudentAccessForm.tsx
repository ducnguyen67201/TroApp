import { StudentAccessKind } from '#contracts/StudentAccess.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconQrcode } from '@tabler/icons-react';
import {
  StudentAccessReplySchema,
  StudentExternalIdSchema,
  type StudentAccessReply,
  type StudentDeviceContextSchema,
} from '#contracts/StudentAccess.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import type { z } from 'zod';
import type { ComputerUseController } from '../UseComputerUse.js';
import { useLocale } from '../localization/UseLocale.js';
import { StudentQrScanner } from './StudentQrScanner.js';

export function StudentAccessForm({
  controller,
  onSuccess,
}: {
  controller: Pick<ComputerUseController, 'enrollStudent'>;
  onSuccess: () => void;
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
          requestId: activationId.current,
        });
      } else {
        if (!StudentExternalIdSchema.safeParse(externalId).success || !controller.enrollStudent) {
          setError(
            t('Enter the student ID printed on your card.', 'Nhập đúng mã học sinh in trên thẻ.'),
          );
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
          {context.schoolName} · {context.className}
        </Text>
      )}
      {scanning ? (
        <StudentQrScanner
          onRead={(value) => {
            setScanning(false);
            if (StudentExternalIdSchema.safeParse(value).success) {
              setExternalId(value);
              enrollmentId.current = crypto.randomUUID();
              setError(null);
            } else {
              setError(
                t(
                  'This QR is not a supported student ID. Enter the ID printed on the card.',
                  'QR chưa đúng định dạng mã học sinh. Em nhập mã in trên thẻ nhé.',
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
                    'Enter the class code from your teacher once to set up this device.',
                    'Nhập mã lớp từ thầy cô một lần để thiết lập máy này.',
                  )}
                </Text>
                <TextInput
                  label={t('Class setup code', 'Mã thiết lập lớp')}
                  value={code}
                  required
                  minLength={16}
                  maxLength={16}
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
                <TextInput
                  label={t('Student ID', 'Mã học sinh')}
                  value={externalId}
                  required
                  maxLength={128}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => {
                    setExternalId(event.currentTarget.value);
                    enrollmentId.current = crypto.randomUUID();
                  }}
                />
                <TextInput
                  label={t('What should Tro call you?', 'Tro gọi em là gì?')}
                  value={name}
                  required
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
                        'Shared classroom device. Your lesson closes when you finish or leave.',
                        'Máy dùng chung. Phiên học sẽ đóng khi em kết thúc hoặc rời máy.',
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
                  ? !name.trim() || !StudentExternalIdSchema.safeParse(externalId).success
                  : code.length !== 16)
              }
            >
              {context ? t('Start learning', 'Bắt đầu học') : t('Continue', 'Tiếp tục')}
            </Button>
            {context && (
              <Button
                variant="subtle"
                size="xs"
                disabled={busy}
                onClick={() => {
                  setContext(null);
                  setError(null);
                }}
              >
                {t('Use another class code', 'Dùng mã lớp khác')}
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
        {locale === 'vi' ? 'Học sinh · Dùng thẻ QR' : 'Student · Use QR card'}
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
        title={locale === 'vi' ? 'Vào học với Tro' : 'Learn with Tro'}
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
