import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAGS_KEY,
  ID_RE,
  NEW_SONG_TEMPLATE,
  QUICK_PROGRESSION_TEMPLATE,
  SETTINGS_KEY,
  SONGS_KEY,
  STORAGE_VERSION,
  clampSettings,
  clearStorage,
  deleteSong,
  duplicateSong,
  getFlag,
  getSong,
  hasFlag,
  isValidId,
  listSongs,
  loadSettings,
  mergeSettings,
  newId,
  newSong,
  saveSettings,
  saveSong,
  setFlag,
  withSourceTitle,
} from '../../src/song/storage';
import { EXAMPLE_SONGS } from '../../src/song/examples';
import { parseSong } from '../../src/song/parser';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { Settings, StoredSong } from '../../src/types';

// ---------------------------------------------------------------- localStorage shim

/** Minimal in-memory localStorage for Node. */
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

/** A localStorage whose every method throws (storage disabled / quota exceeded). */
class BrokenStorage {
  get length(): number {
    return 0;
  }
  clear(): void {
    throw new Error('SecurityError');
  }
  getItem(_key: string): string | null {
    throw new Error('SecurityError');
  }
  key(_i: number): string | null {
    return null;
  }
  removeItem(_key: string): void {
    throw new Error('SecurityError');
  }
  setItem(_key: string, _value: string): void {
    throw new Error('QuotaExceededError');
  }
}

function installShim(): MemoryStorage {
  const shim = new MemoryStorage();
  vi.stubGlobal('localStorage', shim);
  return shim;
}

const song = (id: string, title = `Song ${id}`, source = `title: ${title}\ntempo: 100\n\nC . . . | G . . . |`): StoredSong => ({
  id,
  title,
  artist: 'Yo',
  source,
  updatedAt: 0,
});

const rawSongs = (shim: MemoryStorage): unknown => JSON.parse(shim.getItem(SONGS_KEY) ?? 'null');

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllGlobals();
  clearStorage();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearStorage();
});

// ---------------------------------------------------------------- ids

describe('newId / isValidId', () => {
  it('produces s_<base36 timestamp><4 random chars> ids that the router accepts', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const id = newId();
    expect(id).toMatch(/^s_[0-9a-z]+[0-9a-z]{4}$/);
    expect(id.startsWith('s_' + (1_700_000_000_000).toString(36))).toBe(true);
    expect(id.length).toBe(2 + (1_700_000_000_000).toString(36).length + 4);
    expect(isValidId(id)).toBe(true);
    expect(ID_RE.test(id)).toBe(true);
    nowSpy.mockRestore();
  });

  it('is unique in practice', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newId());
    expect(ids.size).toBeGreaterThan(190);
  });

  it('isValidId follows [a-z0-9_:-]+', () => {
    expect(isValidId('ex:cielito-lindo')).toBe(true);
    expect(isValidId('s_abc_1')).toBe(true);
    expect(isValidId('')).toBe(false);
    expect(isValidId('Hello')).toBe(false);
    expect(isValidId('a b')).toBe(false);
    expect(isValidId('a/b')).toBe(false);
  });
});

// ---------------------------------------------------------------- songs (with localStorage)

