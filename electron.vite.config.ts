import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    build: {
      externalizeDeps: false,
      lib: {
        entry: resolve('src/desktop/main/Main.ts'),
        formats: ['es'],
        fileName: () => 'Main.js',
      },
    },
  },
  preload: {
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    build: {
      externalizeDeps: false,
      lib: {
        entry: resolve('src/desktop/preload/Preload.ts'),
        formats: ['cjs'],
        fileName: () => 'Preload.cjs',
      },
    },
  },
  renderer: {
    root: resolve('src/desktop/renderer'),
    resolve: { alias: { '#contracts': resolve('src/contracts') } },
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: { rollupOptions: { input: resolve('src/desktop/renderer/index.html') } },
  },
});
