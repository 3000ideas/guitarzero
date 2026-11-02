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
  /** Earlier texts of this song: an installed copy that still has exactly one of them (the user never edited it) is upgraded. */
  legacy?: Array<{ source: string; offsetSec: number }>;
}

const SODOMA_ACUSTICA_V1 = `title: Sodoma (acústica)
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

/** v2: the first bar is the pick-up (the guitar starts on beat 2), and every line carries the tempo that follows the recording. */
const SODOMA_ACUSTICA = `title: Sodoma (acústica)
artist: Canción personal
tempo: 68.51
time: 4/4
strum: D-D-D-D-

# Acordes detectados automáticamente en la grabación: revisa y corrige (confianza baja).
# Tonalidad: La mayor. El compás 1 es la anacrusa: la guitarra entra en el pulso 2 (el audio empieza
# antes del primer tiempo fuerte). Cada línea lleva el tempo que sigue a la grabación.
# Abre «Comprobar» para ver cada compás con la onda del audio.

[Estrofa]
- D . . |
D . . . |
[Puente]
D . . E | D . . . | D . . . | A . . . |
D . . . | A . . . | D . . . | F#m . . . |
tempo: 68.36
E . . . | D . . . | D . F#m . | F#m . E . |
tempo: 68.56
D . F#m . | F#m . E . | D . E . | F#m . . . |
Bm . A . | D . . . | F#m . D . | A . E . |
F#m . D . | A . E . | D . . . | A . . . |
D . . . | D A . . | D . . . |
[Parte C]
F#m . . . | E . . . | E . . . | D . F#m . |
A . E . | D . F#m . | A . E . | D . E . |
F#m . A . | A . . . | D . . . | F#m . A . |
tempo: 68.37
A . E . | E A . . | A . . . | D . . . |
[Parte D]
tempo: 68.64
D . . . | E . . . | F#m . . . | D . . . |
A . . . | E . . . |
[Parte E]
tempo: 68.44
E . . . | D . F#m . | A . E . | D . F#m . |
A . E . | D . E . | F#m . A . | Bm . . . |
[Estrofa]
tempo: 68.15
D . . . | D . . E | D . . . | D . . . |
tempo: 91.22
D . . . | D . . . |
`;

export const BUNDLED_SONGS: readonly BundledSong[] = [
  {
    id: 'sodoma-acustica',
    title: 'Sodoma (acústica)',
    artist: 'Canción personal',
    source: SODOMA_ACUSTICA,
    file: 'sodoma-acustica.mp3',
    version: 2,
    legacy: [{ source: SODOMA_ACUSTICA_V1, offsetSec: 3.275 }],
    audio: {
      name: 'Sodoma-acustica-guitarra.mp3',
      type: 'audio/mpeg',
      size: 4981533,
      durationSec: 225.97,
      offsetSec: -0.228, // bar 1 is a pick-up bar that starts before the audio: the first downbeat (bar 2) is at 3.275 s
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
    if (existing && b.legacy?.some((l) => l.source === existing.source && existing.audio?.offsetSec === l.offsetSec)) {
      // Still the untouched earlier version: bring it to this one (an edited copy is never overwritten).
      saveSong({ ...existing, title: b.title, artist: b.artist, source: b.source, audio: { ...b.audio } });
      setFlag(flagName(b));
    }
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
