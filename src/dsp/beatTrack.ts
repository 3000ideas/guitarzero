/**
 * Beat tracking by dynamic programming (Ellis 2007, "Beat tracking by dynamic programming")
 * over the onset envelope of tempoEstimate.ts. Pure TypeScript on typed arrays (no Web Audio),
 * testable in Node. See docs/SPEC.md section 15.
 *
 * Given a global tempo (from estimateTempo or the user) it finds the sequence of beat times
 * that best explains the attacks of the whole recording while staying close to that tempo, so
 * the grid follows a tempo that drifts, ramps or jumps instead of a constant period.
 *
 * Pipeline:
 *  1. Onset envelope exactly as tempoEstimate.ts (decimation to ~11025 Hz, STFT 1024/256, hop
 *     ~23 ms), normalised by its standard deviation, lightly smoothed (Gaussian, sigma = tau/32
 *     frames) -> local score.
 *  2. tau = 60 / bpm in frames. For every frame t:
 *       score[t] = local[t] + max_{p in [t - 2 tau, t - tau/2]} (score[p] - tightness * ln((t - p) / tau)^2)
 *       backlink[t] = argmax (no predecessor before the first significant onset, or before frame 0:
 *       the chain can start there at no cost).
 *     The log-squared penalty is 0 at exactly tau and grows with the deviation: with
 *     tightness 100 a 10 % deviation costs 0.9 and a 5 % one 0.24, while an attack scores
 *     several units, so the chain follows the attacks even through a tempo jump of 10 %.
 *  3. The chain starts at the last local maximum of `score` (above half the median of the local
 *     maxima, so a silent tail does not pin it to the end) and is followed back through
 *     `backlink`. Beats at both ends whose onset strength (smoothed over 5 beats) is below half
 *     the RMS over the chain are dropped: the leading ones are beats before the first
 *     significant attack, the trailing ones a silent tail. With `firstBeatSec` the tracked beat
 *     nearest to it is the phase reference: it is always kept (the tracked times never change,
 *     only which beats are reported).
 *  4. Sub-frame refinement: every beat frame is moved to the local maximum of the raw envelope
 *     within +-1 frame and parabolically interpolated over its three frames.
 *  5. `bpm` = 60 / median beat interval.
 */
import { decimateForTempo, onsetEnvelope } from './tempoEstimate';

export interface BeatTrackOpts {
  /** Global tempo the tracker stays close to, BPM (from estimateTempo or the user). */
  bpm: number;
  /** Seconds into the audio of a known beat (typically TempoEstimate.firstBeatSec): the tracked beat nearest to it is always kept. */
  firstBeatSec?: number;
  /** Only the first `maxSeconds` of audio are analysed (default: all of it). */
  maxSeconds?: number;
  /** Weight of the tempo-deviation penalty (default 100). */
  tightness?: number;
}

export interface BeatTrackResult {
  /** Beat times in seconds, increasing. Empty for silence. */
  beatTimes: number[];
  /** 60 / median beat interval; `opts.bpm` when fewer than two beats were found. */
  bpm: number;
}

/** Default weight of the log-squared tempo-deviation penalty. */
export const DEFAULT_TIGHTNESS = 100;
/** Below this RMS the signal counts as silence (same gate as tempoEstimate.ts). */
const SILENCE_RMS = 1e-4;
/** Predecessor search window [t - WINDOW_MAX * tau, t - WINDOW_MIN * tau]. */
const WINDOW_MIN = 0.5;
const WINDOW_MAX = 2;
/** Gaussian smoothing of the local score: sigma = tau * SMOOTH_FRACTION frames. */
const SMOOTH_FRACTION = 1 / 32;
/** Frames whose local score is below this fraction of its maximum cannot be the first beat. */
const START_FRACTION = 0.01;
/** The chain starts at the last local maximum of the score above this fraction of the median local maximum. */
const LAST_BEAT_FRACTION = 0.5;
/** Beats at both ends whose smoothed onset strength is below this fraction of the RMS over the chain are dropped. */
const TRIM_FRACTION = 0.5;
/** Weights of the 5-beat smoothing used by the trimming (Hann). */
const TRIM_WINDOW = [0.25, 0.75, 1, 0.75, 0.25];
/**
 * An end beat whose own (unsmoothed) strength is below this fraction of the trim threshold is
 * dropped too: near the end of the envelope the score rises again as the penalty of a short
 * last step shrinks, so the last frame can end the chain with no attack of its own.
 */
