import { StudentAccessKind } from '#contracts/StudentAccess.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Stack, Text } from '@mantine/core';
import jsQR from 'jsqr';
import { StudentDeviceLimits } from '#contracts/StudentIdentity.js';
import { useLocale } from '../localization/UseLocale.js';

/** Decode bounded frames locally. Camera images stay local; only decoded text is passed to the sign-in form. */
export function StudentQrScanner({
  onRead,
  onClose,
}: {
  onRead: (value: string) => void;
  onClose: () => void;
}): ReactElement {
  const { locale } = useLocale();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onRead, onClose });
  callbacks.current = { onRead, onClose };

  useEffect(() => {
    const lifetime = { disposed: false };
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + StudentDeviceLimits.CAMERA_MS;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    function isDisposed(): boolean {
      return lifetime.disposed;
    }

    function stop(): void {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      clearTimeout(timer);
      void window.tro.controlStudentAccess?.({ kind: StudentAccessKind.CAMERA_STOP });
    }

    function scan(): void {
      if (isDisposed()) {
        return;
      }
      if (Date.now() >= deadline || document.hidden) {
        stop();
        setFailed(true);
        return;
      }
      const element = video.current;
      if (element && context && element.readyState >= 2) {
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(pixels.data, canvas.width, canvas.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code) {
          stop();
          callbacks.current.onRead(code.data);
          return;
        }
      }
      timer = setTimeout(scan, 200);
    }

    void (async () => {
      const permission = await window.tro.controlStudentAccess?.({
        kind: StudentAccessKind.CAMERA_START,
      });
      if (isDisposed()) {
        return;
      }
      if (permission?.kind !== 'done') {
        throw new Error('Camera unavailable.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: { ideal: 'environment' },
        },
        audio: false,
      });
      if (isDisposed() || !video.current) {
        stop();
        return;
      }
      video.current.srcObject = stream;
      await video.current.play();
      scan();
    })().catch(() => {
      stop();
      if (!isDisposed()) {
        setFailed(true);
      }
    });
    return () => {
      lifetime.disposed = true;
      stop();
    };
  }, []);

  return (
    <Stack gap="sm">
      {failed ? (
        <Alert role="alert">
          {locale === 'vi'
            ? 'Không dùng được camera. Em có thể nhập nội dung QR bên dưới.'
            : 'Camera unavailable. You can enter the QR text instead.'}
        </Alert>
      ) : (
        <>
          <Text size="sm">
            {locale === 'vi' ? 'Đưa thẻ QR vào khung hình.' : 'Hold your QR card in the frame.'}
          </Text>
          <video
            ref={video}
            muted
            playsInline
            aria-label={locale === 'vi' ? 'Quét thẻ học sinh' : 'Scan student card'}
            style={{ width: '100%', maxHeight: 280, borderRadius: 12 }}
          />
        </>
      )}
      <Button variant="default" onClick={onClose}>
        {locale === 'vi' ? 'Nhập nội dung QR' : 'Enter QR text instead'}
      </Button>
    </Stack>
  );
}
