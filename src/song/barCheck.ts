/**
 * Pure helpers of the «Comprobar» view: what to show for one bar of the song so that the text
 * (chords and strum) can be checked against the waveform of the audio. Testable in Node.
 */
import type { Song } from '../types';
import { beatToSec } from './tempo';

/** Beats of context shown before and after the bar. */
export const CONTEXT_BEATS = 1;

export interface BarWindow {
  /** First and last beat (absolute) of the bar itself. */
  startBeat: number;
  endBeat: number;
  /** Visible range, with the context beats. */
  w0: number;
  w1: number;
}

export function barWindow(song: Pick<Song, 'bars'>, barIndex: number, context = CONTEXT_BEATS): BarWindow | null {
  const bar = song.bars[barIndex];
  if (!bar) return null;
  return { startBeat: bar.startBeat, endBeat: bar.startBeat + bar.beats, w0: bar.startBeat - context, w1: bar.startBeat + bar.beats + context };
}

export interface BarCell {
  /** Absolute beat of the cell. */
  beat: number;
  /** Chord that starts on this beat, or null when the previous chord keeps ringing. */
  chord: string | null;
  rest: boolean;
}

/** One cell per beat of the bar, like the grid shows it. */
export function barCells(song: Pick<Song, 'bars'>, barIndex: number): BarCell[] {
  const bar = song.bars[barIndex];
  if (!bar) return [];
  const cells: BarCell[] = [];
  for (let i = 0; i < bar.beats; i++) cells.push({ beat: bar.startBeat + i, chord: null, rest: false });
  for (const c of bar.chords) {
    const at = Math.round(c.startBeat - bar.startBeat);
    if (at < 0 || at >= cells.length || Math.abs(c.startBeat - bar.startBeat - at) > 1e-6) continue;
    cells[at].chord = c.chord.name;
    cells[at].rest = c.chord.name === '-';
  }
  return cells;
}

export type StrumKind = 'down' | 'up' | 'muted';

export interface BarStrum {
  /** Absolute beat of the strike. */
  beat: number;
  beatInBar: number;
  kind: StrumKind;
  chord: string;
  /** First strike of a new chord. */
  chordChange: boolean;
}

/** The strikes the text asks for inside the bar, in time order. */
export function barStrums(song: Pick<Song, 'bars' | 'events'>, barIndex: number): BarStrum[] {
  const out: BarStrum[] = [];
  for (const e of song.events) {
    if (e.barIndex !== barIndex) continue;
    out.push({
      beat: e.time,
      beatInBar: e.beatInBar,
      kind: e.muted ? 'muted' : e.direction === 'up' ? 'up' : 'down',
      chord: e.chord.name,
      chordChange: e.chordChange,
    });
  }
  return out;
}

export interface WindowPeaks {
  min: Float32Array;
  max: Float32Array;
}

/**
 * Min / max of the samples for `width` columns that cover the beats `w0..w1`. The beat → audio
 * time mapping follows the tempo map: time of beat k = offsetSec + beatToSec(segments, k).
 */
export function windowPeaks(
  samples: Float32Array,
  sampleRate: number,
  song: Pick<Song, 'tempoSegments'>,
  offsetSec: number,
  w0: number,
  w1: number,
  width: number,
): WindowPeaks {
  const cols = Math.max(0, Math.floor(width));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  if (cols === 0 || !(sampleRate > 0) || samples.length === 0 || !(w1 > w0)) return { min, max };
  for (let c = 0; c < cols; c++) {
    const b0 = w0 + ((w1 - w0) * c) / cols;
    const b1 = w0 + ((w1 - w0) * (c + 1)) / cols;
    const s0 = Math.floor((offsetSec + beatToSec(song.tempoSegments, b0)) * sampleRate);
    const s1 = Math.max(s0 + 1, Math.ceil((offsetSec + beatToSec(song.tempoSegments, b1)) * sampleRate));
    let lo = 0;
    let hi = 0;
    for (let i = Math.max(0, s0); i < s1 && i < samples.length; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/**
 * Times (audio seconds) at which the loudness of the audio rises sharply inside `fromSec..toSec`:
 * a rough «there seems to be a strike here» hint, from the short-time energy (5 ms hop). Not the
 * app's strum detector; it only has to be good enough to compare by eye.
 */
export function energyAttacks(samples: Float32Array, sampleRate: number, fromSec: number, toSec: number, minGapSec = 0.07): number[] {
  if (!(sampleRate > 0) || !(toSec > fromSec) || samples.length === 0) return [];
  const hop = Math.max(1, Math.round(sampleRate * 0.005));
  const win = hop * 2;
  const start = Math.max(0, Math.floor(fromSec * sampleRate));
  const end = Math.min(samples.length, Math.ceil(toSec * sampleRate));
  const frames = Math.floor((end - start - win) / hop);
  if (frames < 4) return [];
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = start + f * hop;
    for (let i = 0; i < win; i++) acc += samples[base + i] * samples[base + i];
    env[f] = Math.sqrt(acc / win);
  }
  const flux = new Float32Array(frames);
  let peak = 0;
  for (let f = 2; f < frames; f++) {
    flux[f] = Math.max(0, env[f] - env[f - 2]);
    if (flux[f] > peak) peak = flux[f];
  }
  if (!(peak > 1e-4)) return [];
  const thr = peak * 0.3;
  const gapFrames = Math.max(1, Math.round(minGapSec / (hop / sampleRate)));
  const out: number[] = [];
  let lastFrame = -gapFrames;
  for (let f = 2; f < frames - 1; f++) {
    if (flux[f] >= thr && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1] && f - lastFrame >= gapFrames) {
      out.push((start + f * hop) / sampleRate);
      lastFrame = f;
    }
  }
  return out;
}

/** «Pulso 1 · ↓ Em, ↑ …» one-line description of the strikes of a bar, for screen readers and the caption. */
export function strumCaption(strums: readonly BarStrum[]): string {
  if (strums.length === 0) return 'Sin golpes en este compás';
  const sym = { down: '↓', up: '↑', muted: '✕' } as const;
  return strums.map((s) => `${sym[s.kind]} pulso ${Math.round(s.beatInBar * 100) / 100 + 1} (${s.chord})`).join(' · ');
}
