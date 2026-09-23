/**
 * Deterministic audio synthesis for DSP tests (no Web Audio): plucked-string chords, strums,
 * metronome clicks, noise, silence, mixing, plus drivers that run the FFT / onset / chord
 * detector over a signal at a 40 ms hop.
 */
import type { DetectorFrame, DetectorOpts } from '../../src/types';
import { midiToFreq } from '../../src/music/notes';
import { RealFFT } from '../../src/dsp/fft';
import { OnsetDetector, type OnsetOpts } from '../../src/dsp/onset';
import { ChordDetector } from '../../src/dsp/detector';

/** Seeded PRNG (mulberry32), uniform in [0, 1). */
export function makeRng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

export interface ChordSynthOpts {
  /** Peak level of the result in dBFS (default -20). */
  dbfs?: number;
  /** PRNG seed (default 1). */
  seed?: number;
  /** Per-note start offsets in seconds (same length as midiNotes; default all 0). */
  offsets?: number[];
  /** Number of harmonics per note (default 8, weights 0.7^(h-1)). */
  harmonics?: number;
  /** Duration of the noisy pick attack in seconds (default 0.01). */
  attackNoiseSec?: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Exponential decay time constant per string: 1.5 s for bass (MIDI <= 40) -> 0.6 s for treble (>= 64). */
export function decaySecFor(midi: number): number {
  const t = clamp01((midi - 40) / 24);
  return 1.5 + (0.6 - 1.5) * t;
}

/** Bass strings are louder: +6 dB at MIDI 40 -> 0 dB at MIDI 64 (linear in dB). */
export function stringBoostDb(midi: number): number {
  return 6 * (1 - clamp01((midi - 40) / 24));
}

/**
 * Plucked chord: for each note harmonics 1..8 with weights 0.7^(h-1), each varied by a seeded
 * +-30 %, random phases, exponential decay per string (bass 1.5 s, treble 0.6 s), bass strings
 * up to +6 dB louder and a 10 ms noise burst at every attack. Peak-normalised to `dbfs`.
 */
export function synthChord(midiNotes: number[], sampleRate: number, seconds: number, opts: ChordSynthOpts = {}): Float32Array {
  const dbfs = opts.dbfs ?? -20;
  const rng = makeRng(opts.seed ?? 1);
  const harmonics = opts.harmonics ?? 8;
  const attackNoiseSec = opts.attackNoiseSec ?? 0.01;
  const n = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float64Array(n);
  const env = new Float64Array(n);
  const nyquist = sampleRate / 2;
  for (let i = 0; i < midiNotes.length; i++) {
    const midi = midiNotes[i];
    const f0 = midiToFreq(midi);
    const tau = decaySecFor(midi);
    const gain = dbToLin(stringBoostDb(midi));
    const start = Math.min(n, Math.max(0, Math.round((opts.offsets?.[i] ?? 0) * sampleRate)));
    for (let t = start; t < n; t++) {
      const s = (t - start) / sampleRate;
      env[t] = Math.exp(-s / tau) * Math.min(1, s / 0.002);
    }
    for (let h = 1; h <= harmonics; h++) {
      const fh = f0 * h;
      const amp = gain * Math.pow(0.7, h - 1) * (1 + 0.3 * (2 * rng() - 1));
      const phase = rng() * 2 * Math.PI;
      if (fh >= nyquist) continue;
      const w = (2 * Math.PI * fh) / sampleRate;
      for (let t = start; t < n; t++) out[t] += amp * env[t] * Math.sin(phase + w * (t - start));
    }
    const noiseLen = Math.min(n - start, Math.round(attackNoiseSec * sampleRate));
    for (let k = 0; k < noiseLen; k++) out[start + k] += gain * 0.5 * (2 * rng() - 1) * (1 - k / noiseLen);
  }
  let peak = 0;
  for (let t = 0; t < n; t++) {
    const a = Math.abs(out[t]);
    if (a > peak) peak = a;
  }
  const scale = peak > 0 ? dbToLin(dbfs) / peak : 0;
  const res = new Float32Array(n);
  for (let t = 0; t < n; t++) res[t] = out[t] * scale;
  return res;
}

export interface StrumSynthOpts extends ChordSynthOpts {
  /** Time of the first string attack in seconds (default 0). */
  atSec?: number;
  /** Time between the first and the last string in seconds (default 0.03, low strings first). */
  spreadSec?: number;
}

/** A strummed chord: the notes start one after another over `spreadSec`, beginning at `atSec`. */
export function synthStrum(midiNotes: number[], sampleRate: number, seconds: number, opts: StrumSynthOpts = {}): Float32Array {
  const atSec = opts.atSec ?? 0;
  const spread = opts.spreadSec ?? 0.03;
  const n = midiNotes.length;
  const offsets = midiNotes.map((_, i) => atSec + (n > 1 ? (i * spread) / (n - 1) : 0));
  return synthChord(midiNotes, sampleRate, seconds, { ...opts, offsets });
}

export interface ClickOpts {
  attackSec?: number;
  tau?: number;
  durSec?: number;
  dbfs?: number;
}

/** Metronome click: sine at `freq`, linear attack, exponential decay (tau), peak at `dbfs`. */
export function synthClick(freq: number, sampleRate: number, opts: ClickOpts = {}): Float32Array {
  const attackSec = opts.attackSec ?? 0.003;
  const tau = opts.tau ?? 0.008;
  const durSec = opts.durSec ?? 0.025;
  const amp = dbToLin(opts.dbfs ?? -20);
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let t = 0; t < n; t++) {
    const s = t / sampleRate;
    const env = s < attackSec ? s / attackSec : Math.exp(-(s - attackSec) / tau);
    out[t] = amp * env * Math.sin(w * t);
  }
  return out;
}

