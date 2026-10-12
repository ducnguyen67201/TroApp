import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '#contracts': resolve('src/contracts') } },
  server: { host: '127.0.0.1', port: 4311, strictPort: true },
});
