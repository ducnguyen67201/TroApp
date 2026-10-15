import { describe, expect, it } from 'vitest';
import { validateWindowsCompanionExecutable } from '../../scripts/WindowsCompanionExecutable.js';

function createExecutable(machine: number, magic: number, subsystem: number): Buffer {
  const executable = Buffer.alloc(512);
  executable.write('MZ');
  executable.writeUInt32LE(128, 0x3c);
  executable.write('PE\0\0', 128);
  executable.writeUInt16LE(machine, 132);
  executable.writeUInt16LE(240, 148);
  executable.writeUInt16LE(magic, 152);
  executable.writeUInt16LE(subsystem, 220);
  return executable;
}

describe('Windows companion packaging', () => {
  it.each([
    { architecture: 'x64', machine: 0x8664, magic: 0x20b },
    { architecture: 'arm64', machine: 0xaa64, magic: 0x20b },
    { architecture: 'PE32', machine: 0x14c, magic: 0x10b },
  ])('accepts $architecture GUI executables', ({ machine, magic }) => {
    expect(() => {
      validateWindowsCompanionExecutable(createExecutable(machine, magic, 2));
    }).not.toThrow();
  });

  it('rejects a console executable even when its other headers are valid', () => {
    expect(() => {
      validateWindowsCompanionExecutable(createExecutable(0x8664, 0x20b, 3));
    }).toThrow('GUI-subsystem');
  });

  it.each([0, 63, 128, 151, 221, 391])('rejects a truncated executable of %i bytes', (length) => {
    const executable = createExecutable(0x8664, 0x20b, 2).subarray(0, length);
    expect(() => {
      validateWindowsCompanionExecutable(executable);
    }).toThrow('GUI-subsystem');
  });

  it.each([
    { offset: 0, value: 0 },
    { offset: 0x3c, value: 0xffff },
    { offset: 128, value: 0 },
    { offset: 148, value: 0 },
    { offset: 152, value: 0 },
  ])('rejects malformed headers at $offset', ({ offset, value }) => {
    const executable = createExecutable(0x8664, 0x20b, 2);
    executable.writeUInt16LE(value, offset);
    expect(() => {
      validateWindowsCompanionExecutable(executable);
    }).toThrow('GUI-subsystem');
  });
});
