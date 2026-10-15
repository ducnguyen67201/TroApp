const dosHeaderSize = 64;
const peHeaderOffsetLocation = 0x3c;
const peSignature = 0x00004550;
const coffHeaderSize = 24;
const optionalHeaderSizeLocation = 20;
const subsystemOffset = 68;
const windowsGuiSubsystem = 2;

/** Reject console executables before bundling: the native SDK launches the
 * companion directly, so Windows must not allocate a terminal for it.
 * Reads PE32/PE32+ headers only; this does not verify signing or provenance. */
export function validateWindowsCompanionExecutable(executable: Buffer): void {
  const rejectExecutable = (): never => {
    throw new Error('Windows companion must be a GUI-subsystem executable. Run pnpm build:cua.');
  };

  if (executable.length < dosHeaderSize || executable.readUInt16LE(0) !== 0x5a4d) {
    rejectExecutable();
  }
  const peOffset = executable.readUInt32LE(peHeaderOffsetLocation);
  const optionalHeaderOffset = peOffset + coffHeaderSize;
  if (
    peOffset < dosHeaderSize ||
    optionalHeaderOffset + subsystemOffset + 2 > executable.length ||
    executable.readUInt32LE(peOffset) !== peSignature
  ) {
    rejectExecutable();
  }
  const optionalHeaderSize = executable.readUInt16LE(peOffset + optionalHeaderSizeLocation);
  const optionalHeaderMagic = executable.readUInt16LE(optionalHeaderOffset);
  if (
    optionalHeaderSize < subsystemOffset + 2 ||
    optionalHeaderOffset + optionalHeaderSize > executable.length ||
    (optionalHeaderMagic !== 0x10b && optionalHeaderMagic !== 0x20b) ||
    executable.readUInt16LE(optionalHeaderOffset + subsystemOffset) !== windowsGuiSubsystem
  ) {
    rejectExecutable();
  }
}
