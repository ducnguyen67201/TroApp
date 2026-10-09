import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AtomicReportFile } from '../../../../src/desktop/main/classroom/AtomicReportFile.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createDestination(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroParentReport-'));
  directories.push(directory);
  const destination = join(directory, 'Report.html');
  await writeFile(destination, 'previous report');
  return destination;
}

it('replaces a destination only with a complete report and removes temporary files', async () => {
  const destination = await createDestination();
  expect(await new AtomicReportFile().save(destination, 'approved report', () => true)).toBe(true);
  expect(await readFile(destination, 'utf8')).toBe('approved report');
  expect(await readdir(directories[0] ?? '')).toEqual(['Report.html']);
});

it('preserves the old report when authority changes before commit', async () => {
  const destination = await createDestination();
  let checks = 0;
  expect(
    await new AtomicReportFile().save(destination, 'new report', () => {
      checks += 1;
      return checks === 1;
    }),
  ).toBe(false);
  expect(await readFile(destination, 'utf8')).toBe('previous report');
  expect(await readdir(directories[0] ?? '')).toEqual(['Report.html']);
});

it('does not truncate a destination when the parent directory cannot be written', async () => {
  const destination = await createDestination();
  expect(
    await new AtomicReportFile().save(join(destination, 'Report.html'), 'new report', () => true),
  ).toBe(false);
  expect(await readFile(destination, 'utf8')).toBe('previous report');
});
