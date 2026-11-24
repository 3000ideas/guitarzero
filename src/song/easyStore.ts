/**
 * Creating the «versión fácil» copy of a song (the storage side of song/easy.ts), in the same way as the
 * learning levels (levelStore.ts): the easy copy is a normal song (`<base>-facil`) made from the FULL song,
 * with the same audio, so every screen (Practicar, Seguir, the editor) works on it.
 */
import { buildEasySource, easySongId, parseEasyId, quietBeats, type EasyOptions, type EasyResult } from './easy';
import { parseSong } from './parser';
import { getSong, saveSong } from './storage';
import { copyTrack } from './audioStore';

/** The decoded recording of the song, to find where its guitar stops. */
export interface EasyAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface EasyCreated {
  ok: boolean;
  /** Id of the easy copy (empty when the song was not found). */
  id: string;
  /** What the easy version is: capo, chords, strum… (null when the song was not found). */
  result: EasyResult | null;
  /** Spanish message when something went wrong (empty when ok). */
  message: string;
}

/** The full song of `id`: an easy copy `<base>-facil` → base; any other song is its own base. */
export function easyBaseId(id: string): string {
  const base = parseEasyId(id);
  if (base === null) return id;
  // The easy copy of a bundled example is stored as `ex-…-facil`: its base is the example `ex:…`.
  if (getSong(base) === null && base.startsWith('ex-') && getSong(`ex:${base.slice(3)}`) !== null) return `ex:${base.slice(3)}`;
  return base;
}

/** Title of the easy copy of a song titled `title`. */
export function easyTitle(title: string): string {
  const base = (title.trim() || 'Sin título').replace(/\s*\(fácil\)\s*$/, '');
  return `${base} (fácil)`;
}

/**
 * Writes (or rewrites) the easy copy of the FULL song, with the same audio. With `audio` (the decoded
 * recording) the beats where the guitar stops become rests. Never throws.
 */
export async function createEasySong(songId: string, audio: EasyAudio | null = null, options: Partial<EasyOptions> = {}): Promise<EasyCreated> {
  const baseId = easyBaseId(songId);
  const baseSong = getSong(baseId);
  if (!baseSong) return { ok: false, id: '', result: null, message: 'No encuentro la canción de la que partir.' };
  const title = easyTitle(baseSong.title);
  const id = easySongId(baseId);
  let quiet: boolean[] | null = null;
  if (audio && baseSong.audio) {
    quiet = quietBeats(audio.samples, audio.sampleRate, parseSong(baseSong.source).song, baseSong.audio.offsetSec);
  }
  const result = buildEasySource(baseSong.source, { ...options, quiet, title });
  saveSong({ id, title, artist: baseSong.artist, source: result.source, updatedAt: 0, audio: baseSong.audio ? { ...baseSong.audio } : null });
  if (baseSong.audio) {
    try {
      await copyTrack(baseId, id);
    } catch (err) {
      const why = err instanceof Error && err.message.trim() !== '' ? err.message : 'error desconocido';
      return { ok: false, id, result, message: `Se creó la versión fácil, pero no se pudo copiar el audio: ${why}` };
    }
  }
  return { ok: true, id, result, message: '' };
}
