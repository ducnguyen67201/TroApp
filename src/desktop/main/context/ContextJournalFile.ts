import { open, type FileHandle } from 'node:fs/promises';
import { ContextLimits } from '#contracts/StudyContext.js';

const fileHeader = Buffer.from('TROJNL\x01\n', 'binary');
const frameLengthBytes = 4;
const frameOverheadBytes = frameLengthBytes * 2;

export const ContextJournalFileLimits = {
  HEADER_BYTES: fileHeader.byteLength,
  FRAME_OVERHEAD_BYTES: frameOverheadBytes,
  MAXIMUM_PAYLOAD_BYTES: ContextLimits.EVENT_BYTES + 1024,
  MAXIMUM_FILE_BYTES: ContextLimits.OUTBOX_BYTES,
  MAXIMUM_READ_FRAMES: 8192,
  MAXIMUM_RECOVERY_FRAMES: 8192,
} as const;

export interface ContextJournalFrameRange {
  start: number;
  end: number;
}

export interface ContextJournalFrame extends ContextJournalFrameRange {
  payload: Buffer;
}

export interface ContextJournalReadOptions {
  excludeRanges?: readonly ContextJournalFrameRange[];
  before?: number;
  minimumOffset?: number;
  limit: number;
  maxBytes: number;
}

export interface ContextJournalFramePage {
  /** Newest first; offsets include the prefix and suffix framing bytes. */
  frames: ContextJournalFrame[];
  omitted: boolean;
  truncatedTail: boolean;
  validEnd: number;
}

interface JournalBoundary {
  validEnd: number;
  truncatedTail: boolean;
}

const pendingAppends = new Map<string, Promise<void>>();

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function validateInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Invalid context journal boundary.');
  }
}

function validatePayloadLength(length: number): void {
  validateInteger(length, 1, ContextJournalFileLimits.MAXIMUM_PAYLOAD_BYTES);
}

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) {
      throw new Error('Context journal ended during a framed read.');
    }
    offset += bytesRead;
  }
  return buffer;
}

async function writeExact(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (!bytesWritten) {
      throw new Error('Context journal could not append a frame.');
    }
    offset += bytesWritten;
  }
}

async function validateHeader(file: FileHandle, size: number): Promise<void> {
  validateInteger(size, fileHeader.byteLength, ContextJournalFileLimits.MAXIMUM_FILE_BYTES);
  if (!(await readExact(file, fileHeader.byteLength, 0)).equals(fileHeader)) {
    throw new Error('Unsupported context journal format.');
  }
}

async function readFrameRangeAtEnd(
  file: FileHandle,
  end: number,
): Promise<ContextJournalFrameRange> {
  validateInteger(
    end,
    fileHeader.byteLength + frameOverheadBytes + 1,
    ContextJournalFileLimits.MAXIMUM_FILE_BYTES,
  );
  const suffix = await readExact(file, frameLengthBytes, end - frameLengthBytes);
  const length = suffix.readUInt32BE(0);
  validatePayloadLength(length);
  const start = end - length - frameOverheadBytes;
  validateInteger(start, fileHeader.byteLength, end - frameOverheadBytes - 1);
  const prefix = await readExact(file, frameLengthBytes, start);
  if (prefix.readUInt32BE(0) !== length) {
    throw new Error('Context journal frame lengths disagree.');
  }
  return { start, end };
}

/** Inspect only frame metadata during exceptional tail recovery. A complete corrupt
 * frame is rejected; only a trailing incomplete write can be removed by append. */
async function recoverJournalBoundary(file: FileHandle, size: number): Promise<JournalBoundary> {
  let position = fileHeader.byteLength;
  let inspected = 0;
  while (position < size) {
    if (++inspected > ContextJournalFileLimits.MAXIMUM_RECOVERY_FRAMES) {
      throw new Error('Context journal recovery exceeded its frame bound.');
    }
    if (size - position < frameLengthBytes) {
      return { validEnd: position, truncatedTail: true };
    }
    const prefix = await readExact(file, frameLengthBytes, position);
    const length = prefix.readUInt32BE(0);
    validatePayloadLength(length);
    const end = position + frameOverheadBytes + length;
    if (end > size) {
      return { validEnd: position, truncatedTail: true };
    }
    const suffix = await readExact(file, frameLengthBytes, end - frameLengthBytes);
    if (suffix.readUInt32BE(0) !== length) {
      throw new Error('Context journal contains a corrupt complete frame.');
    }
    position = end;
  }
  return { validEnd: position, truncatedTail: false };
}

async function readJournalBoundary(file: FileHandle, size: number): Promise<JournalBoundary> {
  await validateHeader(file, size);
  if (size === fileHeader.byteLength) {
    return { validEnd: size, truncatedTail: false };
  }
  try {
    await readFrameRangeAtEnd(file, size);
    return { validEnd: size, truncatedTail: false };
  } catch {
    return recoverJournalBoundary(file, size);
  }
}

async function openWritableJournal(path: string): Promise<FileHandle> {
  try {
    return await open(path, 'wx+', 0o600);
  } catch (error: unknown) {
    if (!isExistingFile(error)) {
      throw error;
    }
    return open(path, 'r+');
  }
}

