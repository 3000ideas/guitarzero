/**
 * Persistence (SPEC.md section 8): songs, settings and flags in localStorage.
 *
 * Keys and formats:
 *  - `guitarzero.songs`    -> { version: 1, songs: StoredSong[] }        (user songs only)
 *  - `guitarzero.settings` -> { version: 1, settings: Partial<Settings> }
 *  - `guitarzero.flags`    -> { version: 1, flags: Record<string, boolean> }
 * A different version or invalid JSON is reported with `console.warn` and treated as empty.
 *
 * Every localStorage access is wrapped in try/catch. An in-memory copy mirrors what is written;
 * it becomes the store when localStorage is unavailable (Node, some privacy modes) or throws
 * (quota exceeded, storage disabled). Bundled examples (`ex:*`, builtin) are never persisted.
 *
 * A song's backing-track metadata (`StoredSong.audio`, SPEC section 11) is stored with the song;
 * the audio file itself lives in IndexedDB (song/audioStore.ts) and follows the song when it is
 * duplicated or deleted (fire-and-forget: those copies / deletions are not awaited).
 */
import { DEFAULT_SETTINGS } from '../types';
import type { AudioTrackInfo, Settings, StoredSong } from '../types';
import { copyTrack, deleteTrack } from './audioStore';
import { EXAMPLE_SONGS, isExampleId } from './examples';
import { parseSong } from './parser';

// ---------------------------------------------------------------- constants

export const SONGS_KEY = 'guitarzero.songs';
export const SETTINGS_KEY = 'guitarzero.settings';
export const FLAGS_KEY = 'guitarzero.flags';
export const STORAGE_VERSION = 1;

/** Ids accepted by the router (`#/edit/:id`, `#/play/:id`). */
export const ID_RE = /^[a-z0-9_:-]+$/;

/** Template used by "Nueva canción" in the library. */
export const NEW_SONG_TEMPLATE = 'title: Nueva canción\ntempo: 80\n\nC . . . | G . . . |';
/** Template used by "Progresión rápida" in the library. */
export const QUICK_PROGRESSION_TEMPLATE = 'title: Progresión\ntempo: 80\nstrum: D-DU-UDU\n\nC | G | Am | F |';

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

// ---------------------------------------------------------------- raw storage layer

/** In-memory mirror of everything written; the store itself when localStorage is unusable. */
const memory = new Map<string, string>();
/** Set once localStorage has thrown: from then on only the in-memory copy is used. */
let degraded = false;

function storageArea(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null;
  }
}

function degrade(err: unknown): void {
  if (degraded) return;
  degraded = true;
  console.warn('localStorage no disponible: los datos se guardan solo en memoria durante esta sesión', err);
}

function readRaw(key: string): string | null {
  if (!degraded) {
    const ls = storageArea();
    if (ls) {
      try {
        const value = ls.getItem(key);
        if (value === null) memory.delete(key);
        else memory.set(key, value);
        return value;
      } catch (err) {
        degrade(err);
      }
    }
  }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  if (degraded) return;
  const ls = storageArea();
  if (!ls) return;
  try {
    ls.setItem(key, value);
  } catch (err) {
    degrade(err);
  }
}

function removeRaw(key: string): void {
  memory.delete(key);
  if (degraded) return;
  const ls = storageArea();
  if (!ls) return;
  try {
    ls.removeItem(key);
  } catch (err) {
    degrade(err);
  }
}

/**
 * Removes every GuitarZero key (songs, settings, flags) from localStorage and from the in-memory
 * copy, and re-enables localStorage if it had failed. Used by tests and by a "reset" action.
 */
export function clearStorage(): void {
  degraded = false;
  for (const key of [SONGS_KEY, SETTINGS_KEY, FLAGS_KEY]) removeRaw(key);
  memory.clear();
}

// ---------------------------------------------------------------- versioned JSON wrappers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads `{ version: 1, <field>: ... }` from `key`. Missing key -> `null` (no warning);
 * invalid JSON, wrong version or a payload that fails `check` -> `console.warn` and `null`.
 */
