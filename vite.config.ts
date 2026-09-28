// 'vitest/config' (not 'vite') so that `tsc --noEmit` accepts the `test` key.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // allowedHosts: true is TEMPORARY, only for testing through a localtunnel/ngrok-style tunnel
  // (its Host header is a random subdomain Vite otherwise blocks) — revert once that's done.
  server: { port: 5173, host: true, allowedHosts: true },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
