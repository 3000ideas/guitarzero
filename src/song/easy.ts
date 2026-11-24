/**
 * «Versión fácil»: one automatic, always-playable version of a song, with no decisions to take.
 * The same operation on every song, over the bars of the full chart:
 *   1. sevenths, extensions and slash basses are dropped (Cmaj7 → C, G/B → G);
 *   2. ONE chord per bar: the chord that sounds longest in the bar fills it (a tie goes to the one
 *      that comes first), so chords only ever change on beat 1 (optionally also in the middle of the bar);
 *   3. a capo is proposed when it turns the chords into open shapes, hard chords become the nearest
 *      easy one and only the `maxChords` most used are kept (music/simplify.ts);
 *   4. one simple strum for the whole song (a down on every beat; optionally only on 1 and 3);
 *   5. optionally, rests on the beats where the recording goes quiet (`quietBeats` + `restQuietBeats`).
 * Bars, sections, the tempo of every line and the audio are untouched, so the easy version lines up
 * with the recording exactly like the full song. Pure, testable in Node.
 */
import { reduceQuality, sameChordName, simplifyChart, transposeName } from '../music/simplify';
import { parseChordSymbol } from '../music/notes';
import type { Song } from '../types';
import { NC_CELL, REST_CELL, parseGrid, serializeGrid, setHeader } from './grid';
import { LEVELS } from './levels';
import { parseSong } from './parser';
import { beatToSec } from './tempo';

/** How many strums per bar: one on beat 1, on beats 1 and 3, or one on every beat. */
export type EasyStrum = 'bar' | 'half' | 'beat';

export const EASY_STRUMS: readonly EasyStrum[] = ['bar', 'half', 'beat'];
/**
 * Five, not four: on a real recording the fifth chord (an easy one) fixed the two spots that sounded wrong
 * with four, and it is still a handful of open shapes.
 */
export const EASY_DEFAULT_MAX_CHORDS = 5;

export interface EasyOptions {
  /** Keep only this many chords (default 5). */
  maxChords: number;
  /**
   * Strums per bar (default 'beat': a down on every beat, which is what sounds right over a recording:
   * fewer strums felt out of time and empty). With two changes per bar it is at least 'half'.
   */
  strum: EasyStrum;
  /**
   * Where the chord may change: 1 = only on beat 1; 2 = also in the middle of the bar (beat 3 in 4/4).
   * Default 2: measured against a real recording, one chord per bar matched the audio on 61 % of the
   * beats, two changes per bar on 78 % (the full detected chart: 81 %), and one per bar sounded wrong.
   */
  changesPerBar: 1 | 2;
  /**
   * Per beat of the song: true where the recording goes quiet (see `quietBeats`). Those beats become rests,
   * so the easy version stops strumming where the guitar of the recording stops. null = no rests added.
   */
  quiet: boolean[] | null;
  /** Title of the easy version (default: the song's title + « (fácil)»). */
  title: string | null;
}

export const DEFAULT_EASY_OPTIONS: EasyOptions = { maxChords: EASY_DEFAULT_MAX_CHORDS, strum: 'beat', changesPerBar: 2, quiet: null, title: null };

