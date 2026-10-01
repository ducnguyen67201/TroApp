import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Rollup } from 'vite';
import { reportBuildWarning } from '../../scripts/ReportBuildWarning';

describe('development build warnings', () => {
  it.each([
    ['util.js', '// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes'],
    ['regexes.js', '/** Anchors a pattern source. The interpolation lives here'],
  ])('ignores only the known Zod comment in %s on either platform', (file, message) => {
    for (const separator of ['/', '\\']) {
      const handler = vi.fn();
      const id = `/repo/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/${file}`;
      reportBuildWarning(
        { code: 'INVALID_ANNOTATION', id: id.replaceAll('/', separator), message },
        handler,
      );
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it.each<Rollup.RollupLog>([
    { code: 'INVALID_ANNOTATION', message: '// Wrapped in a `@__PURE__` IIFE:' },
    {
      code: 'INVALID_ANNOTATION',
      id: '/repo/src/util.js',
      message: '// Wrapped in a `@__PURE__` IIFE:',
    },
    {
      code: 'INVALID_ANNOTATION',
      id: '/repo/node_modules/zod/v4/core/util.js',
      message: 'A different invalid pure annotation',
    },
    {
      code: 'CIRCULAR_DEPENDENCY',
      id: '/repo/node_modules/zod/v4/core/util.js',
      message: '// Wrapped in a `@__PURE__` IIFE:',
    },
  ])('forwards other warnings unchanged: $code $id', (warning) => {
    const handler = vi.fn();
    reportBuildWarning(warning, handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it('does not ask Node to load an env file during API development', () => {
    const packageSource = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    expect(packageSource).not.toContain('--env-file');
  });
});