function readWrapper(key: string, field: string, check: (v: unknown) => boolean): unknown {
  const raw = readRaw(key);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${key}: JSON inválido, se ignora el contenido guardado`);
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) {
    console.warn(`${key}: versión desconocida, se ignora el contenido guardado`);
    return null;
  }
  const payload = parsed[field];
  if (!check(payload)) {
    console.warn(`${key}: formato inesperado, se ignora el contenido guardado`);
    return null;
  }
  return payload;
}

function writeWrapper(key: string, field: string, payload: unknown): void {
  writeRaw(key, JSON.stringify({ version: STORAGE_VERSION, [field]: payload }));
}

// ---------------------------------------------------------------- songs

function isStoredSong(v: unknown): v is StoredSong {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.title === 'string' &&
    typeof v.artist === 'string' &&
    typeof v.source === 'string' &&
    typeof v.updatedAt === 'number' &&
    Number.isFinite(v.updatedAt)
  );
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isAudioInfo(v: unknown): v is AudioTrackInfo {
  return (
    isRecord(v) &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    isFiniteNumber(v.size) &&
    isFiniteNumber(v.durationSec) &&
    isFiniteNumber(v.offsetSec) &&
    isFiniteNumber(v.gain)
  );
}

/**
 * `audio` as it must be stored: a clean copy of a valid AudioTrackInfo, `null` (the track was
 * removed) or `undefined` (never set / malformed -> the key is omitted).
 */
function cleanAudio(audio: unknown): AudioTrackInfo | null | undefined {
  if (audio === null) return null;
  if (!isAudioInfo(audio)) return undefined;
  return {
    name: audio.name,
    type: audio.type,
    size: audio.size,
    durationSec: audio.durationSec,
    offsetSec: audio.offsetSec,
    gain: audio.gain,
  };
}

function cleanSong(s: StoredSong): StoredSong {
  const clean: StoredSong = { id: s.id, title: s.title, artist: s.artist, source: s.source, updatedAt: s.updatedAt };
  const audio = cleanAudio(s.audio);
  if (audio !== undefined) clean.audio = audio;
  return clean;
}

/** Logs a failed background copy / deletion of a track (never surfaces to the caller). */
function reportTrackError(what: string): (err: unknown) => void {
  return (err) => console.warn(`No se pudo ${what} la pista de audio`, err);
}

/** User songs as stored (unsorted). Malformed entries and example ids are dropped. */
function readUserSongs(): StoredSong[] {
  const payload = readWrapper(SONGS_KEY, 'songs', Array.isArray);
  if (!Array.isArray(payload)) return [];
  const songs: StoredSong[] = [];
  let dropped = 0;
  for (const entry of payload) {
    if (isStoredSong(entry) && !isExampleId(entry.id) && !entry.builtin) songs.push(cleanSong(entry));
    else dropped++;
  }
  if (dropped > 0) console.warn(`${SONGS_KEY}: se ignoran ${dropped} entradas no válidas`);
  return songs;
}

function writeUserSongs(songs: StoredSong[]): void {
  writeWrapper(SONGS_KEY, 'songs', songs.map(cleanSong));
}

function findExample(id: string): StoredSong | null {
  const ex = EXAMPLE_SONGS.find((s) => s.id === id);
  return ex ? { ...ex } : null;
}

/** Bundled examples first (in catalogue order), then the user's songs by `updatedAt` desc. */
export function listSongs(): StoredSong[] {
  const user = readUserSongs().sort((a, b) => b.updatedAt - a.updatedAt);
  return [...EXAMPLE_SONGS.map((s) => ({ ...s })), ...user];
}

export function getSong(id: string): StoredSong | null {
  return findExample(id) ?? readUserSongs().find((s) => s.id === id) ?? null;
}

/**
 * Inserts or replaces a user song, stamping `updatedAt = Date.now()`. Bundled examples
 * (`builtin` or an `ex:` id) are ignored and returned unchanged. `audio` is kept as given
 * (a copy of the metadata, or `null` to drop the track). When the caller omits `audio`
 * (undefined — e.g. the editor autosave, which only knows the text) the track metadata already
 * stored for that song is preserved. Returns the stored record.
 */
export function saveSong(song: StoredSong): StoredSong {
  if (song.builtin || isExampleId(song.id)) return song;
  const stored: StoredSong = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    source: song.source,
    updatedAt: Date.now(),
  };
  const songs = readUserSongs();
  const at = songs.findIndex((s) => s.id === stored.id);
  const audio = song.audio === undefined ? (at >= 0 ? songs[at].audio : undefined) : cleanAudio(song.audio);
  if (audio !== undefined) stored.audio = audio;
  if (at >= 0) songs[at] = stored;
  else songs.push(stored);
  writeUserSongs(songs);
  return stored;
}

/**
 * Removes a user song and (in the background) its audio track. Returns false when the id is
 * unknown or belongs to an example.
 */
export function deleteSong(id: string): boolean {
  if (isExampleId(id)) return false;
  const songs = readUserSongs();
  const remaining = songs.filter((s) => s.id !== id);
  if (remaining.length === songs.length) return false;
  writeUserSongs(remaining);
  void deleteTrack(id).catch(reportTrackError('eliminar'));
  return true;
}

const TITLE_HEADER_RE = /^([ \t]*title[ \t]*:[ \t]*)(.*)$/im;

/** Returns `source` with its `title:` header set to `title` (prepended when there is none). */
export function withSourceTitle(source: string, title: string): string {
  if (TITLE_HEADER_RE.test(source)) return source.replace(TITLE_HEADER_RE, (_m, prefix: string) => prefix + title);
  return `title: ${title}\n${source}`;
}

/**
 * Copies a song (example or user) under a new id with the title suffixed " (copia)"; the copy's
 * `title:` header is updated too, so the editor keeps the new title. The audio metadata is
 * copied and the audio file is copied in the background (copyTrack). Throws for unknown ids.
 */
export function duplicateSong(id: string): StoredSong {
  const original = getSong(id);
  if (!original) throw new Error(`No existe la canción "${id}"`);
  const title = `${original.title.trim() || 'Sin título'} (copia)`;
  const copy = saveSong({
    id: newId(),
    title,
    artist: original.artist,
    source: withSourceTitle(original.source, title),
    updatedAt: 0,
    audio: original.audio,
  });
  void copyTrack(id, copy.id).catch(reportTrackError('copiar'));
  return copy;
}

/** Creates and persists a new user song from `template` (default: NEW_SONG_TEMPLATE). */
export function newSong(template: string = NEW_SONG_TEMPLATE): StoredSong {
  const { song } = parseSong(template);
  return saveSong({ id: newId(), title: song.title, artist: song.artist, source: template, updatedAt: 0 });
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `s_<base36 timestamp><4 random [a-z0-9]>` — no crypto.randomUUID. */
export function newId(): string {
  let rand = '';
  for (let i = 0; i < 4; i++) rand += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `s_${Date.now().toString(36)}${rand}`;
}

// ---------------------------------------------------------------- settings

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Applies the value ranges of SPEC section 8 to a complete Settings object. */
export function clampSettings(s: Settings): Settings {
  return {
    ...s,
    tempoScale: clamp(s.tempoScale, 0.5, 1.2),
    latencySec: clamp(s.latencySec, -0.1, 0.5),
    earlySec: clamp(s.earlySec, 0, 1),
    lateSec: clamp(s.lateSec, 0, 1),
    a4: clamp(s.a4, 415, 466),
    tuningOffset: clamp(s.tuningOffset, -12, 12),
  };
}

/**
 * `{ ...DEFAULT_SETTINGS, ...pick(input, keys(DEFAULT_SETTINGS)) }` + clamps. Unknown keys and
 * values of the wrong type (or non-finite numbers) are dropped in favour of the default.
 */
export function mergeSettings(input: unknown): Settings {
  const picked: Record<string, unknown> = {};
  if (isRecord(input)) {
    for (const key of SETTINGS_KEYS) {
      if (!(key in input)) continue;
      const value = input[key];
      const def = DEFAULT_SETTINGS[key];
      if (key === 'inputDeviceId') {
        if (value === null || typeof value === 'string') picked[key] = value;
      } else if (key === 'backingSource') {
        if (value === 'audio' || value === 'chords') picked[key] = value;
      } else if (typeof def === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) picked[key] = value;
      } else if (typeof def === 'boolean') {
        if (typeof value === 'boolean') picked[key] = value;
      }
    }
  }
  return clampSettings({ ...DEFAULT_SETTINGS, ...(picked as Partial<Settings>) });
}

export function loadSettings(): Settings {
  return mergeSettings(readWrapper(SETTINGS_KEY, 'settings', isRecord));
}

/**
 * Persists settings. A partial patch is merged over the currently stored settings; the result
 * is clamped before writing and returned.
 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const merged = mergeSettings({ ...loadSettings(), ...patch });
  writeWrapper(SETTINGS_KEY, 'settings', merged);
  return merged;
}

// ---------------------------------------------------------------- flags

function readFlags(): Record<string, boolean> {
  const payload = readWrapper(FLAGS_KEY, 'flags', isRecord);
  const flags: Record<string, boolean> = {};
  if (isRecord(payload)) {
    for (const [name, value] of Object.entries(payload)) if (typeof value === 'boolean') flags[name] = value;
  }
  return flags;
}

/** True when the flag has been set (to either value). */
export function hasFlag(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(readFlags(), name);
}

/** The stored boolean, or `fallback` (default false) when the flag was never set. */
export function getFlag(name: string, fallback = false): boolean {
  const flags = readFlags();
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : fallback;
}

/** Stores a boolean flag, e.g. `latencyCalibrated` or `loop:<songId>`. `false` is stored, not removed. */
export function setFlag(name: string, value = true): void {
  const flags = readFlags();
  flags[name] = value;
  writeWrapper(FLAGS_KEY, 'flags', flags);
}