const TRIM_OWN_FRACTION = 0.5;

function median(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/** Local score: the envelope divided by its standard deviation and smoothed with a Gaussian of `sigma` frames. */
function localScore(env: Float32Array, sigma: number): Float64Array {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = env[i] - mean;
    sq += d * d;
  }
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  const local = new Float64Array(n);
  if (!(std > 0)) return local;
  const half = Math.max(1, Math.ceil(3 * sigma));
  const w = new Float64Array(2 * half + 1);
  let wsum = 0;
  for (let k = -half; k <= half; k++) {
    w[k + half] = Math.exp((-0.5 * k * k) / (sigma * sigma));
    wsum += w[k + half];
  }
  const inv = 1 / (std * wsum);
  for (let t = 0; t < n; t++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      const i = t + k;
      if (i >= 0 && i < n) acc += w[k + half] * env[i];
    }
    local[t] = acc * inv;
  }
  return local;
}

/** Sub-frame time of the onset around frame `b`: local maximum of the envelope within +-1 frame, parabolic interpolation over its neighbours. */
function refineFrame(env: Float32Array, b: number): number {
  const n = env.length;
  let c = b;
  if (b - 1 >= 0 && env[b - 1] > env[c]) c = b - 1;
  if (b + 1 < n && env[b + 1] > env[c]) c = b + 1;
  if (c - 1 < 0 || c + 1 >= n) return c;
  const y0 = env[c - 1];
  const y1 = env[c];
  const y2 = env[c + 1];
  const denom = y0 - 2 * y1 + y2;
  if (!(denom < 0)) return c;
  let delta = (0.5 * (y0 - y2)) / denom;
  if (delta > 0.5) delta = 0.5;
  else if (delta < -0.5) delta = -0.5;
  return c + delta;
}

/**
 * Tracks the beats of `samples` (mono) around the tempo `opts.bpm`. Near-silent input (RMS below
 * 1e-4 over the analysed span) or input without onsets returns no beats and `opts.bpm`. Throws
 * RangeError for an invalid sampleRate, bpm (10..1000) or tightness.
 */
