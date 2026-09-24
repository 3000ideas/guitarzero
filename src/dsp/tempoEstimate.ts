/**
 * Global tempo (BPM) and first-beat estimation for a backing track. Pure TypeScript on typed
 * arrays (no Web Audio), testable in Node. See docs/SPEC.md section 11.
 *
 * Pipeline:
 *  1. Block-average decimation of the first `maxSeconds` of audio to about 11025 Hz.
 *  2. Onset envelope: STFT (RealFFT 1024, hop 256, Hann) -> half-wave rectified spectral flux of
 *     log(1 + |X|) -> minus a centred 0.5 s moving average -> rectified.
 *  3. Autocorrelation of the envelope over the lags of the BPM range, weighted by a log-Gaussian
 *     tempo preference centred at 120 BPM (sigma = 0.8 octaves).
 *  4. Weighted peak -> beat period (parabolic interpolation); the x2 and x1/2 candidates inside
 *     the range are compared by weighted score and the best one wins.
 *  5. Phase: the grid offset phi in [0, T) that maximises the comb sum of the envelope
 *     sum_k env(phi + k*T). The period is fine-tuned around the autocorrelation peak with the same
 *     comb criterion, because one hop (~23 ms) is ~4 BPM at 100 BPM and the comb over all beats
 *     resolves the period far better than a 3-point parabola. `firstBeatSec` is the first grid
 *     beat whose local envelope reaches 30 % of the envelope maximum (skips leading silence).
 *  6. Confidence = (peak - mean) / (r[0] - mean) of the autocorrelation over the range, 0..1.
 */
import { RealFFT } from './fft';
import type { TempoEstimate } from '../types';

export interface TempoEstimateOpts {
  /** Slowest tempo considered, BPM (default 60). */
  minBpm?: number;
  /** Fastest tempo considered, BPM (default 200). */
  maxBpm?: number;
  /** Only the first `maxSeconds` of audio are analysed (default 90). */
  maxSeconds?: number;
}

/** Target rate of the decimated signal, Hz. */
export const TEMPO_TARGET_RATE = 11025;
/** STFT frame length and hop, in samples at the decimated rate. */
export const TEMPO_FFT_SIZE = 1024;
export const TEMPO_HOP = 256;
/** Length of the moving average subtracted from the flux, seconds. */
const SMOOTH_SEC = 0.5;
/** Log-Gaussian tempo preference: centre and width (octaves). */
const PREFERRED_BPM = 120;
const PREFERRED_SIGMA_OCTAVES = 0.8;
/** Below this RMS the signal counts as silence. */
const SILENCE_RMS = 1e-4;
/** A grid beat counts as "sounding" when its local envelope reaches this fraction of the maximum. */
const FIRST_BEAT_FRACTION = 0.3;
/** Phase scan resolution, frames. */
const PHASE_STEP = 0.25;
/** Half-width of the fine period search around the autocorrelation peak, frames. */
const FINE_PERIOD_RANGE = 0.5;
/**
 * Time of a frame = (frame start + FRAME_TIME_OFFSET) / rate. The flux of an attack spreads over
 * the two frames in which it slides from the rising edge to the centre of the Hann window, and
 * the comb fit lands on their centroid, slightly past the window centre. Calibrated with
 * synthetic clicks (noise bursts at -6..-24 dBFS over -30..-60 dBFS floors, 80..170 BPM): the
 * first-beat bias stays within +-6 ms.
 */
const FRAME_TIME_OFFSET = 590;

export interface OnsetEnvelope {
  /** Rectified onset strength per frame (>= 0). */
  env: Float32Array;
  /** Frames per second. */
  frameRate: number;
  /** Time in seconds of frame 0; frame n is at frameOffsetSec + n / frameRate. */
  frameOffsetSec: number;
}

function silentEstimate(): TempoEstimate {
  return { bpm: 120, beatPeriodSec: 0.5, firstBeatSec: 0, confidence: 0 };
}

/**
 * Block-average decimation of the first `maxSeconds` of `samples` to about TEMPO_TARGET_RATE
 * (factor = round(sampleRate / 11025), at least 1). Returns the decimated data, its rate and the
 * RMS of the analysed span of the ORIGINAL samples (the averaging would lower a noise floor).
 */
export function decimateForTempo(
  samples: Float32Array,
  sampleRate: number,
  maxSeconds: number,
): { data: Float32Array; rate: number; rms: number } {
  const factor = Math.max(1, Math.round(sampleRate / TEMPO_TARGET_RATE));
  const n = Math.max(0, Math.min(samples.length, Math.floor(maxSeconds * sampleRate)));
  let sq = 0;
  for (let i = 0; i < n; i++) sq += samples[i] * samples[i];
  const rms = n > 0 ? Math.sqrt(sq / n) : 0;
  const m = Math.floor(n / factor);
  const data = new Float32Array(m);
  const inv = 1 / factor;
  for (let i = 0, s = 0; i < m; i++) {
    let acc = 0;
    for (let j = 0; j < factor; j++, s++) acc += samples[s];
    data[i] = acc * inv;
  }
  return { data, rate: sampleRate / factor, rms };
}

