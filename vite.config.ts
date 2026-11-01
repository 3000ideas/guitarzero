// 'vitest/config' (not 'vite') so that `tsc --noEmit` accepts the `test` key.
import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

function gitOut(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

// "v73 · 6b26c45 · 2026-11-01": commit count + short hash + build date. Shown in Ajustes and written
// to dist/version.json so an installed copy can check for a newer deploy.
const APP_VERSION = `v${gitOut('git rev-list --count HEAD', '0')} · ${gitOut('git rev-parse --short HEAD', 'local')} · ${new Date().toISOString().slice(0, 10)}`;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: APP_VERSION }) });
      },
    },
  ],
  // (its Host header is a random subdomain Vite otherwise blocks) — revert once that's done.
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
