/** Compares the actual application document; subframes, foreign origins, and paths are rejected. */
export function isTrustedFrameUrl(frameUrl: string, documentUrl: string): boolean {
  try {
    const frame = new URL(frameUrl);
    const document = new URL(documentUrl);
    frame.hash = '';
    document.hash = '';

    return frame.href === document.href;
  } catch {
    return false;
  }
}
