/**
 * Automatic alignment of the written song with its audio.
 *
 * The text says WHEN the strikes should happen (every D / U / x of the strum pattern, at the
 * beats of the tempo map). The audio shows when loudness really rises. `fitSync` slides the
 * expected strikes over the audio's attack curve to find the start offset (and, when the song
 * has a single tempo, the tempo) that makes them land on the attacks. Pure, testable in Node.
 */
import type { Song, TempoSegment } from '../types';
import { beatToSec } from '../song/tempo';
import { energyAttacks } from '../song/barCheck';

/** Hop of the attack curve, seconds. */
export const FLUX_HOP_SEC = 0.005;
/** Search step of the offset, seconds. */
export const OFFSET_STEP_SEC = 0.0025;
/** Tempo factors tried (audio beat time = text beat time × factor), when the tempo is free to change. */
export const TEMPO_FACTOR_RANGE = 0.03;
export const TEMPO_FACTOR_STEP = 0.001;
/** A strike «lands» when an attack of the audio is this close, seconds. */
export const LAND_TOLERANCE_SEC = 0.03;
/** Fewer expected strikes inside the audio than this is not enough to fit. */
export const MIN_STRIKES = 6;
/** best score / mean score over the sweep below this means «no clear alignment». */
export const MIN_CONFIDENCE = 1.25;
/** The tempo is only changed when it scores this much better than the offset alone. */
export const TEMPO_GAIN = 1.1;

export interface FitInput {
  samples: Float32Array;
  sampleRate: number;
  /** Current audio time of beat 0. */
  offsetSec: number;
  segments: TempoSegment[];
  /** Absolute beats of every strike the text asks for. */
  strikes: readonly number[];
  /** Seconds of one beat at the first tempo (sets the search window). */
  beatSec: number;
  /** The tempo may be corrected (only for songs with a single tempo). */
  allowTempo: boolean;
}

export interface SyncFit {
  ok: boolean;
  /** Why it is not ok (Spanish, ready to show). */
  reason: string;
  /** Add this to the offset (positive: the audio is later than the grid). */
  deltaSec: number;
  /** Audio beat time = text beat time × this; 1 = the tempo is fine. */
  tempoFactor: number;
  /** Strikes counted (those inside the audio). */
  strikes: number;
  /** Share (0..1) of those strikes that land on an attack, before and after. */
  before: number;
  after: number;
  /** best score / mean score over the sweep. */
  confidence: number;
}

/** Attack curve of the audio: rise of the log-energy over 10 ms windows, one value per FLUX_HOP_SEC. */
export function attackCurve(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * FLUX_HOP_SEC));
  const win = hop * 2;
  const frames = Math.floor((samples.length - win) / hop);
  if (frames < 8) return new Float32Array(0);
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = f * hop;
    for (let i = 0; i < win; i++) acc += samples[base + i] * samples[base + i];
    env[f] = Math.sqrt(acc / win);
    if (env[f] > peak) peak = env[f];
  }
  if (!(peak > 1e-5)) return new Float32Array(0);
  const floor = peak * 1e-3;
  const log = new Float32Array(frames);
  for (let f = 0; f < frames; f++) log[f] = Math.log(env[f] + floor);
  const flux = new Float32Array(frames);
  for (let f = 2; f < frames; f++) flux[f] = Math.max(0, log[f] - log[f - 2]);
  // Triangular smoothing (±15 ms): a strike that is a few ms off still scores.
  const w = [1, 2, 3, 4, 3, 2, 1];
  const half = 3;
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    let norm = 0;
    for (let k = -half; k <= half; k++) {
      const g = f + k;
      if (g < 0 || g >= frames) continue;
      acc += flux[g] * w[k + half];
      norm += w[k + half];
    }
    out[f] = acc / norm;
  }
  return out;
}

export function sampleAt(curve: Float32Array, sec: number): number {
  const x = sec / FLUX_HOP_SEC;
  if (x < 0 || x >= curve.length - 1) return 0;
  const i = Math.floor(x);
  const t = x - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}

