/** Standalone surfaces and older preload bridges can render without the optional student API. */
export function canUseStudentAccess(): boolean {
  const bridge: unknown = Reflect.get(window, 'tro');
  return (
    typeof bridge === 'object' &&
    bridge !== null &&
    'controlStudentAccess' in bridge &&
    typeof bridge.controlStudentAccess === 'function'
  );
}
