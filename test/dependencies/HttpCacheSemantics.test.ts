import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const requireElectronBuilder = createRequire(require.resolve('electron-builder'));
const requireBuilder = createRequire(requireElectronBuilder.resolve('app-builder-lib'));
const requireDownloader = createRequire(requireBuilder.resolve('@electron/get'));
const requireGot = createRequire(requireDownloader.resolve('got'));
const requireCache = createRequire(requireGot.resolve('cacheable-request'));
const cachePolicyPath = requireCache.resolve('http-cache-semantics');

interface CacheCase {
  name: string;
  headers: Record<string, string>;
  shared: boolean;
  canReuse: boolean;
}

const cases: CacheCase[] = [
  {
    name: 'no-cache responses',
    headers: { 'cache-control': 'no-cache' },
    shared: true,
    canReuse: false,
  },
  {
    name: 'no-store responses',
    headers: { 'cache-control': 'no-store' },
    shared: true,
    canReuse: false,
  },
  {
    name: 'private responses in a shared cache',
    headers: { 'cache-control': 'private, max-age=60' },
    shared: true,
    canReuse: false,
  },
  {
    name: 'session cookies in a shared cache',
    headers: { 'set-cookie': 'session=one', 'cache-control': 'max-age=60' },
    shared: true,
    canReuse: false,
  },
  {
    name: 'wildcard vary responses',
    headers: { vary: '*', 'cache-control': 'max-age=60' },
    shared: true,
    canReuse: false,
  },
  {
    name: 'ordinary stale public responses',
    headers: { 'cache-control': 'public, max-age=0' },
    shared: true,
    canReuse: true,
  },
  {
    name: 'explicitly public cookie responses',
    headers: { 'cache-control': 'public, max-age=60', 'set-cookie': 'session=one' },
    shared: true,
    canReuse: true,
  },
  {
    name: 'private responses in a private cache',
    headers: { 'cache-control': 'private, max-age=60' },
    shared: false,
    canReuse: true,
  },
];

describe('downloader cache response restrictions', () => {
  it.each(cases)(
    'applies response policy to $name when the client allows stale data',
    ({ headers, shared, canReuse }) => {
      /* Exercise the actual transitive CommonJS package in Node, independently of Vitest transforms. */
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          `
      const CachePolicy = require(process.argv[1]);
      const request = { url: 'https://example.test/account', method: 'GET', headers: { host: 'example.test' } };
      const policy = new CachePolicy(request, { status: 200, headers: ${JSON.stringify(headers)} }, { shared: ${String(shared)} });
      console.log(policy.satisfiesWithoutRevalidation({ ...request, headers: { ...request.headers, 'cache-control': 'max-stale' } }));
    `,
          cachePolicyPath,
        ],
        { encoding: 'utf8', timeout: 5_000 },
      );
      expect(output.trim()).toBe(String(canReuse));
    },
  );
});
