/**
 * Learning levels: easier versions of a song, from "just the pulse" to the full chart, so it can be
 * learnt in passes the way a teacher would teach it: first feel the beat and sing over it, then play
 * very few chords with very few strums, then add chords and strums until it is the real song.
 *
 * A level is an OPERATION on the bars of the full song, the same for every song:
 *   1. chords: kept as they are (they are not played: muted strikes);  strum: one muted strike on every beat;
 *   2. chords: only the 2 most used, every other chord becomes the nearest of those;  strum: one down on beat 1;
 *   3. chords: only the 3 most used (same rule);  strum: a down on beats 1 and 3;
 *   4. chords: only the 4 most used (same rule);  strum: a down on every beat.
 * The bars (how many, where the chords change), the sections, the tempo of every line and the audio are untouched.
 * The audio, its start and the tempo of every line stay the same, so the levels line up with the recording.
 */
import { simplifyChart } from '../music/simplify';
import { parseSong } from './parser';
import { parseGrid, serializeGrid, setHeader } from './grid';

export interface LevelSpec {
  n: number;
  /** Short name shown on the button and in the title of the copy. */
  title: string;
  /** What to practise at this level (Spanish, one or two sentences). */
  summary: string;
  /** Keep only this many chords (null = the chords as they are). */
  maxChords: number | null;
  /** What the level does to the CHORDS of every bar, in words. */
  chordsRule: string;
  /** Strum pattern for a meter of `beats` beats per bar (one character per beat or more; always valid). */
  strum: (beats: number) => string;
}

const oneDownPerBar = (b: number): string => 'D' + '-'.repeat(Math.max(0, b - 1));

/** Downs on beat 1 and on the middle of the bar: «1 y 3» in 4/4. */
const downsOnOneAndThree = (b: number): string => {
  if (b <= 2) return oneDownPerBar(b);
  const mid = b === 3 ? 2 : Math.floor(b / 2);
  return Array.from({ length: b }, (_, i) => (i === 0 || i === mid ? 'D' : '-')).join('');
};

export const LEVELS: readonly LevelSpec[] = [
  {
    n: 1,
    title: 'Solo el pulso',
    summary: 'Cuerdas apagadas y un golpe en cada tiempo. Sigue el compás y canta o tararea encima. Los acordes aún no importan.',
    maxChords: null,
    chordsRule: 'No se tocan (cuerdas apagadas), así que los acordes se dejan como están.',
    strum: (b) => 'x-'.repeat(b),
  },
  {
    n: 2,
    title: 'Dos acordes, un golpe por compás',
    summary: 'Solo los dos acordes más usados y un golpe hacia abajo al empezar cada compás. Lo importante es cambiar a tiempo.',
    maxChords: 2,
    chordsRule: 'Solo los 2 acordes que más suenan en la canción. Cada uno de los demás se cambia por el más parecido de esos 2.',
    strum: oneDownPerBar,
  },
  {
    n: 3,
    title: 'Tres acordes, golpes en 1 y 3',
    summary: 'Tres acordes y dos golpes por compás (en el 1 y en el 3). Ya se nota el ritmo de la canción.',
    maxChords: 3,
    chordsRule: 'Solo los 3 acordes que más suenan. Cada uno de los demás se cambia por el más parecido de esos 3.',
    strum: downsOnOneAndThree,
  },
  {
    n: 4,
    title: 'Cuatro acordes, un golpe por tiempo',
    summary: 'Cuatro acordes y un golpe hacia abajo en cada tiempo. Casi la canción: solo faltan los acordes raros y el rasgueo con ↑.',
    maxChords: 4,
    chordsRule: 'Solo los 4 acordes que más suenan. Cada uno de los demás se cambia por el más parecido de esos 4.',
    strum: (b) => 'D-'.repeat(b),
  },
];

/** The song a level copy was made from and its level (`<base>-n2` → base, 2), or null for a normal song. */
export function parseLevelId(id: string): { baseId: string; n: number } | null {
  const m = /^(.+)-n([1-9])$/.exec(id);
  return m && LEVELS.some((l) => l.n === Number(m[2])) ? { baseId: m[1], n: Number(m[2]) } : null;
}

