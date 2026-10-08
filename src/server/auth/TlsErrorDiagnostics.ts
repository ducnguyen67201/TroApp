import { z } from 'zod';

const OpenSslErrorEncoding = {
  LIBRARY: 'SSL routines',
  REASON_BASE: 0x800000,
  ALERT_REASON_OFFSET: 1000,
  MAXIMUM_ALERT_NUMBER: 255,
  MAXIMUM_MESSAGE_CHARACTERS: 4096,
} as const;

export const TlsErrorNumbersSchema = z.object({
  socketTlsErrorNumber: z
    .string()
    .regex(/^0A[0-9A-F]{6}$/)
    .nullable(),
  socketTlsReasonNumber: z
    .number()
    .int()
    .min(0)
    .max(OpenSslErrorEncoding.REASON_BASE - 1)
    .nullable(),
  socketTlsAlertNumber: z
    .number()
    .int()
    .min(0)
    .max(OpenSslErrorEncoding.MAXIMUM_ALERT_NUMBER)
    .nullable(),
});

export type TlsErrorNumbers = z.infer<typeof TlsErrorNumbersSchema>;

/** Retain only OpenSSL's packed SSL error number and its numeric reason/alert.
 * Node has no structured numeric error field, so extract the fixed hexadecimal token
 * from a bounded message with the expected library marker. No surrounding text is
 * logged. This remains useful when an OpenSSL upgrade changes the textual error code.
 * Encoding: openssl/err.h uses 23 reason bits; SSL alert reasons are 1000 + alert.
 */
export function readTlsErrorNumbers(error: unknown): TlsErrorNumbers {
  const unavailable: TlsErrorNumbers = {
    socketTlsErrorNumber: null,
    socketTlsReasonNumber: null,
    socketTlsAlertNumber: null,
  };
  const parsed = z
    .object({ library: z.unknown().optional(), message: z.unknown().optional() })
    .safeParse(error);
  if (
    !parsed.success ||
    parsed.data.library !== OpenSslErrorEncoding.LIBRARY ||
    typeof parsed.data.message !== 'string'
  ) {
    return unavailable;
  }
  const match = /(?:^|:)error:(0[aA][0-9a-fA-F]{6}):SSL routines:/.exec(
    parsed.data.message.slice(0, OpenSslErrorEncoding.MAXIMUM_MESSAGE_CHARACTERS),
  );
  const packedNumber = match?.[1];
  if (packedNumber === undefined) {
    return unavailable;
  }
  const reasonNumber = Number.parseInt(packedNumber, 16) % OpenSslErrorEncoding.REASON_BASE;
  const alertNumber = reasonNumber - OpenSslErrorEncoding.ALERT_REASON_OFFSET;
  return TlsErrorNumbersSchema.parse({
    socketTlsErrorNumber: packedNumber.toUpperCase(),
    socketTlsReasonNumber: reasonNumber,
    socketTlsAlertNumber:
      alertNumber >= 0 && alertNumber <= OpenSslErrorEncoding.MAXIMUM_ALERT_NUMBER
        ? alertNumber
        : null,
  });
}