function lands(attacks: readonly number[], sec: number): boolean {
  let lo = 0;
  let hi = attacks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (attacks[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  for (const j of [lo - 1, lo]) if (j >= 0 && j < attacks.length && Math.abs(attacks[j] - sec) <= LAND_TOLERANCE_SEC) return true;
  return false;
}

const FAIL = (reason: string, strikes = 0): SyncFit => ({ ok: false, reason, deltaSec: 0, tempoFactor: 1, strikes, before: 0, after: 0, confidence: 0 });

export function fitSync(input: FitInput): SyncFit {
  const { samples, sampleRate, offsetSec, segments, strikes, beatSec } = input;
  if (!(sampleRate > 0) || samples.length === 0) return FAIL('No hay audio cargado.');
  const curve = attackCurve(samples, sampleRate);
  if (curve.length === 0) return FAIL('El audio está en silencio.');
  const duration = samples.length / sampleRate;
  const baseSec = strikes.map((b) => beatToSec(segments, b));
  // Strikes that fall inside the audio with the current alignment (±1 s of slack for the search).
  const used: number[] = [];
  for (const s of baseSec) if (offsetSec + s > 0.05 && offsetSec + s < duration - 0.05) used.push(s);
  if (used.length < MIN_STRIKES) return FAIL('Hay muy pocos golpes dentro del audio para ajustar (revisa el inicio o el patrón de rasgueo).', used.length);

  const score = (delta: number, k: number): number => {
    let acc = 0;
    for (let i = 0; i < used.length; i++) acc += sampleAt(curve, offsetSec + delta + used[i] * k);
    return acc;
  };

  // 1. Offset sweep at the current tempo. The window is under half a beat: a whole beat off is
  //    indistinguishable from right in a regular strum, so it is never offered.
  const window = Math.min(0.6, Math.max(0.15, 0.5 * (beatSec > 0 ? beatSec : 0.5)));
  const sweep = (k: number, step: number): { best: number; delta: number; mean: number } => {
    let best = -Infinity;
    let delta = 0;
    let sum = 0;
    let count = 0;
    for (let d = -window; d <= window + 1e-9; d += step) {
      const sc = score(d, k);
      sum += sc;
      count++;
      if (sc > best) {
        best = sc;
        delta = d;
      }
    }
    return { best, delta, mean: sum / Math.max(1, count) };
  };
  const flat = sweep(1, OFFSET_STEP_SEC);
  let confidence = flat.mean > 0 ? flat.best / flat.mean : 0;
  let factor = 1;
  let finalDelta = flat.delta;
  let finalScore = flat.best;

  // 2. Tempo: a drifting tempo smears the flat sweep, so the offset is searched again for every
  //    tempo factor (jointly). Only for a single-tempo song, and only when it clearly helps.
  if (input.allowTempo && segments.length === 1) {
    let tBest = -Infinity;
    let tFactor = 1;
    let tDelta = 0;
    let tSum = 0;
    let tCount = 0;
    for (let k = 1 - TEMPO_FACTOR_RANGE; k <= 1 + TEMPO_FACTOR_RANGE + 1e-9; k += TEMPO_FACTOR_STEP) {
      const r = sweep(k, 2 * OFFSET_STEP_SEC);
      tSum += r.mean;
      tCount++;
      if (r.best > tBest) {
        tBest = r.best;
        tFactor = k;
        tDelta = r.delta;
      }
    }
    if (tBest > flat.best * TEMPO_GAIN && Math.abs(tFactor - 1) >= 0.002) {
      factor = tFactor;
      finalDelta = tDelta;
      finalScore = tBest;
      confidence = tSum > 0 ? tBest / (tSum / Math.max(1, tCount)) : 0;
    }
  }

  // 3. Fine offset (0.5 ms) around the winner.
  for (let d = finalDelta - OFFSET_STEP_SEC; d <= finalDelta + OFFSET_STEP_SEC + 1e-9; d += 0.0005) {
    const sc = score(d, factor);
    if (sc > finalScore) {
      finalScore = sc;
      finalDelta = d;
    }
  }

  // How many strikes land on an attack before and after (a plain, readable measure).
  const attacks = energyAttacks(samples, sampleRate, 0, duration);
  const share = (delta: number, k: number): number => {
    let hit = 0;
    for (const s of used) if (lands(attacks, offsetSec + delta + s * k)) hit++;
    return hit / used.length;
  };
  const before = share(0, 1);
  const after = share(finalDelta, factor);
  const ok = confidence >= MIN_CONFIDENCE && after >= before;
  return {
    ok,
    reason: ok ? '' : confidence < MIN_CONFIDENCE ? 'No hay un punto claro donde los golpes del texto encajen con el audio: puede que el patrón de rasgueo no sea el de la canción.' : 'El ajuste no mejora el encaje.',
    deltaSec: Math.round(finalDelta * 10000) / 10000,
    tempoFactor: Math.round(factor * 100000) / 100000,
    strikes: used.length,
    before,
    after,
    confidence,
  };
}

/** One-line Spanish description of a fit, for the result box. */
export function describeFit(fit: SyncFit): string {
  if (!fit.ok) return fit.reason;
  const ms = Math.round(fit.deltaSec * 1000);
  const parts: string[] = [];
  if (Math.abs(ms) < 3 && fit.tempoFactor === 1) parts.push('La cuadrícula ya está alineada con el audio.');
  else {
    if (Math.abs(ms) >= 3) parts.push(`La cuadrícula iba ${Math.abs(ms)} ms ${ms > 0 ? 'adelantada' : 'retrasada'} respecto al audio.`);
    if (fit.tempoFactor !== 1) parts.push(`El tempo estaba ${fit.tempoFactor > 1 ? 'un poco rápido' : 'un poco lento'} (${((fit.tempoFactor - 1) * 100).toFixed(1)} %).`);
  }
  parts.push(`Golpes que encajan: ${Math.round(fit.before * 100)} % → ${Math.round(fit.after * 100)} % (de ${fit.strikes}).`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- bar by bar (where the sync is lost)

/** A change of the bar-to-bar offset beyond this is reported as a jump, seconds. */
export const JUMP_MIN_SEC = 0.04;

export interface BarDrift {
  bar: number;
  /** Audio later (+) or earlier (−) than the grid for the strikes of this bar; null = no clear answer (silence, other rhythm...). */
  deltaSec: number | null;
  confidence: number;
}

export interface DriftJump {
  /** First confident bar before and after the jump (0-based). */
  fromBar: number;
  toBar: number;
  /** The bar whose length in the audio differs from the text (the last bar before `toBar`). */
  culpritBar: number;
  /** Seconds the later part is shifted (positive: the audio is later). */
  jumpSec: number;
}

/** Offset states of the bar-by-bar path, seconds. */
export const PATH_STEP_SEC = 0.005;
/** Cost of leaving the current offset (plus PATH_JUMP_SLOPE per window width): a bar must gain more than this to move the path. */
export const PATH_JUMP_COST = 0.25;
export const PATH_JUMP_SLOPE = 0.5;
/** A bar «shows» its strikes when this share of them reaches 20 % of a clear attack at the path's offset. */
export const PATH_MIN_PRESENT = 0.5;

/**
 * How far the audio is from the grid, bar by bar, as ONE consistent path (Viterbi): every bar scores
 * each possible offset (±~¾ beat) by how well its own strikes land on attacks, and moving the path
 * between bars costs more the further it moves. A noisy bar or one that matches a neighbouring
 * beat by accident therefore follows its neighbours, while a lasting change of the audio (a longer
 * bar, a slowing tempo) still moves the path. Bars without clear strikes of their own get null.
 */
export function barDrift(
  samples: Float32Array,
  sampleRate: number,
  offsetSec: number,
  song: Pick<Song, 'bars' | 'events' | 'tempoSegments'>,
  precomputed?: Float32Array,
): BarDrift[] {
  const curve = precomputed ?? attackCurve(samples, sampleRate);
  const duration = samples.length / Math.max(1, sampleRate);
  const nBars = song.bars.length;
  const none = (): BarDrift[] => song.bars.map((_, i) => ({ bar: i, deltaSec: null, confidence: 0 }));
  if (curve.length === 0 || nBars === 0) return none();
  const sorted = Float32Array.from(curve).sort();
  const ref = sorted[Math.floor(sorted.length * 0.97)];
  if (!(ref > 0)) return none();
  const byBar: number[][] = song.bars.map(() => []);
  for (const e of song.events) if (byBar[e.barIndex]) byBar[e.barIndex].push(beatToSec(song.tempoSegments, e.time));
  const first = song.bars[0];
  const beatSec = beatToSec(song.tempoSegments, first.startBeat + 1) - beatToSec(song.tempoSegments, first.startBeat);
  const window = Math.min(0.6, Math.max(0.2, 0.75 * beatSec));
  const states = Math.floor((2 * window) / PATH_STEP_SEC) + 1;
  const delta = (s: number): number => -window + s * PATH_STEP_SEC;

  // Emission of each bar for each offset: mean strength of its strikes (≈1 = every strike on a clear attack).
  const secsOf: number[][] = byBar.map((all) => all.filter((t) => offsetSec + t > 0.05 && offsetSec + t < duration - 0.05));
  const usable = secsOf.map((secs, i) => secs.length >= 3 && secs.length >= 0.8 * byBar[i].length);
  const emission: Float32Array[] = secsOf.map((secs, i) => {
    const e = new Float32Array(states);
    if (!usable[i]) return e;
    for (let s = 0; s < states; s++) {
      let acc = 0;
      for (const t of secs) acc += sampleAt(curve, offsetSec + delta(s) + t);
      e[s] = acc / (secs.length * ref);
    }
    return e;
  });

  // Viterbi with a cost for moving between offsets.
  const score: Float32Array[] = [];
  const back: Int16Array[] = [];
  for (let i = 0; i < nBars; i++) {
    const cur = new Float32Array(states);
    const from = new Int16Array(states);
    if (i === 0) {
      for (let s = 0; s < states; s++) cur[s] = emission[0][s] - 0.3 * (Math.abs(delta(s)) / window);
    } else {
      const prev = score[i - 1];
      for (let s = 0; s < states; s++) {
        let bestV = -Infinity;
        let bestS = s;
        for (let q = 0; q < states; q++) {
          const move = q === s ? 0 : PATH_JUMP_COST + (PATH_JUMP_SLOPE * Math.abs(s - q) * PATH_STEP_SEC) / window;
          const v = prev[q] - move;
          if (v > bestV) {
            bestV = v;
            bestS = q;
          }
        }
        cur[s] = emission[i][s] + bestV;
        from[s] = bestS;
      }
    }
    score.push(cur);
    back.push(from);
  }
  let s = 0;
  for (let q = 1; q < states; q++) if (score[nBars - 1][q] > score[nBars - 1][s]) s = q;
  const path = new Array<number>(nBars);
  for (let i = nBars - 1; i >= 0; i--) {
    path[i] = s;
    s = back[i][s];
  }
  return song.bars.map((_, i): BarDrift => {
    const secs = secsOf[i];
    if (!usable[i]) return { bar: i, deltaSec: null, confidence: 0 };
    const d = delta(path[i]);
    let present = 0;
    for (const t of secs) if (sampleAt(curve, offsetSec + d + t) >= 0.2 * ref) present++;
    const share = present / secs.length;
    return { bar: i, deltaSec: share >= PATH_MIN_PRESENT ? Math.round(d * 1000) / 1000 : null, confidence: share };
  });
}

/** Where consecutive confident bars disagree by more than `minJumpSec`: the length of the bar before the second one is wrong. */
export function driftJumps(drift: readonly BarDrift[], minJumpSec = JUMP_MIN_SEC): DriftJump[] {
  const out: DriftJump[] = [];
  let prev: BarDrift | null = null;
  for (const d of drift) {
    if (d.deltaSec === null) continue;
    if (prev && prev.deltaSec !== null && Math.abs(d.deltaSec - prev.deltaSec) >= minJumpSec) {
      out.push({ fromBar: prev.bar, toBar: d.bar, culpritBar: d.bar - 1, jumpSec: d.deltaSec - prev.deltaSec });
    }
    prev = d;
  }
  return out;
}

// ---------------------------------------------------------------- one plan instead of many corrections

/** A change of level has to last at least this many confident bars to count (a single odd bar is the player, not the song). */
export const JUMP_PERSIST_BARS = 3;

export interface DriftPlan {
  /** Seconds the audio gains (+) or loses (−) on the text per bar: a tempo that is a little off. */
  slopePerBar: number;
  /** Offset of the first stretch once that slope is removed (seconds, + = audio later). */
  interceptSec: number;
  /** Lasting level changes left after removing the slope: bars whose length really differs. */
  jumps: DriftJump[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((x, y) => x - y);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Reads the bar-by-bar drift as «a steady slope (tempo a bit off) + a few lasting steps (bars of
 * different length) + noise». The slope is the median bar-to-bar change, which a few steps do not
 * move; after removing it only level changes that persist for JUMP_PERSIST_BARS confident bars on
 * each side are reported (one per cluster, at its sharpest point). Noise and one-off bars disappear.
 */
export function planDrift(drift: readonly BarDrift[], minJumpSec = JUMP_MIN_SEC): DriftPlan {
  const conf = drift.filter((d): d is BarDrift & { deltaSec: number } => d.deltaSec !== null);
  if (conf.length < 3) return { slopePerBar: 0, interceptSec: 0, jumps: [] };
  const diffs: number[] = [];
  for (let m = 1; m < conf.length; m++) {
    const gap = conf[m].bar - conf[m - 1].bar;
    if (gap >= 1 && gap <= 2) diffs.push((conf[m].deltaSec - conf[m - 1].deltaSec) / gap);
  }
  const slope = median(diffs);
  const e = conf.map((d) => d.deltaSec - slope * d.bar);
  const candidates: Array<{ m: number; diff: number }> = [];
  for (let m = 1; m < conf.length; m++) {
    const before = e.slice(Math.max(0, m - JUMP_PERSIST_BARS), m);
    const after = e.slice(m, m + JUMP_PERSIST_BARS);
    if (before.length < 2 || after.length < 2) continue;
    const diff = median(after) - median(before);
    if (Math.abs(diff) >= minJumpSec) candidates.push({ m, diff });
  }
  const jumps: DriftJump[] = [];
  let cluster: Array<{ m: number; diff: number }> = [];
  const flush = (): void => {
    if (cluster.length === 0) return;
    const top = cluster.reduce((a, b) => (Math.abs(b.diff) > Math.abs(a.diff) ? b : a));
    jumps.push({ fromBar: conf[top.m - 1].bar, toBar: conf[top.m].bar, culpritBar: conf[top.m].bar - 1, jumpSec: top.diff });
    cluster = [];
  };
  for (const c of candidates) {
    if (cluster.length > 0 && c.m - cluster[cluster.length - 1].m > 1) flush();
    cluster.push(c);
  }
  flush();
  const firstJumpAt = jumps.length > 0 ? jumps[0].toBar : Infinity;
  const head = conf.map((d, i) => ({ bar: d.bar, v: e[i] })).filter((x) => x.bar < firstJumpAt).map((x) => x.v);
  return { slopePerBar: slope, interceptSec: median(head.length > 0 ? head : e), jumps };
}
