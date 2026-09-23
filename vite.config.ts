// 'vitest/config' (not 'vite') so that `tsc --noEmit` accepts the `test` key.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