describe('songs with a localStorage shim', () => {
  it('lists only the examples when nothing is stored', () => {
    installShim();
    const all = listSongs();
    expect(all.map((s) => s.id)).toEqual(EXAMPLE_SONGS.map((s) => s.id));
    expect(all.every((s) => s.builtin === true)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns copies of the examples (mutating them does not touch the catalogue)', () => {
    installShim();
    const first = listSongs()[0];
    first.title = 'changed';
    expect(EXAMPLE_SONGS[0].title).not.toBe('changed');
    expect(getSong(EXAMPLE_SONGS[0].id)).not.toBe(EXAMPLE_SONGS[0]);
    expect(getSong(EXAMPLE_SONGS[0].id)).toEqual(EXAMPLE_SONGS[0]);
  });

  it('round-trips a song through the versioned wrapper', () => {
    const shim = installShim();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const stored = saveSong(song('s_one', 'Uno'));
    expect(stored).toEqual({ id: 's_one', title: 'Uno', artist: 'Yo', source: song('s_one', 'Uno').source, updatedAt: 1234 });
    expect(rawSongs(shim)).toEqual({ version: STORAGE_VERSION, songs: [stored] });
    expect(getSong('s_one')).toEqual(stored);
    expect(getSong('s_one')).not.toBe(stored);
    expect(getSong('nope')).toBeNull();
    nowSpy.mockRestore();
  });

  it('saveSong replaces an existing id (no duplicates) and refreshes updatedAt', () => {
    installShim();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(10);
    saveSong(song('s_a', 'v1'));
    nowSpy.mockReturnValue(20);
    saveSong(song('s_a', 'v2'));
    const user = listSongs().filter((s) => !s.builtin);
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ id: 's_a', title: 'v2', updatedAt: 20 });
    nowSpy.mockRestore();
  });

  it('saveSong strips the builtin flag and ignores builtin / ex: songs', () => {
    const shim = installShim();
    const ex = EXAMPLE_SONGS[0];
    expect(saveSong({ ...ex })).toEqual(ex);
    expect(saveSong({ ...song('s_x'), builtin: true })).toMatchObject({ id: 's_x', builtin: true });
    expect(saveSong({ ...ex, builtin: undefined })).toMatchObject({ id: ex.id });
    expect(shim.getItem(SONGS_KEY)).toBeNull();
    expect(listSongs().filter((s) => !s.builtin)).toEqual([]);
  });

  it('listSongs orders user songs by updatedAt desc after the examples', () => {
    installShim();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(100);
    saveSong(song('s_old'));
    nowSpy.mockReturnValue(300);
    saveSong(song('s_new'));
    nowSpy.mockReturnValue(200);
    saveSong(song('s_mid'));
    const ids = listSongs().map((s) => s.id);
    expect(ids.slice(0, EXAMPLE_SONGS.length)).toEqual(EXAMPLE_SONGS.map((s) => s.id));
    expect(ids.slice(EXAMPLE_SONGS.length)).toEqual(['s_new', 's_mid', 's_old']);
    nowSpy.mockRestore();
  });

  it('deleteSong removes user songs only', () => {
    const shim = installShim();
    saveSong(song('s_del'));
    saveSong(song('s_keep'));
    expect(deleteSong('s_del')).toBe(true);
    expect(getSong('s_del')).toBeNull();
    expect(getSong('s_keep')).not.toBeNull();
    expect(deleteSong('s_del')).toBe(false);
    expect(deleteSong(EXAMPLE_SONGS[0].id)).toBe(false);
    expect(getSong(EXAMPLE_SONGS[0].id)).not.toBeNull();
    expect((rawSongs(shim) as { songs: unknown[] }).songs).toHaveLength(1);
  });

  it('duplicateSong copies an example under a new id with " (copia)" in the title and the source', () => {
    installShim();
    const ex = EXAMPLE_SONGS[2];
    const copy = duplicateSong(ex.id);
    expect(copy.id).not.toBe(ex.id);
    expect(isValidId(copy.id)).toBe(true);
    expect(copy.id.startsWith('s_')).toBe(true);
    expect(copy.builtin).toBeUndefined();
    expect(copy.title).toBe(`${ex.title} (copia)`);
    expect(copy.artist).toBe(ex.artist);
    expect(getSong(copy.id)).toEqual(copy);
    const parsed = parseSong(copy.source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.song.title).toBe(copy.title);
    // the copy is the original with only its title header changed
    expect(copy.source.replace(/^title:.*$/m, '')).toBe(ex.source.replace(/^title:.*$/m, ''));
  });

  it('duplicateSong copies user songs and handles missing / untitled sources', () => {
    installShim();
    saveSong(song('s_u', 'Mía'));
    const copy = duplicateSong('s_u');
    expect(copy.title).toBe('Mía (copia)');
    expect(listSongs().filter((s) => !s.builtin)).toHaveLength(2);

    saveSong({ id: 's_notitle', title: '', artist: '', source: 'tempo: 90\nC . . . |', updatedAt: 0 });
    const copy2 = duplicateSong('s_notitle');
    expect(copy2.title).toBe('Sin título (copia)');
    expect(copy2.source.startsWith('title: Sin título (copia)\n')).toBe(true);
    expect(parseSong(copy2.source).song.title).toBe('Sin título (copia)');

    expect(() => duplicateSong('missing')).toThrow(/missing/);
  });

  it('withSourceTitle replaces the first title header (any case/indent) or prepends one', () => {
    expect(withSourceTitle('title: A\nartist: B\n', 'X')).toBe('title: X\nartist: B\n');
    expect(withSourceTitle('  Title :  A  # c\nC |', 'X')).toBe('  Title :  X\nC |');
    expect(withSourceTitle('tempo: 80\nC |', 'X')).toBe('title: X\ntempo: 80\nC |');
    expect(withSourceTitle('title: A\r\nC |', 'X $1')).toBe('title: X $1\r\nC |');
  });

  it('newSong persists a song from the default template', () => {
    installShim();
    const s = newSong();
    expect(s.source).toBe(NEW_SONG_TEMPLATE);
    expect(s.title).toBe('Nueva canción');
    expect(s.artist).toBe('');
    expect(isValidId(s.id)).toBe(true);
    expect(getSong(s.id)).toEqual(s);
    const r = parseSong(s.source);
    expect(r.errors).toEqual([]);
    expect(r.song.bars).toHaveLength(2);
  });

  it('newSong accepts a custom template (quick progression)', () => {
    installShim();
    const s = newSong(QUICK_PROGRESSION_TEMPLATE);
    expect(s.title).toBe('Progresión');
    const r = parseSong(s.source);
    expect(r.errors).toEqual([]);
    expect(r.song.chordNames).toEqual(['C', 'G', 'Am', 'F']);
    expect(getSong(s.id)).toEqual(s);
  });

  it('reads what another tab wrote (no stale in-memory copy)', () => {
    const shim = installShim();
    saveSong(song('s_mine'));
    const external = { ...song('s_other'), updatedAt: 5 };
    shim.setItem(SONGS_KEY, JSON.stringify({ version: STORAGE_VERSION, songs: [external] }));
    expect(getSong('s_mine')).toBeNull();
    expect(getSong('s_other')).toEqual(external);
  });
});