export interface EasyResult {
  /** The text of the easy version. */
  source: string;
  /** Capo fret to put on the guitar (0 = none). */
  capo: number;
  /** The chords to play, in order of appearance (as fingered, i.e. with the capo on). */
  chords: string[];
  /** Strum pattern written in the `strum:` header. */
  strum: string;
  /** Beats turned into rests because the recording is quiet there. */
  rests: number;
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

/** A beat is «quiet» when its level is this many dB below the median beat of the song. */
export const QUIET_BEAT_DB = -12;

/** A beat has «no strike» when its strongest attack is below this share of the median beat's strongest attack. */
export const NO_STRIKE_RATIO = 0.3;
/** Hop of the attack curve, seconds. */
const ATTACK_HOP_SEC = 0.01;
/** A strike a little ahead of the beat still belongs to that beat. */
const ATTACK_LEAD_SEC = 0.03;

/**
 * Per beat of `song` (repeats expanded): true where the guitar of the recording is not being played.
 * Two signs, either is enough:
 *  - the beat is nearly silent (its level is `thresholdDb` below the median beat), or
 *  - nothing is struck during the beat and the one before or after is quiet too: the chord of before just
 *    rings on for two beats or more. The attack curve is the rise of the brightness of the sound (level of
 *    the sample-to-sample difference, in dB) every 10 ms; a strum makes it jump, a ringing chord does not.
 * `offsetSec` is the audio time of the song's beat 0 (the track's `offsetSec`). Beats outside the audio
 * are not quiet (nothing to compare with).
 */
export function quietBeats(samples: Float32Array, sampleRate: number, song: Song, offsetSec: number, thresholdDb = QUIET_BEAT_DB): boolean[] {
  const n = Math.max(0, Math.round(song.totalBeats));
  const hop = Math.max(1, Math.round(ATTACK_HOP_SEC * sampleRate));
  const frames = Math.floor(samples.length / hop);
  const bright = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let j = 1; j < hop; j++) {
      const d = samples[f * hop + j] - samples[f * hop + j - 1];
      sum += d * d;
    }
    bright[f] = Math.log(1e-9 + sum);
  }
  const attack = new Float32Array(frames);
  const before = (f: number): number => (f >= 0 ? bright[f] : Math.log(1e-9)); // silence before the audio starts
  for (let f = 0; f < frames; f++) attack[f] = Math.max(0, bright[f] - Math.max(before(f - 1), before(f - 2)));

  const level: Array<number | null> = [];
  const strike: Array<number | null> = [];
  for (let b = 0; b < n; b++) {
    const fromSec = beatToSec(song.tempoSegments, b) + offsetSec;
    const toSec = beatToSec(song.tempoSegments, b + 1) + offsetSec;
    const from = Math.round(fromSec * sampleRate);
    const to = Math.round(toSec * sampleRate);
    if (from < 0 || to > samples.length || to <= from) {
      level.push(null);
      strike.push(null);
      continue;
    }
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    level.push(Math.sqrt(sum / (to - from)));
    let top = 0;
    const f0 = Math.max(0, Math.round((fromSec - ATTACK_LEAD_SEC) / ATTACK_HOP_SEC));
    const f1 = Math.min(frames, Math.round((toSec - ATTACK_LEAD_SEC) / ATTACK_HOP_SEC));
    for (let f = f0; f < f1; f++) if (attack[f] > top) top = attack[f];
    strike.push(top);
  }
  const medianOf = (values: Array<number | null>): number => {
    const known = values.filter((v): v is number => v !== null).sort((x, y) => x - y);
    return known.length > 0 ? known[known.length >> 1] : 0;
  };
  const medianLevel = medianOf(level);
  if (medianLevel <= 0) return level.map(() => false);
  const levelLimit = medianLevel * 10 ** (thresholdDb / 20);
  const strikeLimit = medianOf(strike) * NO_STRIKE_RATIO;
  const silent = level.map((v) => v !== null && v < levelLimit);
  const unstruck = level.map((v, b) => v !== null && (strike[b] ?? 0) < strikeLimit);
  // One beat without a strike in the middle of the strumming is just a chord left to ring: stopping there
  // sounds like a hiccup. It only counts next to another quiet beat (a real pause lasts two beats or more).
  const calm = (b: number): boolean => b >= 0 && b < n && (silent[b] || unstruck[b]);
  return level.map((_, b) => silent[b] || (unstruck[b] && (calm(b - 1) || calm(b + 1))));
}

/**
 * Writes a rest on every beat marked in `quiet` (one entry per beat, in song order) and the chord again
 * when the music comes back. Only for charts written out in full (no `x2` repeats, no recalled sections,
 * no lines the grid cannot edit), where the beats of the text are the beats of the song; otherwise the
 * text comes back unchanged.
 */
export function restQuietBeats(source: string, quiet: readonly boolean[]): { source: string; rests: number } {
  const chart = parseGrid(source);
  let cells = 0;
  for (const item of chart.items) {
    if (item.kind === 'raw' || ((item.kind === 'bars' || item.kind === 'section') && item.repeat > 1)) return { source, rests: 0 };
    if (item.kind === 'bars') for (const bar of item.bars) cells += bar.cells.length;
  }
  if (cells !== quiet.length || cells !== Math.round(parseSong(source).song.totalBeats)) return { source, rests: 0 };
  let beat = 0;
  let rests = 0;
  let carry: string | null = null; // what sounds in the original text
  let written: string | null = null; // what the rewritten text holds at this point
  for (const item of chart.items) {
    if (item.kind !== 'bars') continue;
    let touched = false;
    for (const bar of item.bars) {
      const target: Array<string | null> = [];
      for (const cell of bar.cells) {
        if (cell !== '') carry = cell;
        const silent: boolean = carry === null || isSilence(carry);
        if (quiet[beat] && !silent) rests++;
        target.push(quiet[beat] && !silent ? REST_CELL : carry);
        beat++;
      }
      const next: string[] = [];
      for (let i = 0; i < bar.cells.length; i++) {
        const want: string | null = target[i];
        if (want === null) {
          next.push(bar.cells[i]);
          continue;
        }
        // The chord is kept at the start of a bar that already named it, so untouched bars stay as they were.
        next.push(want !== written || (i === 0 && bar.cells[0] === want) ? want : '');
        written = want;
      }
      if (next.some((c, i) => c !== bar.cells[i])) {
        bar.cells = next;
        touched = true;
      }
    }
    if (touched) item.orig = null;
  }
  return { source: serializeGrid(chart), rests };
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

  // (5) rests where the recording goes quiet.
  const rested = opts.quiet ? restQuietBeats(simple.source, opts.quiet) : { source: simple.source, rests: 0 };

  // (4) one strum for the whole song: later `strum:` lines (per section) are dropped.
  const chart = parseGrid(rested.source);
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
    rests: rested.rests,
    mergedBars: merged.mergedBars,
    totalBars: merged.totalBars,
    sameBeatsRatio: sameBeatsRatio(full, parseSong(simple.source).song),
  };
}
