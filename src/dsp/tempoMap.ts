/**
 * «Seguir el audio»: a tempo for every stretch (text line) of the song so that the bars of the
 * text start where the bars of the recording start.
 *
 * A person never plays at a constant tempo, so a single offset / tempo (dsp/syncFit.ts fitSync)
 * leaves errors that grow and shrink along the song. Instead of correcting bar after bar, the
 * recording is followed once: the start of every stretch is an «anchor» in the audio, and the
 * anchors are chosen all together (dynamic programming) so that the strikes of the text land on
 * the attacks of the audio, with a small cost for a tempo far from the written one. The tempo of
 * a stretch is then just its beats divided by the time between its two anchors.
 */
import type { Song } from '../types';
import { beatToSec } from '../song/tempo';
import { energyAttacks } from '../song/barCheck';
import { attackCurve, sampleAt, LAND_TOLERANCE_SEC } from './syncFit';

export interface Stretch {
  /** Expanded bar indices: [fromBar, toBar). */
  fromBar: number;
  toBar: number;
  /** False when its tempo cannot be written on its own (the text line repeats): it keeps its written duration. */
  retimable: boolean;
}

export interface TempoMap {
  ok: boolean;
  reason: string;
  /** Tempo (bpm) of every stretch, rounded to 0.01. */
  bpm: number[];
  /** Offset change at every anchor relative to the written grid (stretches + 1 values, seconds). */
  anchors: number[];
  /** Strikes counted and the share that lands on an attack with the written grid and with the map. */
  strikes: number;
  before: number;
  after: number;
}

/** Search width of the anchors around the written grid, seconds. */
export const ANCHOR_RANGE_SEC = 0.8;
export const ANCHOR_STEP_SEC = 0.01;
/** Largest tempo change of a stretch relative to what is written (±10 %). */
export const MAX_RATIO_CHANGE = 0.1;
/** Cost per unit of |duration ratio − 1|: a tempo far from the written one needs evidence. */
export const RATIO_COST = 4;

const FAIL = (reason: string): TempoMap => ({ ok: false, reason, bpm: [], anchors: [], strikes: 0, before: 0, after: 0 });

