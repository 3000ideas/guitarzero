/**
 * Learning levels: easier versions of a song, from "just the pulse" to the full chart, so it can be
 * learnt in passes the way a teacher would teach it: first feel the beat and sing over it, then play
 * very few chords with very few strums, then add chords and strums until it is the real song.
 *
 * Every level is a copy of the song text with the chords reduced to the N most used ones (the others
 * become the nearest of those, see music/simplify.ts) and one simple strum pattern for the whole song.
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
    strum: (b) => 'x-'.repeat(b),
  },
  {
    n: 2,
    title: 'Dos acordes, un golpe por compás',
    summary: 'Solo los dos acordes más usados y un golpe hacia abajo al empezar cada compás. Lo importante es cambiar a tiempo.',
    maxChords: 2,
    strum: oneDownPerBar,
  },
  {
    n: 3,
    title: 'Tres acordes, golpes en 1 y 3',
    summary: 'Tres acordes y dos golpes por compás (en el 1 y en el 3). Ya se nota el ritmo de la canción.',
    maxChords: 3,
    strum: downsOnOneAndThree,
  },
  {
    n: 4,
    title: 'Cuatro acordes, un golpe por tiempo',
    summary: 'Cuatro acordes y un golpe hacia abajo en cada tiempo. Casi la canción: solo faltan los acordes raros y el rasgueo con ↑.',
    maxChords: 4,
    strum: (b) => 'D-'.repeat(b),
  },
];

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
