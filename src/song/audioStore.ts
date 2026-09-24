/**
 * audioStore: the backing-track files, one per song, in IndexedDB (SPEC.md section 11).
 *
 * Database `guitarzero` (version 1), object store `tracks` keyed by `songId`, records
 * `{ songId, blob, name, type, size, addedAt }`. The song's metadata (AudioTrackInfo) lives next
 * to the song in localStorage (song/storage.ts); only the file itself is stored here, and it
 * never leaves the browser.
 *
 * Without IndexedDB (Node, some privacy modes) or when the database fails to open, the store
 * degrades to an in-memory Map for the session (`hasIndexedDb()` then reports false). Every
 * operation is async; failures reject with an Error carrying a Spanish, user-facing message.
 * Nothing here touches `indexedDB` at import time, so the module is safe to import from Node.
 */

export const AUDIO_DB_NAME = 'guitarzero';
export const AUDIO_DB_VERSION = 1;
export const TRACKS_STORE = 'tracks';

export interface TrackMeta {
  name: string;
  type: string;
  size: number;
}

/** Record stored under `songId` in the `tracks` object store. */
export interface StoredTrack extends TrackMeta {
  songId: string;
  blob: Blob;
  addedAt: number;
}

// ---------------------------------------------------------------- state

/** The store itself when IndexedDB is unusable (never used while the database works). */
const memory = new Map<string, StoredTrack>();
/** Set once opening the database has failed: from then on only the in-memory Map is used. */
let degraded = false;
/** The pending / resolved connection, shared by every operation. */
let opening: Promise<IDBDatabase | null> | null = null;

function factory(): IDBFactory | null {
  try {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return idb && typeof idb.open === 'function' ? idb : null;
  } catch {
    return null;
  }
}

/** True while IndexedDB is available and has not failed; false in Node and after a failed open. */
export function hasIndexedDb(): boolean {
  return !degraded && factory() !== null;
}

function degrade(err: unknown): void {
  if (degraded) return;
  degraded = true;
  console.warn('IndexedDB no disponible: las pistas de audio solo se guardan en memoria durante esta sesión', err);
}

function doOpen(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) db.createObjectStore(TRACKS_STORE, { keyPath: 'songId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** The shared connection, or null when the in-memory fallback must be used. Never rejects. */
function openDb(): Promise<IDBDatabase | null> {
  if (degraded) return Promise.resolve(null);
  if (opening) return opening;
  const idb = factory();
  if (!idb) return Promise.resolve(null); // no IndexedDB at all (Node): silent fallback, nothing to warn about
  const p: Promise<IDBDatabase | null> = doOpen(idb).then(
    (db) => {
      // A closed connection (site data cleared, a newer version elsewhere) is reopened on the next call.
      const release = (): void => {
        if (opening === p) opening = null;
      };
      db.onversionchange = () => {
        db.close();
        release();
      };
      db.onclose = release;
      return db;
    },
    (err: unknown) => {
      degrade(err);
      return null;
    },
  );
  opening = p;
  return p;
}

// ---------------------------------------------------------------- IDB helpers

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
}

function fail(message: string, cause: unknown): Error {
  const text =
    errorName(cause) === 'QuotaExceededError'
      ? 'No hay espacio suficiente en el navegador para guardar la pista de audio'
      : message;
  return new Error(text, { cause });
}

/**
 * Runs `body` against the `tracks` store inside one transaction and resolves with the value
 * handed to `done` once the transaction commits (so a write that is later aborted, e.g. by the
 * quota, rejects instead of resolving early on the request's success).
 */
function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  message: string,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(TRACKS_STORE, mode);
    } catch (err) {
      reject(fail(message, err));
      return;
    }
    let result: T | undefined;
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(fail(message, tx.error));
    tx.onabort = () => reject(fail(message, tx.error));
    try {
      body(tx.objectStore(TRACKS_STORE), (value) => {
        result = value;
      });
    } catch (err) {
      reject(fail(message, err));
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
    }
  });
}

function isTrack(v: unknown): v is StoredTrack {
  if (typeof v !== 'object' || v === null) return false;
  const blob = (v as { blob?: unknown }).blob;
  return typeof Blob !== 'undefined' ? blob instanceof Blob : typeof blob === 'object' && blob !== null;
}

// ---------------------------------------------------------------- API

/** Stores (or replaces) the audio file of `songId`. */
export async function putTrack(songId: string, blob: Blob, meta: TrackMeta): Promise<void> {
  const record: StoredTrack = { songId, blob, name: meta.name, type: meta.type, size: meta.size, addedAt: Date.now() };
  const db = await openDb();
  if (!db) {
    memory.set(songId, record);
    return;
  }
  await withStore<void>(db, 'readwrite', 'No se pudo guardar la pista de audio', (store) => {
    store.put(record);
  });
}

/** The audio file of `songId`, or null when the song has none. */
export async function getTrack(songId: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return memory.get(songId)?.blob ?? null;
  const record = await withStore<unknown>(db, 'readonly', 'No se pudo leer la pista de audio', (store, done) => {
    const req = store.get(songId);
    req.onsuccess = () => done(req.result);
  });
  return isTrack(record) ? record.blob : null;
}

/** Removes the audio file of `songId` (no error when there is none). */
export async function deleteTrack(songId: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.delete(songId);
    return;
  }
  await withStore<void>(db, 'readwrite', 'No se pudo eliminar la pista de audio', (store) => {
    store.delete(songId);
  });
}

/** Copies the audio file of `fromId` under `toId`. Resolves false when `fromId` has no track. */
export async function copyTrack(fromId: string, toId: string): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    const record = memory.get(fromId);
    if (!record) return false;
    memory.set(toId, { ...record, songId: toId, addedAt: Date.now() });
    return true;
  }
  return withStore<boolean>(db, 'readwrite', 'No se pudo copiar la pista de audio', (store, done) => {
    done(false);
    const req = store.get(fromId);
    req.onsuccess = () => {
      const record = req.result as unknown;
      if (!isTrack(record)) return;
      store.put({ ...record, songId: toId, addedAt: Date.now() } satisfies StoredTrack);
      done(true);
    };
  });
}
