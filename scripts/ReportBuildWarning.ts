import type { Rollup } from 'vite';

/** Zod's explanatory comments mention a pure marker without applying one.
 * Rollup already removes those comments safely; retain every other warning. */
export function reportBuildWarning(
  warning: Rollup.RollupLog,
  defaultHandler: (warning: Rollup.RollupLog) => void,
): void {
  const id = warning.id?.replaceAll('\\', '/');
  const isKnownZodComment =
    warning.code === 'INVALID_ANNOTATION' &&
    ((id?.endsWith('/node_modules/zod/v4/core/util.js') &&
      warning.message.includes('// Wrapped in a `@__PURE__` IIFE:')) ||
      (id?.endsWith('/node_modules/zod/v4/core/regexes.js') &&
        warning.message.includes('/** Anchors a pattern source. The interpolation lives here')));

  if (!isKnownZodComment) {
    defaultHandler(warning);
  }
}