/**
 * Onset envelope of a (decimated) signal: spectral flux of log(1 + |X|) over frames of
 * TEMPO_FFT_SIZE at a TEMPO_HOP hop (Hann window, DC bin ignored), minus a centred moving
 * average of SMOOTH_SEC, half-wave rectified. Frame 0 (no predecessor) has flux 0.
 */
export function onsetEnvelope(data: Float32Array, rate: number): OnsetEnvelope {
  const frameRate = rate / TEMPO_HOP;
  const frameOffsetSec = FRAME_TIME_OFFSET / rate;
  const frames = data.length >= TEMPO_FFT_SIZE ? Math.floor((data.length - TEMPO_FFT_SIZE) / TEMPO_HOP) + 1 : 0;
  const env = new Float32Array(frames);
  if (frames === 0) return { env, frameRate, frameOffsetSec };

  const fft = new RealFFT(TEMPO_FFT_SIZE);
  const half = TEMPO_FFT_SIZE >> 1;
  const mag = new Float32Array(half + 1);
  let prev = new Float64Array(half + 1);
  let cur = new Float64Array(half + 1);
  const flux = new Float64Array(frames);
  for (let n = 0; n < frames; n++) {
    const start = n * TEMPO_HOP;
    fft.magnitudes(data.subarray(start, start + TEMPO_FFT_SIZE), mag, true);
    let f = 0;
    for (let k = 1; k <= half; k++) {
      const v = Math.log(1 + mag[k]);
      cur[k] = v;
      const d = v - prev[k];
      if (d > 0) f += d;
    }
    flux[n] = n === 0 ? 0 : f;
    const t = prev;
    prev = cur;
    cur = t;
  }

  const halfWin = Math.max(1, Math.round(0.5 * SMOOTH_SEC * frameRate));
  const cum = new Float64Array(frames + 1);
  for (let n = 0; n < frames; n++) cum[n + 1] = cum[n] + flux[n];
  for (let n = 0; n < frames; n++) {
    const a = Math.max(0, n - halfWin);
    const b = Math.min(frames, n + halfWin + 1);
    const v = flux[n] - (cum[b] - cum[a]) / (b - a);
    env[n] = v > 0 ? v : 0;
  }
  return { env, frameRate, frameOffsetSec };
}

/** r[lag] = mean over the overlap of env[i] * env[i + lag], for lag = 0..maxLag. */
function autocorrelate(env: Float32Array, maxLag: number): Float64Array {
  const n = env.length;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    const m = n - lag;
    if (m <= 0) break;
    let acc = 0;
    for (let i = 0; i < m; i++) acc += env[i] * env[i + lag];
    r[lag] = acc / m;
  }
  return r;
}

/** Log-Gaussian preference around PREFERRED_BPM, 1 at the centre. */
function tempoPreference(bpm: number): number {
  const z = Math.log2(bpm / PREFERRED_BPM) / PREFERRED_SIGMA_OCTAVES;
  return Math.exp(-0.5 * z * z);
}

/** Index of the largest value of `s` within [lo, hi]. */
function argmaxRange(s: ArrayLike<number>, lo: number, hi: number): number {
  let best = lo;
  for (let i = lo + 1; i <= hi; i++) if (s[i] > s[best]) best = i;
  return best;
}

/** Linear interpolation of env at a fractional frame position (0 outside). */
function envAt(env: Float32Array, p: number): number {
  const i = Math.floor(p);
  if (i < 0 || i >= env.length) return 0;
  if (i === env.length - 1) return env[i];
  const f = p - i;
  return env[i] + f * (env[i + 1] - env[i]);
}

/** Comb sum of the envelope over the grid phi + k * period (k >= 0, inside the envelope). */
function combScore(env: Float32Array, period: number, phi: number): number {
  const last = env.length - 1;
  let s = 0;
  for (let p = phi; p <= last; p += period) s += envAt(env, p);
  return s;
}

/** Best phase in [0, period) for a given period, scanned at PHASE_STEP frames. */
function bestPhase(env: Float32Array, period: number): { phi: number; score: number } {
  let phi = 0;
  let score = -Infinity;
  for (let p = 0; p < period; p += PHASE_STEP) {
    const s = combScore(env, period, p);
    if (s > score) {
      score = s;
      phi = p;
    }
  }
  return { phi, score };
}

/**
 * Estimates the tempo and the time of the first beat of an audio signal. Near-silent input
 * (RMS < 1e-4 over the analysed span) or input too short for the BPM range returns
 * { bpm: 120, beatPeriodSec: 0.5, firstBeatSec: 0, confidence: 0 }.
 */
