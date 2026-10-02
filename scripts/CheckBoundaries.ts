import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve('.');
const failures: string[] = [];
const specialNames = new Set([
  'AGENTS.md',
  'README.md',
  'CODEX-NAVIGATION-GUIDE.md',
  'index.html',
  'vite-env.d.ts',
]);
const ignoredFolders = new Set([
  'node_modules',
  'generated',
  '.git',
  'out',
  'dist',
  'release',
  'migrations',
  '.tro-development',
]);

async function collectFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(folder, entry.name);

    if (entry.isDirectory() && !ignoredFolders.has(entry.name)) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

for (const file of await collectFiles(root)) {
  const fileName = basename(file);
  const filePath = relative(root, file).split(sep).join('/');
  const isConfig = fileName.includes('.config.') || specialNames.has(fileName);

  if (
    /\.(?:tsx?|md|css)$/.test(fileName) &&
    !isConfig &&
    !/^tsconfig.*\.json$/.test(fileName) &&
    !/^[A-Z][A-Za-z0-9]*(?:\.(?:test|integration|d))*\.(?:tsx?|md|css)$/.test(fileName)
  ) {
    failures.push(`${filePath}: use a PascalCase filename.`);
  }

  if (!/\.tsx?$/.test(fileName)) {
    continue;
  }

  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  function checkImport(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const importPath = specifier.startsWith('.')
        ? relative(root, resolve(file, '..', specifier))
            .split(sep)
            .join('/')
        : specifier;

      if (
        filePath.startsWith('src/desktop/') &&
        (importPath.startsWith('src/server/') || /prisma/.test(specifier))
      ) {
        failures.push(`${filePath}: desktop cannot import backend/database implementation.`);
      }

      if (
        (filePath.startsWith('src/desktop/renderer/') ||
          filePath.startsWith('src/desktop/preload/')) &&
        importPath.startsWith('src/desktop/main/')
      ) {
        failures.push(`${filePath}: renderer/preload cannot import main-process implementation.`);
      }

      if (
        filePath.startsWith('src/contracts/') &&
        /^(?:src\/(?:server|desktop)\/|@prisma)/.test(importPath)
      ) {
        failures.push(`${filePath}: contracts cannot import application implementation.`);
      }

      if (
        filePath.startsWith('src/') &&
        !filePath.startsWith('src/server/persistence/') &&
        /(?:^@prisma|generated\/prisma)/.test(specifier)
      ) {
        failures.push(`${filePath}: Prisma belongs in persistence adapters.`);
      }

      if (
        filePath.includes('/domain/') &&
        /^(?:node:|fastify|zod|react|electron|@prisma)|\/persistence\//.test(importPath)
      ) {
        failures.push(`${filePath}: domain must be framework-free and I/O-free.`);
      }
    }

    ts.forEachChild(node, checkImport);
  }

  checkImport(source);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.info('Repository filenames and core import boundaries passed.');
}
