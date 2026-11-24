/**
 * «Versión fácil»: one automatic, always-playable version of a song, with no decisions to take.
 * The same operation on every song, over the bars of the full chart:
 *   1. sevenths, extensions and slash basses are dropped (Cmaj7 → C, G/B → G);
 *   2. ONE chord per bar: the chord that sounds longest in the bar fills it (a tie goes to the one
 *      that comes first), so chords only ever change on beat 1 (optionally also in the middle of the bar);
 *   3. a capo is proposed when it turns the chords into open shapes, hard chords become the nearest
 *      easy one and only the `maxChords` most used are kept (music/simplify.ts);
 *   4. one simple strum for the whole song (downs on beats 1 and 3; optionally only on 1, or on every beat).
 * Bars, sections, the tempo of every line and the audio are untouched, so the easy version lines up
 * with the recording exactly like the full song. Pure, testable in Node.
 */
import { reduceQuality, sameChordName, simplifyChart, transposeName } from '../music/simplify';
import { parseChordSymbol } from '../music/notes';
import type { Song } from '../types';
import { NC_CELL, REST_CELL, parseGrid, serializeGrid, setHeader } from './grid';
import { LEVELS } from './levels';
import { parseSong } from './parser';

/** How many strums per bar: one on beat 1, on beats 1 and 3, or one on every beat. */
export type EasyStrum = 'bar' | 'half' | 'beat';

export const EASY_STRUMS: readonly EasyStrum[] = ['bar', 'half', 'beat'];
export const EASY_DEFAULT_MAX_CHORDS = 4;

export interface EasyOptions {
  /** Keep only this many chords (default 4). */
  maxChords: number;
  /** Strums per bar (default 'half': downs on beats 1 and 3). With two changes per bar it is at least 'half'. */
  strum: EasyStrum;
  /**
   * Where the chord may change: 1 = only on beat 1; 2 = also in the middle of the bar (beat 3 in 4/4).
   * Default 2: measured against a real recording, one chord per bar matched the audio on 61 % of the
   * beats, two changes per bar on 78 % (the full detected chart: 81 %), and one per bar sounded wrong.
   */
  changesPerBar: 1 | 2;
  /** Title of the easy version (default: the song's title + « (fácil)»). */
  title: string | null;
}

export const DEFAULT_EASY_OPTIONS: EasyOptions = { maxChords: EASY_DEFAULT_MAX_CHORDS, strum: 'half', changesPerBar: 2, title: null };

export interface EasyResult {
  /** The text of the easy version. */
  source: string;
  /** Capo fret to put on the guitar (0 = none). */
  capo: number;
  /** The chords to play, in order of appearance (as fingered, i.e. with the capo on). */
  chords: string[];
  /** Strum pattern written in the `strum:` header. */
  strum: string;
  /** Bars that had more than one chord and now have one. */
  mergedBars: number;
  /** Bars with a chord, in the whole song (repeats not expanded). */
  totalBars: number;
  /**
   * Beats that sound the same chord as the full song / beats with a chord (0..1). Dropping a seventh
   * or playing with a capo does not count as a change; merging or substituting a chord does.
   */
  sameBeatsRatio: number;
}

/** Id of the easy copy of `songId`. */
export function easySongId(songId: string): string {
  return `${songId}-facil`;
}

/** The song an easy copy was made from, or null for any other song. */
export function parseEasyId(id: string): string | null {
  const m = /^(.+)-facil$/.exec(id);
  return m ? m[1] : null;
}

/** The strum pattern of an easy version for a meter of `beats` beats per bar. */
export function easyStrumPattern(strum: EasyStrum, beats: number): string {
  // The same patterns as the learning levels 2, 3 and 4 (levels.ts), so both features agree.
  const n = strum === 'bar' ? 2 : strum === 'half' ? 3 : 4;
  const level = LEVELS.find((l) => l.n === n);
  return level ? level.strum(beats) : 'D' + '-'.repeat(Math.max(0, beats - 1));
}

const isSilence = (cell: string): boolean => cell === REST_CELL || cell === NC_CELL;

/**
 * Rewrites every bar so that it holds ONE chord: the one that sounds for most beats of the bar (a tie
 * goes to the first one). With `changesPerBar` 2, a bar of 4 (or 6) beats is treated as two halves, each
 * with its own chord, so the chord may also change in the middle of the bar (beat 3 in 4/4) and nowhere
 * else. Bars that are all rest / N.C. are left alone; lines the grid does not understand («raw») too.
 * The chord is always written at the start of the bar, even when it is the same as in the bar before,
 * so every bar says what to play.
 */
