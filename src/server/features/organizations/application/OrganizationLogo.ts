import { deflateSync, inflateSync } from 'node:zlib';
import {
  OrganizationLogoDataUrlSchema,
  OrganizationLogoLimits,
} from '#contracts/OrganizationLogo.js';
import { OrganizationFailure } from '#contracts/Organizations.js';
import { OrganizationError } from '../domain/OrganizationError.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngPrefix = 'data:image/png;base64,';

function calculatePngChecksum(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function encodePngChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(calculatePngChecksum(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function isSupportedPngHeader(data: Buffer): boolean {
  return (
    data.length === 13 &&
    data.readUInt32BE(0) === OrganizationLogoLimits.PIXELS &&
    data.readUInt32BE(4) === OrganizationLogoLimits.PIXELS &&
    data[8] === 8 &&
    (data[9] === 6 || data[9] === 2) &&
    data[10] === 0 &&
    data[11] === 0 &&
    data[12] === 0
  );
}

/** Bounded RGB/RGBA decoding checks uploads independently of the browser and strips metadata. */
export function validateAndFormatOrganizationLogo(dataUrl: string): string {
  try {
    const parsed = OrganizationLogoDataUrlSchema.parse(dataUrl);
    const base64 = parsed.slice(pngPrefix.length);
    const bytes = Buffer.from(base64, 'base64');
    if (
      bytes.length > OrganizationLogoLimits.PNG_BYTES ||
      bytes.toString('base64') !== base64 ||
      !bytes.subarray(0, 8).equals(pngSignature)
    ) {
      throw new Error('Invalid PNG encoding');
    }
    const compressed: Buffer[] = [];
    let header: Buffer | null = null;
    let hasEnded = false;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) {
        throw new Error('Truncated PNG');
      }
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, end - 4);
      if (
        calculatePngChecksum(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
      ) {
        throw new Error('Invalid PNG checksum');
      }
      if (type === 'IHDR') {
        if (header || offset !== 8 || !isSupportedPngHeader(data)) {
          throw new Error('Unsupported PNG dimensions or format');
        }
        header = data;
      } else if (type === 'IDAT' && header) {
        compressed.push(data);
      } else if (type === 'IEND' && header && length === 0 && end === bytes.length) {
        hasEnded = true;
        break;
      } else if (!header || !/^[a-z][A-Za-z]{3}$/.test(type)) {
        throw new Error('Unsupported PNG chunk');
      }
      offset = end;
    }
    if (!header || !hasEnded || compressed.length === 0) {
      throw new Error('Incomplete PNG');
    }
    const rowBytes = OrganizationLogoLimits.PIXELS * (header[9] === 6 ? 4 : 3) + 1;
    const expectedBytes = rowBytes * OrganizationLogoLimits.PIXELS;
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
    if (pixels.length !== expectedBytes) {
      throw new Error('Invalid PNG pixel length');
    }
    for (let row = 0; row < OrganizationLogoLimits.PIXELS; row += 1) {
      const filter = pixels[row * rowBytes];
      if (filter === undefined || filter > 4) {
        throw new Error('Invalid PNG row filter');
      }
    }
    const png = Buffer.concat([
      pngSignature,
      encodePngChunk('IHDR', header),
      encodePngChunk('IDAT', deflateSync(pixels)),
      encodePngChunk('IEND', Buffer.alloc(0)),
    ]);
    return `${pngPrefix}${png.toString('base64')}`;
  } catch {
    throw new OrganizationError(OrganizationFailure.INVALID);
  }
}