export function silence(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}

/** Uniform white noise with the given RMS level in dBFS. */
export function whiteNoise(sampleRate: number, seconds: number, dbfsRms = -30, seed = 7): Float32Array {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const amp = dbToLin(dbfsRms) * Math.sqrt(3); // uniform [-a, a] has RMS a / sqrt(3)
  for (let t = 0; t < n; t++) out[t] = amp * (2 * rng() - 1);
  return out;
}

/** Pure sine at `freq`, peak amplitude `amp`. */
export function sine(freq: number, sampleRate: number, seconds: number, amp = 0.5, phase = 0): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let t = 0; t < n; t++) out[t] = amp * Math.sin(phase + w * t);
  return out;
}

export interface MixPart {
  signal: Float32Array;
  /** Where the signal starts, in seconds. */
  atSec: number;
}

/** Sums the parts at their offsets. Length = `seconds` when given, else the furthest end. */
export function mix(parts: MixPart[], sampleRate: number, seconds?: number): Float32Array {
  let n = seconds !== undefined ? Math.round(seconds * sampleRate) : 0;
  if (seconds === undefined) {
    for (const p of parts) n = Math.max(n, Math.round(p.atSec * sampleRate) + p.signal.length);
  }
  const out = new Float32Array(n);
  for (const p of parts) {
    const start = Math.round(p.atSec * sampleRate);
    const end = Math.min(n, start + p.signal.length);
    for (let t = Math.max(0, start); t < end; t++) out[t] += p.signal[t - start];
  }
  return out;
}

/** Scales a signal by a linear factor (new array). */
export function scaled(signal: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * factor;
  return out;
}

const fftCache = new Map<number, RealFFT>();
function fftFor(size: number): RealFFT {
  let f = fftCache.get(size);
  if (!f) {
    f = new RealFFT(size);
    fftCache.set(size, f);
  }
  return f;
}

/** Hann-windowed magnitudes of the frame ending at sample `endSample` (left-padded with zeros). */
export function magnitudesAt(signal: Float32Array, endSample: number, fftSize = 8192): Float32Array {
  const frame = new Float32Array(fftSize);
  const start = endSample - fftSize;
  for (let i = 0; i < fftSize; i++) {
    const s = start + i;
    frame[i] = s >= 0 && s < signal.length ? signal[s] : 0;
  }
  const mag = new Float32Array((fftSize >> 1) + 1);
  fftFor(fftSize).magnitudes(frame, mag, true);
  return mag;
}

export interface RunOpts {
  /** Hop between analysed frames in seconds (default 0.04). */
  hopSec?: number;
}

/**
 * Runs an OnsetDetector over the signal (frames of fftSize at a 40 ms hop, stamped with the
 * end time of the frame). Returns the timeSec of every accepted onset.
 */
export function runOnsets(
  signal: Float32Array,
  sampleRate: number,
  opts: OnsetOpts & RunOpts & { fftSize?: number } = {},
): number[] {
  const fftSize = opts.fftSize ?? 8192;
  const hop = Math.max(1, Math.round((opts.hopSec ?? 0.04) * sampleRate));
  const det = new OnsetDetector(sampleRate, fftSize, opts);
  const fft = fftFor(fftSize);
  const mag = new Float32Array((fftSize >> 1) + 1);
  const out: number[] = [];
  for (let end = fftSize; end <= signal.length; end += hop) {
    fft.magnitudes(signal.subarray(end - fftSize, end), mag, true);
    const t = end / sampleRate;
    if (det.process(mag, t)) out.push(t);
  }
  return out;
}

/**
 * Runs a ChordDetector over the signal at a 40 ms hop (first frame ends at fftSize samples,
 * timeSec = end sample / sampleRate) and returns every DetectorFrame. Pass `detector` to reuse
 * (and later inspect) an instance.
 */
export function runDetector(
  signal: Float32Array,
  sampleRate: number,
  opts: DetectorOpts & RunOpts = {},
  detector?: ChordDetector,
): DetectorFrame[] {
  const det = detector ?? new ChordDetector(sampleRate, opts);
  const fftSize = det.fftSize;
  const hop = Math.max(1, Math.round((opts.hopSec ?? 0.04) * sampleRate));
  const frames: DetectorFrame[] = [];
  for (let end = fftSize; end <= signal.length; end += hop) {
    frames.push(det.process(signal.subarray(end - fftSize, end), end / sampleRate));
  }
  return frames;
}