/** Id of the copy of `songId` for a level. */
export function levelSongId(songId: string, n: number): string {
  return `${songId}-n${n}`;
}

export interface LevelResult {
  source: string;
  /** Chords left in the level, in order of appearance. */
  chords: string[];
}

/**
 * The text of `level` for `source`: chords reduced, one simple strum for the whole song (strum
 * changes in the middle of the song are dropped) and `title` as its title. Tempo, sections and bars
 * are untouched.
 */
export function buildLevelSource(source: string, level: LevelSpec, title: string): LevelResult {
  const beats = parseSong(source).song.timeSignature.beatsPerBar;
  let text = source;
  let chords = parseSong(source).song.chordNames;
  if (level.maxChords !== null) {
    const r = simplifyChart(text, { maxChords: level.maxChords, substituteHard: false, suggestCapo: false, removeExtensions: true, allowSevenths: false });
    text = r.source;
    chords = r.chordsAfter;
  }
  const chart = parseGrid(text);
  const firstContent = chart.items.findIndex((it) => it.kind === 'section' || it.kind === 'bars' || it.kind === 'raw');
  chart.items = chart.items.filter((it, i) => !(it.kind === 'header' && it.key === 'strum' && firstContent >= 0 && i > firstContent));
  setHeader(chart, 'strum', level.strum(beats));
  setHeader(chart, 'title', title);
  return { source: serializeGrid(chart), chords };
}

// ---------------------------------------------------------------- explaining the operation

export interface StrumBeat {
  /** 1-based beat of the bar. */
  beat: number;
  /** ↓ a down strum, ✕ a muted strike, · nothing (the chord keeps ringing). */
  symbol: '↓' | '✕' | '·';
}

/** The strum of a level as one symbol per beat of the bar (`beats` = beats per bar). */
export function strumBeats(level: LevelSpec, beats: number): StrumBeat[] {
  const pattern = level.strum(beats);
  const per = Math.max(1, Math.round(pattern.length / beats));
  return Array.from({ length: beats }, (_, i) => {
    const c = pattern[i * per];
    return { beat: i + 1, symbol: c === 'x' ? '✕' : c === 'D' ? '↓' : '·' };
  });
}

const listBeats = (nums: number[]): string => (nums.length === 1 ? `el tiempo ${nums[0]}` : `los tiempos ${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}`);

/** «Todos los golpes son…», in words, for the beats per bar of the song. */
export function strumRuleText(level: LevelSpec, beats: number): string {
  const row = strumBeats(level, beats);
  const hit = row.filter((b) => b.symbol !== '·');
  const kind = hit[0]?.symbol === '✕' ? 'un golpe apagado (✕)' : 'un golpe hacia abajo (↓)';
  const where = hit.length === beats ? `en cada tiempo (${listBeats(hit.map((b) => b.beat)).replace('los tiempos ', '')})` : `en ${listBeats(hit.map((b) => b.beat))}`;
  const rest = hit.length === beats ? '' : ' El resto del compás, el acorde sigue sonando.';
  return `Todos los golpes de la canción son ${kind} ${where} de cada compás.${rest}`;
}

export interface LevelPreview {
  /** Chords of the song before and after the level. */
  before: string[];
  after: string[];
  /** Each chord that changes and what it becomes. */
  changes: Array<{ from: string; to: string }>;
}

/** What the level does to THIS song's chords (without writing anything). */
export function levelPreview(source: string, level: LevelSpec): LevelPreview {
  const before = parseSong(source).song.chordNames;
  if (level.maxChords === null) return { before, after: before, changes: [] };
  const r = simplifyChart(source, { maxChords: level.maxChords, substituteHard: false, suggestCapo: false, removeExtensions: true, allowSevenths: false });
  return { before, after: r.chordsAfter, changes: r.substitutions.filter((x) => x.from !== x.to).map((x) => ({ from: x.from, to: x.to })) };
}