async function appendFrame(path: string, payload: Buffer): Promise<ContextJournalFrameRange> {
  validatePayloadLength(payload.byteLength);
  const file = await openWritableJournal(path);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new Error('Context journal must be a regular file.');
    }
    let size = metadata.size;
    if (size < fileHeader.byteLength) {
      const partialHeader = await readExact(file, size, 0);
      if (!fileHeader.subarray(0, size).equals(partialHeader)) {
        throw new Error('Unsupported context journal format.');
      }
      await file.truncate(0);
      await writeExact(file, fileHeader, 0);
      size = fileHeader.byteLength;
    }
    const boundary = await readJournalBoundary(file, size);
    const start = boundary.validEnd;
    const end = start + frameOverheadBytes + payload.byteLength;
    validateInteger(end, fileHeader.byteLength, ContextJournalFileLimits.MAXIMUM_FILE_BYTES);
    if (boundary.truncatedTail) {
      await file.truncate(start);
    }
    const length = Buffer.alloc(frameLengthBytes);
    length.writeUInt32BE(payload.byteLength);
    await writeExact(file, Buffer.concat([length, payload, length]), start);
    await file.sync();
    return { start, end };
  } finally {
    await file.close();
  }
}

/** Append an already encrypted payload. Callers select the private local path and
 * own encryption, rotation, retention and account fencing. Calls in this process
 * serialize by path; no cross-process writer lease is provided. */
export async function appendJournalFrame(
  path: string,
  payload: Buffer,
): Promise<ContextJournalFrameRange> {
  validatePayloadLength(payload.byteLength);
  const immutablePayload = Buffer.from(payload);
  const previous = pendingAppends.get(path) ?? Promise.resolve();
  const result = previous.then(() => appendFrame(path, immutablePayload));
  const settled = result.then(
    () => {},
    () => {},
  );
  pendingAppends.set(path, settled);
  try {
    return await result;
  } finally {
    if (pendingAppends.get(path) === settled) {
      pendingAppends.delete(path);
    }
  }
}

function mergeExcludedRanges(
  ranges: readonly ContextJournalFrameRange[],
  validEnd: number,
): ContextJournalFrameRange[] {
  validateInteger(ranges.length, 0, ContextJournalFileLimits.MAXIMUM_READ_FRAMES);
  const merged: ContextJournalFrameRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    validateInteger(range.start, fileHeader.byteLength, validEnd);
    validateInteger(range.end, range.start + frameOverheadBytes + 1, validEnd);
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function skipExcludedRanges(
  position: number,
  minimum: number,
  ranges: readonly ContextJournalFrameRange[],
): number {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range && position > range.start && position <= range.end) {
      return Math.max(minimum, range.start);
    }
  }
  return position;
}

/** Read a bounded newest-first page by seeking frame boundaries, without loading
 * the whole log. An incomplete crash tail is omitted and explicitly reported. */
export async function readNewestJournalFrames(
  path: string,
  options: ContextJournalReadOptions,
): Promise<ContextJournalFramePage> {
  validateInteger(options.limit, 1, ContextJournalFileLimits.MAXIMUM_READ_FRAMES);
  validateInteger(options.maxBytes, 1, ContextJournalFileLimits.MAXIMUM_FILE_BYTES);
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    const boundary = await readJournalBoundary(file, metadata.size);
    const minimum = options.minimumOffset ?? fileHeader.byteLength;
    validateInteger(minimum, fileHeader.byteLength, boundary.validEnd);
    let position = options.before ?? boundary.validEnd;
    validateInteger(position, minimum, boundary.validEnd);
    const excluded = mergeExcludedRanges(options.excludeRanges ?? [], boundary.validEnd);
    const frames: ContextJournalFrame[] = [];
    let bytes = 0;
    position = skipExcludedRanges(position, minimum, excluded);
    while (position > minimum && frames.length < options.limit) {
      const range = await readFrameRangeAtEnd(file, position);
      if (range.start < minimum) {
        throw new Error('Context journal cursor splits a frame.');
      }
      const length = range.end - range.start - frameOverheadBytes;
      if (bytes + length > options.maxBytes) {
        break;
      }
      const payload = await readExact(file, length, range.start + frameLengthBytes);
      frames.push({ ...range, payload });
      bytes += length;
      position = skipExcludedRanges(range.start, minimum, excluded);
    }
    return {
      frames,
      omitted: position > minimum || boundary.truncatedTail,
      truncatedTail: boundary.truncatedTail,
      validEnd: boundary.validEnd,
    };
  } finally {
    await file.close();
  }
}

/** Read one immutable encrypted frame named by a frozen upload manifest. */
export async function readJournalFrame(path: string, start: number, end: number): Promise<Buffer> {
  validateInteger(start, fileHeader.byteLength, ContextJournalFileLimits.MAXIMUM_FILE_BYTES);
  validateInteger(end, start + frameOverheadBytes + 1, ContextJournalFileLimits.MAXIMUM_FILE_BYTES);
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    await validateHeader(file, metadata.size);
    if (end > metadata.size) {
      throw new Error('Context journal frame is unavailable.');
    }
    const range = await readFrameRangeAtEnd(file, end);
    if (range.start !== start) {
      throw new Error('Context journal range does not name one frame.');
    }
    return await readExact(file, end - start - frameOverheadBytes, start + frameLengthBytes);
  } finally {
    await file.close();
  }
}