export function trackBeats(samples: Float32Array, sampleRate: number, opts: BeatTrackOpts): BeatTrackResult {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`trackBeats: invalid sampleRate ${sampleRate}`);
  }
  if (!Number.isFinite(opts.bpm) || opts.bpm < 10 || opts.bpm > 1000) {
    throw new RangeError(`trackBeats: invalid bpm ${opts.bpm}`);
  }
  const tightness = opts.tightness === undefined ? DEFAULT_TIGHTNESS : opts.tightness;
  if (!Number.isFinite(tightness) || tightness <= 0) {
    throw new RangeError(`trackBeats: invalid tightness ${opts.tightness}`);
  }
  if (opts.firstBeatSec !== undefined && !Number.isFinite(opts.firstBeatSec)) {
    throw new RangeError(`trackBeats: invalid firstBeatSec ${opts.firstBeatSec}`);
  }
  const maxSeconds =
    Number.isFinite(opts.maxSeconds) && (opts.maxSeconds as number) > 0 ? (opts.maxSeconds as number) : Number.POSITIVE_INFINITY;
  const empty: BeatTrackResult = { beatTimes: [], bpm: opts.bpm };

  // (1) onset envelope and local score
  const { data, rate, rms } = decimateForTempo(samples, sampleRate, maxSeconds);
  if (rms < SILENCE_RMS) return empty;
  const { env, frameRate, frameOffsetSec } = onsetEnvelope(data, rate);
  const n = env.length;
  if (n === 0) return empty;
  const tau = (60 / opts.bpm) * frameRate;
  const local = localScore(env, Math.max(0.5, tau * SMOOTH_FRACTION));
  let localMax = 0;
  for (let t = 0; t < n; t++) if (local[t] > localMax) localMax = local[t];
  if (!(localMax > 0)) return empty;

  // (2) dynamic programming
  const dMin = Math.max(1, Math.round(WINDOW_MIN * tau));
  const dMax = Math.max(dMin, Math.round(WINDOW_MAX * tau));
  const penalty = new Float64Array(dMax - dMin + 1);
  for (let d = dMin; d <= dMax; d++) {
    const l = Math.log(d / tau);
    penalty[d - dMin] = tightness * l * l;
  }
  const score = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const startThreshold = START_FRACTION * localMax;
  let beforeFirst = true;
  for (let t = 0; t < n; t++) {
    let best = Number.NEGATIVE_INFINITY;
    let bestP = -1;
    for (let d = dMin; d <= dMax; d++) {
      const p = t - d;
      const cand = (p >= 0 ? score[p] : 0) - penalty[d - dMin];
      if (cand > best) {
        best = cand;
        bestP = p;
      }
    }
    score[t] = local[t] + best;
    if (beforeFirst && local[t] < startThreshold) continue;
    beforeFirst = false;
    backlink[t] = bestP >= 0 ? bestP : -1;
  }

  // (3) last beat, backtracking, trimming
  const maxima: number[] = [];
  for (let t = 0; t < n; t++) {
    const left = t === 0 ? Number.NEGATIVE_INFINITY : score[t - 1];
    const right = t === n - 1 ? Number.NEGATIVE_INFINITY : score[t + 1];
    if (score[t] > left && score[t] >= right) maxima.push(t);
  }
  if (maxima.length === 0) return empty;
  const medianMax = median(maxima.map((t) => score[t]));
  let last = -1;
  for (const t of maxima) if (score[t] > LAST_BEAT_FRACTION * medianMax) last = t;
  if (last < 0) return empty;
  const chain: number[] = [];
  for (let t = last; t >= 0; t = backlink[t]) chain.push(t);
  chain.reverse();
  const m = chain.length;
  const strength = chain.map((t) => local[t]);
  const smoothed = new Array<number>(m);
  let sq = 0;
  for (let i = 0; i < m; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= m) continue;
      acc += TRIM_WINDOW[k + 2] * strength[j];
      wsum += TRIM_WINDOW[k + 2];
    }
    smoothed[i] = acc / wsum;
    sq += smoothed[i] * smoothed[i];
  }
  const trimThreshold = TRIM_FRACTION * Math.sqrt(sq / m);
  let lo = 0;
  while (lo < m && smoothed[lo] < trimThreshold) lo++;
  let hi = m - 1;
  while (hi > lo && smoothed[hi] < trimThreshold) hi--;
  // The 5-beat smoothing lets one silent beat through next to a strong one: an end beat with
  // (almost) no attack of its own goes too.
  const ownThreshold = TRIM_OWN_FRACTION * trimThreshold;
  while (lo < hi && strength[lo] < ownThreshold) lo++;
  while (hi > lo && strength[hi] < ownThreshold) hi--;
  if (lo >= m) return empty;
  if (opts.firstBeatSec !== undefined) {
    const refFrame = (opts.firstBeatSec - frameOffsetSec) * frameRate;
    let ref = 0;
    for (let i = 1; i < m; i++) if (Math.abs(chain[i] - refFrame) < Math.abs(chain[ref] - refFrame)) ref = i;
    if (ref < lo) lo = ref;
    if (ref > hi) hi = ref;
  }

  // (4) sub-frame refinement, (5) tempo
  const beatTimes: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const t = frameOffsetSec + refineFrame(env, chain[i]) / frameRate;
    if (beatTimes.length === 0 || t > beatTimes[beatTimes.length - 1]) beatTimes.push(t);
  }
  const intervals: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) intervals.push(beatTimes[i] - beatTimes[i - 1]);
  const bpm = intervals.length > 0 ? 60 / median(intervals) : opts.bpm;
  return { beatTimes, bpm };
}
