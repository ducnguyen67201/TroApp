let users = 0;
/** Share the existing native hook between voice and lesson input. Each owner
 * removes its own listeners; the last owner stops the OS hook. */
export async function acquirePhysicalInputHook(): Promise<() => void> {
  const { uIOhook } = await import('uiohook-napi');
  if (users === 0) {
    uIOhook.start();
  }
  users += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    users -= 1;
    if (users === 0) {
      uIOhook.stop();
    }
  };
}
