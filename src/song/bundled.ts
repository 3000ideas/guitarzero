/**
 * Songs that ship WITH their audio. They are installed into the user's own library (editable, all
 * the editor tools work) the first time the app runs, and the audio file is downloaded from the
 * site into the audio store. Unlike `examples.ts` (read-only, no audio) these are ordinary user
 * songs: once installed the user can edit or delete them, and a deleted one is not brought back.
 * If the browser loses the audio (cleared site data) it is downloaded again while the song exists.
 */
import type { AudioTrackInfo, StoredSong } from '../types';
import { getFlag, getSong, saveSong, setFlag } from './storage';
import { getTrack, putTrack } from './audioStore';

export interface BundledSong {
  id: string;
  title: string;
  artist: string;
  source: string;
  /** File under `public/audio/`. */
  file: string;
  /** Bump when the song text or the audio changes: a new version is installed once more. */
  version: number;
  audio: AudioTrackInfo;
}

const SODOMA_ACUSTICA = `title: Sodoma (acústica)
artist: Canción personal
tempo: 69
time: 4/4
strum: D-D-D-D-

# Acordes detectados automáticamente en la grabación: revisa y corrige (confianza baja).
# Tonalidad: La mayor. Abre «Comprobar» para ver cada compás con la onda del audio.

[Estrofa]
D . . . |
[Puente]
D . . E | D . . . | D . . . | A . . . |
D . . . | A . . . | D . . . | F#m . . . |
E . . . | D . . . | D . F#m . | F#m . E . |
D . F#m . | F#m . E . | D . E . | F#m . . . |
Bm . A . | D . . . | F#m . D . | A . E . |
F#m . D . | A . E . | D . . . | A . . . |
D . . . | D A . . | D . . . |
[Parte C]
F#m . . . | E . . . | E . . . | D . F#m . |
A . E . | D . F#m . | A . E . | D . E . |
F#m . A . | A . . . | D . . . | F#m . A . |
A . E . | E A . . | A . . . | D . . . |
[Parte D]
D . . . | E . . . | F#m . . . | D . . . |
A . . . | E . . . |
[Parte E]
E . . . | D . F#m . | A . E . | D . F#m . |
A . E . | D . E . | F#m . A . | Bm . . . |
[Estrofa]
D . . . | D . . E | D . . . | D . . . |
D . . . | D . . . |
`;

export const BUNDLED_SONGS: readonly BundledSong[] = [
  {
    id: 'sodoma-acustica',
    title: 'Sodoma (acústica)',
    artist: 'Canción personal',
    source: SODOMA_ACUSTICA,
    file: 'sodoma-acustica.mp3',
    version: 1,
    audio: {
      name: 'Sodoma-acustica-guitarra.mp3',
      type: 'audio/mpeg',
      size: 4981533,
      durationSec: 225.97,
      offsetSec: 3.275, // start of bar 1 in the recording (from the chord analysis)
      gain: 0.8,
    },
  },
];

const flagName = (b: BundledSong): string => `bundled:${b.id}:v${b.version}`;

/** Where the audio files are served from (`public/audio`, relative to the page so it works under /guitarzero/). */
export function bundledAudioUrl(file: string, base: string = import.meta.env.BASE_URL ?? './'): string {
  return `${base}audio/${file}`;
}

/**
 * Creates the library entries that are still missing (synchronous: they show up on the first
 * render). Returns the songs whose audio still has to be downloaded.
 */
export function installBundledEntries(songs: readonly BundledSong[] = BUNDLED_SONGS): BundledSong[] {
  const pending: BundledSong[] = [];
  for (const b of songs) {
    const existing = getSong(b.id);
    if (!existing) {
      if (getFlag(flagName(b))) continue; // installed before and then deleted by the user: leave it deleted
      const entry: StoredSong = { id: b.id, title: b.title, artist: b.artist, source: b.source, updatedAt: 0, audio: { ...b.audio } };
      saveSong(entry);
      setFlag(flagName(b)); // remembered, so deleting the song later keeps it deleted
    }
    pending.push(b);
  }
  return pending;
}

/** Downloads the audio of every bundled song that exists but has no audio in the store. Never throws. */
export async function downloadBundledAudio(songs: readonly BundledSong[], fetchFn: typeof fetch = fetch): Promise<void> {
  for (const b of songs) {
    try {
      if ((await getTrack(b.id)) !== null) continue;
      const res = await fetchFn(bundledAudioUrl(b.file));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await putTrack(b.id, blob, { name: b.audio.name, type: b.audio.type, size: blob.size });
    } catch (err) {
      console.warn(`No se pudo descargar el audio de «${b.title}» (se reintentará al abrir la app)`, err);
    }
  }
}

/** Boot step: library entries now, audio in the background. */
export function installBundledSongs(): Promise<void> {
  return downloadBundledAudio(installBundledEntries());
}