export function oneChordPerBar(source: string, changesPerBar: 1 | 2 = 1): { source: string; mergedBars: number; totalBars: number } {
  const chart = parseGrid(source);
  let carry: string | null = null;
  let mergedBars = 0;
  let totalBars = 0;
  /** The chord that fills most of `beats` (a tie goes to the first), or null when they are all silent. */
  const winnerOf = (beats: Array<string | null>): string | null => {
    const count = new Map<string, number>();
    let best: string | null = null;
    for (const name of beats) {
      if (name === null) continue;
      count.set(name, (count.get(name) ?? 0) + 1);
    }
    for (const [name, n] of count) if (best === null || n > (count.get(best) ?? 0)) best = name;
    return best;
  };
  for (const item of chart.items) {
    if (item.kind !== 'bars') continue;
    let touched = false;
    for (const bar of item.bars) {
      const n = bar.cells.length;
      const sounding: Array<string | null> = [];
      let cur: string | null = carry;
      for (const cell of bar.cells) {
        if (cell !== '') cur = cell;
        sounding.push(cur === null || isSilence(cur) ? null : cur);
      }
      carry = cur;
      const whole = winnerOf(sounding);
      if (whole === null) continue; // a silent bar stays silent
      totalBars++;
      const mid = changesPerBar === 2 && n >= 4 && n % 2 === 0 ? n / 2 : 0;
      const first = mid > 0 ? winnerOf(sounding.slice(0, mid)) ?? whole : whole;
      const second = mid > 0 ? winnerOf(sounding.slice(mid)) ?? whole : whole;
      const cells = bar.cells.map((_, i) => (i === 0 ? first : i === mid && mid > 0 && second !== first ? second : ''));
      if (new Set(sounding.filter((c) => c !== null)).size > new Set([first, second]).size) mergedBars++;
      if (cells.some((c, i) => c !== bar.cells[i])) {
        bar.cells = cells;
        touched = true;
      }
    }
    if (touched) item.orig = null;
  }
  return { source: serializeGrid(chart), mergedBars, totalBars };
}

/** The chord that sounds on every beat of the song (null: rest / N.C. / nothing yet), repeats expanded. */
function chordPerBeat(song: Song): Array<string | null> {
  const out: Array<string | null> = [];
  for (const bar of song.bars) {
    const n = Math.max(1, Math.round(bar.beats));
    const cells: Array<string | null> = Array.from({ length: n }, () => null);
    for (const held of bar.chords) {
      if (held.chord.quality === 'nc') continue;
      const from = Math.max(0, Math.round(held.startBeat - bar.startBeat));
      const to = Math.min(n, Math.round(held.startBeat - bar.startBeat + held.beats));
      for (let i = from; i < to; i++) cells[i] = held.chord.name;
    }
    out.push(...cells);
  }
  return out;
}

function reducedName(name: string): string {
  const sym = parseChordSymbol(name);
  return sym && sym.quality !== 'nc' ? reduceQuality(sym).name : name;
}

/** Share of the beats with a chord of `full` that sound the same chord in `easy` (capo-aware, sevenths ignored). */
export function sameBeatsRatio(full: Song, easy: Song): number {
  const a = chordPerBeat(full);
  const b = chordPerBeat(easy);
  const shift = easy.capo - full.capo; // an easy shape + its capo sounds `shift` semitones above its name
  let total = 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    const want = a[i];
    if (want === null) continue;
    total++;
    const got = b[i] ?? null;
    if (got !== null && sameChordName(reducedName(want), shift === 0 ? got : transposeName(got, shift))) same++;
  }
  return total > 0 ? same / total : 1;
}

/** The easy version of `source` (see the top of the file). Never throws: a song without chords comes back as it is, with the simple strum. */
export function buildEasySource(source: string, options: Partial<EasyOptions> = {}): EasyResult {
  const opts: EasyOptions = { ...DEFAULT_EASY_OPTIONS, ...options };
  const full = parseSong(source).song;
  const beats = full.timeSignature.beatsPerBar;

  // (1) plain majors and minors first, so «D . D7 .» counts as one chord when the bars are merged.
  const plain = simplifyChart(source, { removeExtensions: true, substituteHard: false, suggestCapo: false, allowSevenths: false, maxChords: null });
  // (2) one chord per bar.
  const merged = oneChordPerBar(plain.source, opts.changesPerBar);
  // (3) capo, easy shapes and the few most used chords (counted on the merged bars: what is really played).
  const maxChords = Math.max(1, Math.floor(opts.maxChords));
  const simple = simplifyChart(merged.source, { removeExtensions: true, substituteHard: true, suggestCapo: true, allowSevenths: false, maxChords });

  // (4) one strum for the whole song: later `strum:` lines (per section) are dropped.
  const chart = parseGrid(simple.source);
  const firstContent = chart.items.findIndex((it) => it.kind === 'section' || it.kind === 'bars' || it.kind === 'raw');
  chart.items = chart.items.filter((it, i) => !(it.kind === 'header' && it.key === 'strum' && firstContent >= 0 && i > firstContent));
  // A chord that starts in the middle of the bar needs a strum there, or it would never sound.
  const strum = easyStrumPattern(opts.changesPerBar === 2 && opts.strum === 'bar' ? 'half' : opts.strum, beats);
  setHeader(chart, 'strum', strum);
  setHeader(chart, 'title', opts.title ?? `${full.title.trim() !== '' ? full.title.trim() : 'Canción'} (fácil)`);
  const text = serializeGrid(chart);

  const easy = parseSong(text).song;
  return {
    source: text,
    capo: easy.capo,
    chords: easy.chordNames.slice(),
    strum,
    mergedBars: merged.mergedBars,
    totalBars: merged.totalBars,
    sameBeatsRatio: sameBeatsRatio(full, easy),
  };
}