export function followAudio(
  samples: Float32Array,
  sampleRate: number,
  offsetSec: number,
  song: Pick<Song, 'bars' | 'events' | 'tempoSegments'>,
  stretches: readonly Stretch[],
): TempoMap {
  if (!(sampleRate > 0) || samples.length === 0 || stretches.length === 0) return FAIL('No hay audio cargado.');
  const curve = attackCurve(samples, sampleRate);
  if (curve.length === 0) return FAIL('El audio está en silencio.');
  const sorted = Float32Array.from(curve).sort();
  const ref = sorted[Math.floor(sorted.length * 0.97)];
  if (!(ref > 0)) return FAIL('El audio está en silencio.');
  const duration = samples.length / sampleRate;

  const barsOf = (st: Stretch) => song.bars.slice(st.fromBar, st.toBar);
  const startSec = (st: Stretch): number => beatToSec(song.tempoSegments, song.bars[st.fromBar].startBeat);
  const endSec = (st: Stretch): number => {
    const last = song.bars[st.toBar - 1];
    return beatToSec(song.tempoSegments, last.startBeat + last.beats);
  };
  const barToStretch = new Int32Array(song.bars.length).fill(-1);
  stretches.forEach((st, i) => {
    for (let b = st.fromBar; b < st.toBar; b++) barToStretch[b] = i;
  });
  // Strikes of each stretch as fractions of its written duration.
  const fracs: number[][] = stretches.map(() => []);
  for (const e of song.events) {
    const i = barToStretch[e.barIndex];
    if (i < 0) continue;
    const st = stretches[i];
    const dur = endSec(st) - startSec(st);
    fracs[i].push((beatToSec(song.tempoSegments, e.time) - startSec(st)) / dur);
  }

  const states = Math.floor((2 * ANCHOR_RANGE_SEC) / ANCHOR_STEP_SEC) + 1;
  const dOf = (s: number): number => -ANCHOR_RANGE_SEC + s * ANCHOR_STEP_SEC;
  const M = stretches.length;
  const best: Float32Array[] = [];
  const from: Int16Array[] = [];
  const first = new Float32Array(states);
  // The start may only move by less than half a beat: a whole beat off is indistinguishable in a regular strum.
  const b0 = song.bars[0];
  const beatSec = beatToSec(song.tempoSegments, b0.startBeat + 1) - beatToSec(song.tempoSegments, b0.startBeat);
  const startLimit = Math.min(ANCHOR_RANGE_SEC, 0.5 * (beatSec > 0 ? beatSec : 0.5));
  for (let s = 0; s < states; s++) first[s] = Math.abs(dOf(s)) > startLimit ? -Infinity : -0.3 * (Math.abs(dOf(s)) / ANCHOR_RANGE_SEC);
  best.push(first);
  from.push(new Int16Array(states));

  let total = 0;
  for (let L = 0; L < M; L++) {
    const st = stretches[L];
    const g0 = startSec(st);
    const dur = endSec(st) - g0;
    const f = fracs[L];
    // Strikes inside the audio (with the written grid, a little slack for the search).
    const inside = f.filter((x) => offsetSec + g0 + x * dur > 0.05 && offsetSec + g0 + x * dur < duration - 0.05);
    total += inside.length;
    const n = inside.length;
    const useful = n >= 3;
    const prev = best[L];
    const cur = new Float32Array(states).fill(-Infinity);
    const back = new Int16Array(states);
    const maxMove = Math.floor((MAX_RATIO_CHANGE * dur) / ANCHOR_STEP_SEC);
    const score = (sa: number, sb: number): number => {
      if (!useful) return 0;
      const da = dOf(sa);
      const db = dOf(sb);
      let acc = 0;
      for (let j = 0; j < n; j++) acc += sampleAt(curve, offsetSec + g0 + da + inside[j] * (dur + db - da));
      return acc / (n * ref);
    };
    for (let sb = 0; sb < states; sb++) {
      let bestV = -Infinity;
      let bestA = sb;
      if (!st.retimable) {
        bestV = prev[sb] + score(sb, sb);
        bestA = sb;
      } else {
        const lo = Math.max(0, sb - maxMove);
        const hi = Math.min(states - 1, sb + maxMove);
        for (let sa = lo; sa <= hi; sa++) {
          if (prev[sa] === -Infinity) continue;
          const ratio = 1 + (dOf(sb) - dOf(sa)) / dur;
          const v = prev[sa] + score(sa, sb) - RATIO_COST * Math.abs(ratio - 1);
          if (v > bestV) {
            bestV = v;
            bestA = sa;
          }
        }
      }
      cur[sb] = bestV;
      back[sb] = bestA;
    }
    best.push(cur);
    from.push(back);
  }
  if (total < 6) return FAIL('Hay muy pocos golpes dentro del audio para seguirlo.');
  let s = 0;
  for (let q = 1; q < states; q++) if (best[M][q] > best[M][s]) s = q;
  const anchorStates = new Array<number>(M + 1);
  for (let L = M; L >= 0; L--) {
    anchorStates[L] = s;
    s = from[L][s];
  }
  const anchors = anchorStates.map(dOf);
  const bpm = stretches.map((st, L) => {
    const beats = barsOf(st).reduce((a, b) => a + b.beats, 0);
    const dur = endSec(st) - startSec(st) + anchors[L + 1] - anchors[L];
    return Math.round(((beats * 60) / dur) * 100) / 100;
  });

  // How many strikes land on an attack with the written grid versus with the map.
  const attacks = energyAttacks(samples, sampleRate, 0, duration);
  const lands = (sec: number): boolean => {
    let lo = 0;
    let hi = attacks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (attacks[mid] < sec) lo = mid + 1;
      else hi = mid;
    }
    for (const j of [lo - 1, lo]) if (j >= 0 && j < attacks.length && Math.abs(attacks[j] - sec) <= LAND_TOLERANCE_SEC) return true;
    return false;
  };
  let hitsBefore = 0;
  let hitsAfter = 0;
  let counted = 0;
  stretches.forEach((st, L) => {
    const g0 = startSec(st);
    const dur = endSec(st) - g0;
    for (const x of fracs[L]) {
      const written = offsetSec + g0 + x * dur;
      if (!(written > 0.05 && written < duration - 0.05)) continue;
      counted++;
      if (lands(written)) hitsBefore++;
      if (lands(offsetSec + g0 + anchors[L] + x * (dur + anchors[L + 1] - anchors[L]))) hitsAfter++;
    }
  });
  return { ok: true, reason: '', bpm, anchors, strikes: counted, before: counted ? hitsBefore / counted : 0, after: counted ? hitsAfter / counted : 0 };
}
