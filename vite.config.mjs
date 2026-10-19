import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', allowedHosts: ['localhost'], hmr: false },
});