// ---------------------------------------------------------------- corrupted storage

describe('corrupted or foreign storage content', () => {
  it('invalid JSON -> console.warn and empty', () => {
    const shim = installShim();
    shim.setItem(SONGS_KEY, '{not json');
    expect(listSongs().filter((s) => !s.builtin)).toEqual([]);
    expect(getSong('s_x')).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain(SONGS_KEY);
  });

  it('a different version -> console.warn and empty', () => {
    const shim = installShim();
    shim.setItem(SONGS_KEY, JSON.stringify({ version: 2, songs: [song('s_v2')] }));
    expect(listSongs().filter((s) => !s.builtin)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a wrapper without the expected payload -> console.warn and empty', () => {
    const shim = installShim();
    shim.setItem(SONGS_KEY, JSON.stringify({ version: 1, songs: 'nope' }));
    expect(listSongs().filter((s) => !s.builtin)).toEqual([]);
    shim.setItem(SONGS_KEY, JSON.stringify([1, 2, 3]));
    expect(listSongs().filter((s) => !s.builtin)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('malformed entries and example ids inside the array are dropped, valid ones kept', () => {
    const shim = installShim();
    const good = { ...song('s_good'), updatedAt: 7 };
    shim.setItem(
      SONGS_KEY,
      JSON.stringify({
        version: 1,
        songs: [null, 42, { id: 's_bad' }, { ...song('ex:fake'), updatedAt: 1 }, { ...good, extra: 'field' }],
      }),
    );
    const user = listSongs().filter((s) => !s.builtin);
    expect(user).toEqual([good]);
    expect(warn).toHaveBeenCalled();
  });

  it('a corrupted songs key is overwritten by the next save', () => {
    const shim = installShim();
    shim.setItem(SONGS_KEY, 'garbage');
    saveSong(song('s_fresh'));
    expect(rawSongs(shim)).toMatchObject({ version: 1 });
    expect(getSong('s_fresh')).not.toBeNull();
  });
});

// ---------------------------------------------------------------- settings

describe('settings', () => {
  it('loadSettings returns the defaults (a fresh copy) when nothing is stored', () => {
    installShim();
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).not.toBe(DEFAULT_SETTINGS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('round-trips through the versioned wrapper', () => {
    const shim = installShim();
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      latencySec: 0.12,
      metronome: false,
      inputDeviceId: 'mic-1',
      tempoScale: 0.8,
      tuningOffset: -1,
    };
    expect(saveSettings(custom)).toEqual(custom);
    expect(JSON.parse(shim.getItem(SETTINGS_KEY)!)).toEqual({ version: STORAGE_VERSION, settings: custom });
    expect(loadSettings()).toEqual(custom);
  });

  it('merges a stored partial over the defaults and drops unknown keys', () => {
    const shim = installShim();
    shim.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: 1, settings: { latencySec: 0.2, listen: false, bogus: 1, theme: 'dark' } }),
    );
    const s = loadSettings();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, latencySec: 0.2, listen: false });
    expect('bogus' in s).toBe(false);
  });

  it('drops values of the wrong type or non-finite numbers', () => {
    const shim = installShim();
    shim.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        settings: { latencySec: '0.2', metronome: 'no', a4: null, inputDeviceId: 3, tempoScale: 'fast', gateDb: -40 },
      }),
    );
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, gateDb: -40 });
    expect(mergeSettings({ onsetThreshold: Number.NaN, lateSec: Number.POSITIVE_INFINITY })).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ inputDeviceId: null })).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ inputDeviceId: 'dev' }).inputDeviceId).toBe('dev');
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([1])).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps tempoScale, latencySec, earlySec, lateSec, a4 and tuningOffset', () => {
    const shim = installShim();
    shim.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        settings: { tempoScale: 5, latencySec: -1, earlySec: 2, lateSec: -3, a4: 1000, tuningOffset: -40 },
      }),
    );
    expect(loadSettings()).toMatchObject({
      tempoScale: 1.2,
      latencySec: -0.1,
      earlySec: 1,
      lateSec: 0,
      a4: 466,
      tuningOffset: -12,
    });
    shim.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        settings: { tempoScale: 0.1, latencySec: 9, earlySec: -1, lateSec: 7, a4: 100, tuningOffset: 99 },
      }),
    );
    expect(loadSettings()).toMatchObject({
      tempoScale: 0.5,
      latencySec: 0.5,
      earlySec: 0,
      lateSec: 1,
      a4: 415,
      tuningOffset: 12,
    });
    // values inside the range are untouched
    const inside = { ...DEFAULT_SETTINGS, tempoScale: 0.7, latencySec: 0.3, earlySec: 0.2, lateSec: 0.4, a4: 442, tuningOffset: -2 };
    expect(clampSettings(inside)).toEqual(inside);
    expect(clampSettings({ ...inside, tempoScale: 1.5 }).tempoScale).toBe(1.2);
  });

  it('saveSettings accepts a partial patch, clamps it and returns the effective settings', () => {
    installShim();
    saveSettings({ metronome: false });
    expect(loadSettings().metronome).toBe(false);
    const eff = saveSettings({ latencySec: 3 });
    expect(eff.latencySec).toBe(0.5);
    expect(eff.metronome).toBe(false);
    expect(loadSettings()).toEqual(eff);
  });

  it('invalid JSON or wrong version -> warn and defaults', () => {
    const shim = installShim();
    shim.setItem(SETTINGS_KEY, '<<<');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    shim.setItem(SETTINGS_KEY, JSON.stringify({ version: 0, settings: { listen: false } }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    shim.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: 'x' }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------- flags

describe('flags', () => {
  it('getFlag is false by default, setFlag(name) sets true', () => {
    const shim = installShim();
    expect(getFlag('latencyCalibrated')).toBe(false);
    expect(hasFlag('latencyCalibrated')).toBe(false);
    setFlag('latencyCalibrated');
    expect(getFlag('latencyCalibrated')).toBe(true);
    expect(hasFlag('latencyCalibrated')).toBe(true);
    expect(JSON.parse(shim.getItem(FLAGS_KEY)!)).toEqual({ version: STORAGE_VERSION, flags: { latencyCalibrated: true } });
  });

  it('stores false explicitly (distinguishable from "never set") and supports a fallback', () => {
    installShim();
    expect(getFlag('loop:s_1', true)).toBe(true);
    setFlag('loop:s_1', false);
    expect(getFlag('loop:s_1')).toBe(false);
    expect(getFlag('loop:s_1', true)).toBe(false);
    expect(hasFlag('loop:s_1')).toBe(true);
    setFlag('loop:s_1', true);
    expect(getFlag('loop:s_1')).toBe(true);
    expect(hasFlag('loop:s_2')).toBe(false);
  });

  it('ignores corrupted flag storage and non-boolean values', () => {
    const shim = installShim();
    shim.setItem(FLAGS_KEY, 'oops');
    expect(getFlag('a')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    shim.setItem(FLAGS_KEY, JSON.stringify({ version: 1, flags: { a: 'yes', b: true } }));
    expect(getFlag('a')).toBe(false);
    expect(hasFlag('a')).toBe(false);
    expect(getFlag('b')).toBe(true);
  });
});

// ---------------------------------------------------------------- no localStorage / broken localStorage

describe('in-memory fallback', () => {
  it('works without any localStorage global (Node)', () => {
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe('undefined');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(42);
    const stored = saveSong(song('s_mem'));
    expect(getSong('s_mem')).toEqual(stored);
    expect(listSongs().filter((s) => !s.builtin)).toEqual([stored]);
    saveSettings({ a4: 442 });
    expect(loadSettings().a4).toBe(442);
    setFlag('f');
    expect(getFlag('f')).toBe(true);
    expect(deleteSong('s_mem')).toBe(true);
    expect(getSong('s_mem')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('clearStorage empties the in-memory copy', () => {
    saveSong(song('s_tmp'));
    setFlag('x');
    saveSettings({ listen: false });
    clearStorage();
    expect(getSong('s_tmp')).toBeNull();
    expect(getFlag('x')).toBe(false);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('clearStorage also removes the keys from localStorage', () => {
    const shim = installShim();
    saveSong(song('s_tmp'));
    setFlag('x');
    saveSettings({ listen: false });
    expect(shim.length).toBe(3);
    clearStorage();
    expect(shim.length).toBe(0);
  });

  it('falls back to memory (with a single warning) when localStorage throws', () => {
    vi.stubGlobal('localStorage', new BrokenStorage());
    const stored = saveSong(song('s_broken'));
    expect(getSong('s_broken')).toEqual(stored);
    saveSettings({ metronome: false });
    expect(loadSettings().metronome).toBe(false);
    setFlag('k');
    expect(getFlag('k')).toBe(true);
    expect(listSongs().filter((s) => !s.builtin)).toEqual([stored]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('localStorage');
  });

  it('keeps the in-memory copy when localStorage disappears after a write', () => {
    installShim();
    const stored = saveSong(song('s_keep'));
    vi.unstubAllGlobals();
    expect(getSong('s_keep')).toEqual(stored);
  });
});
