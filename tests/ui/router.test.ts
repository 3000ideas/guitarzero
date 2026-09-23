import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearStorage, saveSong } from '../../src/song/storage';

/**
 * main.ts statically imports the four screens. practice.ts and settings.ts are written by
 * other agents; until both exist this file skips itself instead of failing on the import.
 * (import.meta.glob is resolved by Vite at transform time, so no node:fs is needed.)
 */
const screenModules = import.meta.glob('../../src/ui/screens/*.ts');
const SCREENS_READY = '../../src/ui/screens/practice.ts' in screenModules && '../../src/ui/screens/settings.ts' in screenModules;

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

describe.skipIf(!SCREENS_READY)('router (main.ts)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    clearStorage();
  });
  afterEach(() => {
    clearStorage();
    vi.unstubAllGlobals();
  });

  async function loadMain() {
    return import('../../src/main');
  }

  it('parses the four routes and ignores decoration', async () => {
    const { parseRoute } = await loadMain();
    expect(parseRoute('')).toEqual({ name: 'library', params: {} });
    expect(parseRoute('#')).toEqual({ name: 'library', params: {} });
    expect(parseRoute('#/')).toEqual({ name: 'library', params: {} });
    expect(parseRoute('#//')).toEqual({ name: 'library', params: {} });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings', params: {} });
    expect(parseRoute('#/settings/')).toEqual({ name: 'settings', params: {} });
    expect(parseRoute('#/settings?x=1')).toEqual({ name: 'settings', params: {} });
    expect(parseRoute('#/edit/s_abc123')).toEqual({ name: 'editor', params: { id: 's_abc123' } });
    expect(parseRoute('#/play/ex:pop-c-g-am-f')).toEqual({ name: 'practice', params: { id: 'ex:pop-c-g-am-f' } });
    expect(parseRoute('#/play/ex%3Apop-c-g-am-f')).toEqual({ name: 'practice', params: { id: 'ex:pop-c-g-am-f' } });
    expect(parseRoute('/play/ex:la-bamba')).toEqual({ name: 'practice', params: { id: 'ex:la-bamba' } });
  });

  it('rejects unknown routes and invalid ids', async () => {
    const { parseRoute } = await loadMain();
    expect(parseRoute('#/nope')).toBeNull();
    expect(parseRoute('#/edit')).toBeNull();
    expect(parseRoute('#/edit/')).toBeNull();
    expect(parseRoute('#/edit/Bad Id')).toBeNull();
    expect(parseRoute('#/edit/UPPER')).toBeNull();
    expect(parseRoute('#/play/a/b')).toBeNull();
    expect(parseRoute('#/settings/extra')).toBeNull();
    expect(parseRoute('#settings')).toBeNull();
    expect(parseRoute('#/edit/../x')).toBeNull();
  });

  it('routeIsAvailable requires an existing song for editor/practice', async () => {
    const { routeIsAvailable } = await loadMain();
    expect(routeIsAvailable({ name: 'library', params: {} })).toBe(true);
    expect(routeIsAvailable({ name: 'settings', params: {} })).toBe(true);
    expect(routeIsAvailable({ name: 'practice', params: { id: 'ex:pop-c-g-am-f' } })).toBe(true);
    expect(routeIsAvailable({ name: 'editor', params: { id: 's_missing' } })).toBe(false);
    saveSong({ id: 's_mine', title: 'Mía', artist: '', source: 'tempo: 80\nC . . . |', updatedAt: 0 });
    expect(routeIsAvailable({ name: 'editor', params: { id: 's_mine' } })).toBe(true);
    expect(routeIsAvailable({ name: 'practice', params: { id: 's_mine' } })).toBe(true);
    expect(routeIsAvailable({ name: 'editor', params: {} })).toBe(false);
  });

  it('gives each route a Spanish document title and exposes the home hash', async () => {
    const { titleForRoute, HOME_HASH, APP_NAME } = await loadMain();
    expect(HOME_HASH).toBe('#/');
    expect(titleForRoute({ name: 'library', params: {} })).toContain('Biblioteca');
    expect(titleForRoute({ name: 'editor', params: { id: 'x' } })).toContain('Editor');
    expect(titleForRoute({ name: 'practice', params: { id: 'x' } })).toContain('Practicar');
    expect(titleForRoute({ name: 'settings', params: {} })).toContain('Ajustes');
    for (const name of ['library', 'editor', 'practice', 'settings'] as const) {
      expect(titleForRoute({ name, params: {} })).toContain(APP_NAME);
    }
  });
});
