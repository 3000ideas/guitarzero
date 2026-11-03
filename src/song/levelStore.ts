/**
 * Creating the copy of a song for a learning level (the storage side of song/levels.ts), shared by the
 * editor and the practice screen: the level copy is a normal song (`<base>-n<N>`) made from the FULL song
 * with the level's operation applied, with the same audio.
 */
import { LEVELS, buildLevelSource, levelSongId, parseLevelId, type LevelSpec } from './levels';
import { getSong, saveSong } from './storage';
import { copyTrack } from './audioStore';

export interface LevelFamily {
  /** Id of the full song the levels are made from. */
  baseId: string;
  /** Level of `id`: 0 for the full song, 1..4 for a level copy. */
  current: number;
}

/** The full song and the level of `id` (a level copy `<base>-n2` → base, 2; any other song is its own base, level 0). */
export function levelFamily(id: string): LevelFamily {
  const parsed = parseLevelId(id);
  return parsed ? { baseId: parsed.baseId, current: parsed.n } : { baseId: id, current: 0 };
}

/** Id of the song of a level (0 = the full song). */
export function levelSongIdOf(baseId: string, n: number): string {
  return n === 0 ? baseId : levelSongId(baseId, n);
}

export function levelExists(baseId: string, n: number): boolean {
  return getSong(levelSongIdOf(baseId, n)) !== null;
}

export interface LevelCreated {
  ok: boolean;
  /** Chords left in the level. */
  chords: string[];
  /** Spanish message when something went wrong (empty when ok). */
  message: string;
}

/** Writes (or rewrites) the copy of the FULL song for `level`, with the same audio. Never throws. */
export async function createLevelSong(baseId: string, level: LevelSpec): Promise<LevelCreated> {
  const baseSong = getSong(baseId);
  if (!baseSong) return { ok: false, chords: [], message: 'No encuentro la canción completa de la que partir.' };
  const baseTitle = (baseSong.title.trim() || 'Sin título').replace(/\s*·\s*Nivel \d.*$/, '');
  const title = `${baseTitle} · Nivel ${level.n}: ${level.title}`;
  const levelId = levelSongId(baseId, level.n);
  const { source, chords } = buildLevelSource(baseSong.source, level, title);
  saveSong({ id: levelId, title, artist: baseSong.artist, source, updatedAt: 0, audio: baseSong.audio ? { ...baseSong.audio } : null });
  if (baseSong.audio) {
    try {
      await copyTrack(baseId, levelId);
    } catch (err) {
      const why = err instanceof Error && err.message.trim() !== '' ? err.message : 'error desconocido';
      return { ok: false, chords, message: `Se creó el nivel, pero no se pudo copiar el audio: ${why}` };
    }
  }
  return { ok: true, chords, message: '' };
}

/** The level spec for `n` (1..4), or null. */
export function levelSpecOf(n: number): LevelSpec | null {
  return LEVELS.find((l) => l.n === n) ?? null;
}