export function estimateTempo(samples: Float32Array, sampleRate: number, opts: TempoEstimateOpts = {}): TempoEstimate {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`estimateTempo: invalid sampleRate ${sampleRate}`);
  }
  let minBpm = Number.isFinite(opts.minBpm) ? Math.max(20, opts.minBpm as number) : 60;
  let maxBpm = Number.isFinite(opts.maxBpm) ? Math.min(400, opts.maxBpm as number) : 200;
  if (!(maxBpm > minBpm)) {
    minBpm = 60;
    maxBpm = 200;
  }
  const maxSeconds = Number.isFinite(opts.maxSeconds) && (opts.maxSeconds as number) > 0 ? (opts.maxSeconds as number) : 90;

  // (1) decimation + silence gate
  const { data, rate, rms } = decimateForTempo(samples, sampleRate, maxSeconds);
  if (rms < SILENCE_RMS) return silentEstimate();

  // (2) onset envelope
  const { env, frameRate, frameOffsetSec } = onsetEnvelope(data, rate);
  const lagMin = Math.max(1, Math.ceil((60 / maxBpm) * frameRate));
  const lagMax = Math.floor((60 / minBpm) * frameRate);
  // Need at least two full periods of the slowest tempo to correlate anything.
  if (lagMax < lagMin || env.length < 2 * lagMax + 2) return silentEstimate();
  let envMax = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > envMax) envMax = env[i];
  if (!(envMax > 0)) return silentEstimate();

  // (3) weighted autocorrelation over the lag range (one extra lag on each side for the parabola)
  const r = autocorrelate(env, lagMax + 1);
  const score = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) score[lag] = r[lag] * tempoPreference((60 * frameRate) / lag);

  // (4) peak, octave candidates, parabolic refinement
  const peak = argmaxRange(score, lagMin, lagMax);
  let best = peak;
  for (const mult of [2, 0.5]) {
    const c = Math.round(peak * mult);
    if (c < lagMin || c > lagMax) continue;
    const w = Math.max(1, Math.round(0.1 * c));
    const l = argmaxRange(score, Math.max(lagMin, c - w), Math.min(lagMax, c + w));
    if (score[l] > score[best]) best = l;
  }
  // Local maximum of the unweighted r next to the weighted pick (the weight is smooth; +-1 lag).
  let l0 = best;
  if (best - 1 >= lagMin && r[best - 1] > r[l0]) l0 = best - 1;
  if (best + 1 <= lagMax && r[best + 1] > r[l0]) l0 = best + 1;
  const ra = r[l0 - 1];
  const rb = r[l0];
  const rc = r[l0 + 1];
  const denom = ra - 2 * rb + rc;
  let delta = denom < 0 ? (0.5 * (ra - rc)) / denom : 0;
  if (delta > 0.5) delta = 0.5;
  else if (delta < -0.5) delta = -0.5;
  const coarsePeriod = l0 + delta;
  const peakValue = Math.max(rb, rb - 0.25 * (ra - rc) * delta);

  // (6) confidence: peak relative to the mean of the range, against the zero-lag maximum
  let mean = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) mean += r[lag];
  mean /= lagMax - lagMin + 1;
  const span = r[0] - mean;
  let confidence = span > 0 ? (peakValue - mean) / span : 0;
  if (!(confidence > 0)) confidence = 0;
  else if (confidence > 1) confidence = 1;

  // (5) phase (and fine period) by the comb criterion
  const periodLo = Math.max(lagMin - 0.5, coarsePeriod - FINE_PERIOD_RANGE);
  const periodHi = Math.min(lagMax + 0.5, coarsePeriod + FINE_PERIOD_RANGE);
  const beats = Math.max(1, Math.floor(env.length / coarsePeriod));
  // The comb sum's main lobe narrows with the number of beats (a drift of one frame over the
  // whole excerpt already misaligns the grid), so the scan step follows 1 / beats.
  const step = Math.max(0.002, Math.min(0.05, 0.4 / beats));
  let period = coarsePeriod;
  let phi = 0;
  let bestScore = -Infinity;
  for (let T = periodLo; T <= periodHi + 1e-9; T += step) {
    const c = bestPhase(env, T);
    if (c.score > bestScore) {
      bestScore = c.score;
      period = T;
      phi = c.phi;
    }
  }
  // Sub-step polish of the phase at the chosen period.
  {
    let bestPhi = phi;
    let s0 = combScore(env, period, phi);
    for (const d of [-0.125, 0.125, -0.0625, 0.0625]) {
      const p = phi + d;
      if (p < 0 || p >= period) continue;
      const s = combScore(env, period, p);
      if (s > s0) {
        s0 = s;
        bestPhi = p;
      }
    }
    phi = bestPhi;
  }

  // First grid beat whose local envelope reaches FIRST_BEAT_FRACTION of the maximum.
  const threshold = FIRST_BEAT_FRACTION * envMax;
  let firstBeatFrame = phi;
  for (let p = phi; p <= env.length - 1; p += period) {
    const c = Math.round(p);
    let local = 0;
    for (let i = Math.max(0, c - 1); i <= Math.min(env.length - 1, c + 1); i++) if (env[i] > local) local = env[i];
    if (local >= threshold) {
      firstBeatFrame = p;
      break;
    }
  }

  const beatPeriodSec = period / frameRate;
  const bpm = Math.round(600 / beatPeriodSec) / 10;
  const firstBeatSec = Math.max(0, frameOffsetSec + firstBeatFrame / frameRate);
  return { bpm, beatPeriodSec, firstBeatSec, confidence };
}
