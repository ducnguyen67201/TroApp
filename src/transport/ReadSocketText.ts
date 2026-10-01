import type { RawData } from 'ws';

/** ws may deliver text bytes as a buffer, ArrayBuffer, or buffer fragments.
 * Decode those representations explicitly before JSON boundary validation. */
export function readSocketText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return Buffer.concat(data).toString('utf8');
}
