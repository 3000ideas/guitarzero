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
import { CHORD_LIBRARY, shapeMidiNotes } from '../../src/music/chords';

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
  /**
   * Multiplies every string's decay time constant (default 1: bass 1.5 s, treble 0.6 s). A real
   * acoustic guitar sustains longer than the default model: 2..3 gives bass strings ringing
   * with a 3..4.5 s time constant.
   */
  decayScale?: number;
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
  const decayScale = opts.decayScale !== undefined && opts.decayScale > 0 ? opts.decayScale : 1;
  const n = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float64Array(n);
  const env = new Float64Array(n);
  const nyquist = sampleRate / 2;
  for (let i = 0; i < midiNotes.length; i++) {
    const midi = midiNotes[i];
    const f0 = midiToFreq(midi);
    const tau = decaySecFor(midi) * decayScale;
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

export interface StrumSequenceOpts extends Omit<StrumSynthOpts, 'atSec' | 'dbfs' | 'seed'> {
  /** Peak level of each strum in dBFS: one value for all or one per strum (default -20). */
  dbfs?: number | number[];
  /**
   * Re-striking a string stops its old vibration: the previous strum is faded out over this many
   * seconds right before the next attack (default 0.015). 0 keeps a purely additive mix.
   */
  dampSec?: number;
  /** Seed of the first strum; strum i uses seed + i (default 1). */
  seed?: number;
}

/**
 * A sequence of re-struck strums: strum i (notes `chords[i]`) starts at `times[i]` and rings until
 * the next one (the last until `totalSec`), damped over `dampSec` before the next attack so the
 * chords do not pile up as a purely additive mix would. Returns `totalSec` seconds of signal.
 */
export function synthStrumSequence(
  chords: number[][],
  sampleRate: number,
  times: number[],
  totalSec: number,
  opts: StrumSequenceOpts = {},
): Float32Array {
  if (chords.length === 0 || times.length !== chords.length) throw new Error('chords and times must have the same length');
  const dampSec = opts.dampSec ?? 0.015;
  const seed = opts.seed ?? 1;
  const strumOpts: StrumSynthOpts = {};
  if (opts.offsets !== undefined) strumOpts.offsets = opts.offsets;
  if (opts.harmonics !== undefined) strumOpts.harmonics = opts.harmonics;
  if (opts.attackNoiseSec !== undefined) strumOpts.attackNoiseSec = opts.attackNoiseSec;
  if (opts.decayScale !== undefined) strumOpts.decayScale = opts.decayScale;
  if (opts.spreadSec !== undefined) strumOpts.spreadSec = opts.spreadSec;
  const parts: MixPart[] = times.map((atSec, i) => {
    const end = i + 1 < times.length ? times[i + 1] : totalSec;
    const len = Math.max(0, end - atSec);
    const level = Array.isArray(opts.dbfs) ? (opts.dbfs[i] ?? opts.dbfs[opts.dbfs.length - 1] ?? -20) : (opts.dbfs ?? -20);
    const s = synthStrum(chords[i], sampleRate, len, { ...strumOpts, dbfs: level, seed: seed + i });
    if (i + 1 < times.length && dampSec > 0) {
      const damp = Math.min(s.length, Math.round(dampSec * sampleRate));
      for (let k = 0; k < damp; k++) s[s.length - 1 - k] *= k / damp;
    }
    return { signal: s, atSec };
  });
  return mix(parts, sampleRate, totalSec);
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

// ---------------------------------------------------------------- chord progressions

export interface ProgressionOpts {
  /** Tempo in BPM (default 100). */
  bpm?: number;
  /** Beats each chord lasts, one strum per beat (default 4). */
  beatsPerChord?: number;
  /** Times the whole progression is played (default 1). */
  rounds?: number;
  /** Silence before the first strum, seconds (default 0). */
  leadSec?: number;
  /** Extra seconds after the last beat where the last chord keeps ringing (default 0). */
  tailSec?: number;
  /** RMS of a white-noise floor in dBFS, or null for none (default -40). */
  noiseDb?: number | null;
  /** Peak level of every strum in dBFS (default -20). */
  dbfs?: number;
  /** Seed of the first strum (default 1); the noise uses seed + 1000. */
  seed?: number;
  /** MIDI notes per chord name; names missing here use the CHORD_LIBRARY voicing. */
  voicings?: Record<string, number[]>;
  /** Passed to synthStrumSequence. */
  dampSec?: number;
  spreadSec?: number;
  decayScale?: number;
  harmonics?: number;
}

export interface Progression {
  signal: Float32Array;
  /** Beat period in seconds (60 / bpm). */
  periodSec: number;
  /** Start time of every beat (= strum), seconds. */
  beatTimes: number[];
  /** Chord name sounding at every beat. */
  beatChords: string[];
}

/** MIDI notes of the CHORD_LIBRARY voicing of a chord name (throws when the library lacks it). */
export function libraryVoicing(name: string): number[] {
  const shape = CHORD_LIBRARY.find((s) => s.name === name);
  if (!shape) throw new Error(`no library voicing for ${name}`);
  return shapeMidiNotes(shape);
}

/**
 * A strummed chord progression: every chord of `chords` is strummed once per beat for
 * `beatsPerChord` beats at `bpm`, `rounds` times, after `leadSec` of silence, over a white-noise
 * floor. Returns the signal with the beat grid and the expected chord per beat.
 */
export function synthProgression(chords: string[], sampleRate: number, opts: ProgressionOpts = {}): Progression {
  const bpm = opts.bpm ?? 100;
  const periodSec = 60 / bpm;
  const beatsPerChord = opts.beatsPerChord ?? 4;
  const rounds = opts.rounds ?? 1;
  const leadSec = opts.leadSec ?? 0;
  const tailSec = opts.tailSec ?? 0;
  const seed = opts.seed ?? 1;
  const beatChords: string[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const name of chords) for (let b = 0; b < beatsPerChord; b++) beatChords.push(name);
  }
  const beatTimes = beatChords.map((_, i) => leadSec + i * periodSec);
  const totalSec = leadSec + beatChords.length * periodSec + tailSec;
  const notes = beatChords.map((name) => opts.voicings?.[name] ?? libraryVoicing(name));
  const seqOpts: StrumSequenceOpts = { dbfs: opts.dbfs ?? -20, seed };
  if (opts.dampSec !== undefined) seqOpts.dampSec = opts.dampSec;
  if (opts.spreadSec !== undefined) seqOpts.spreadSec = opts.spreadSec;
  if (opts.decayScale !== undefined) seqOpts.decayScale = opts.decayScale;
  if (opts.harmonics !== undefined) seqOpts.harmonics = opts.harmonics;
  let signal = synthStrumSequence(notes, sampleRate, beatTimes, totalSec, seqOpts);
  const noiseDb = opts.noiseDb === undefined ? -40 : opts.noiseDb;
  if (noiseDb !== null) {
    signal = mix(
      [
        { signal, atSec: 0 },
        { signal: whiteNoise(sampleRate, totalSec, noiseDb, seed + 1000), atSec: 0 },
      ],
      sampleRate,
      totalSec,
    );
  }
  return { signal, periodSec, beatTimes, beatChords };
}

/** Repeats a signal `times` times back to back (new array). */
export function tileSignal(signal: Float32Array, times: number): Float32Array {
  const out = new Float32Array(signal.length * Math.max(0, times));
  for (let i = 0; i < times; i++) out.set(signal, i * signal.length);
  return out;
}

// ---------------------------------------------------------------- strummed progressions (SPEC section 14)

/** A strum character of the song grammar that produces an attack ('-' is a rest). */
export type StrumChar = 'D' | 'U' | 'x';

export interface StrummedProgressionOpts {
  /** Strum pattern in the song grammar ([DUx-]), `beatsPerBar` x 1, 2 or 4 characters long. */
  pattern: string;
  /** Tempo in BPM (default 100). */
  bpm?: number;
  /** Beats per bar (default 4); with `pattern.length` it fixes the characters per beat. */
  beatsPerBar?: number;
  /** Bars each chord lasts (default 1). */
  barsPerChord?: number;
  /** Times the whole progression is played (default 1). */
  rounds?: number;
  /** Silence before the first bar, seconds (default 0). */
  leadSec?: number;
  /** Extra seconds after the last bar where the last strum keeps ringing (default 0). */
  tailSec?: number;
  /** RMS of a white-noise floor in dBFS, or null for none (default -40). */
  noiseDb?: number | null;
  /** Peak level of a down-strum in dBFS (default -20). */
  dbfs?: number;
  /** Up-strums are this many dB quieter than down-strums (default 3). */
  accentDb?: number;
  /** Delay between consecutive strings of one strum, seconds (default 0.008). */
  staggerSec?: number;
  /** Seed of the first strum (strum i uses seed + i); the noise uses seed + 1000 (default 1). */
  seed?: number;
  /** MIDI notes per chord name; names missing here use the CHORD_LIBRARY voicing. */
  voicings?: Record<string, number[]>;
  /** Fade-out of the ringing chord right before the next attack, seconds (default 0.015). */
  dampSec?: number;
  /** Passed to synthChord (default 1; muted 'x' strums always use 0.03). */
  decayScale?: number;
  harmonics?: number;
}

export interface StrummedStrum {
  /** Time of the first string attack, seconds. */
  timeSec: number;
  dir: StrumChar;
  chord: string;
  /** Bar index (0-based) and slot index within the pattern. */
  bar: number;
  slot: number;
}

export interface StrummedProgression {
  signal: Float32Array;
  /** Beat period in seconds (60 / bpm). */
  periodSec: number;
  /** Bar length in seconds. */
  barSec: number;
  beatsPerBar: number;
  charsPerBeat: number;
  pattern: string;
  /** Start time of every bar (= its first slot), seconds. */
  barTimes: number[];
  /** Chord name of every bar. */
  barChords: string[];
  /** Every strum in time order. */
  strums: StrummedStrum[];
}

/**
 * A chord progression strummed with a fixed pattern: every chord of `chords` lasts
 * `barsPerChord` bars and the bar is strummed ONLY on the D/U/x slots of `pattern` (each slot =
 * 1 / charsPerBeat beat). Every strum is a fresh chord attack (10 ms pick noise) with the six
 * strings staggered `staggerSec` (8 ms) apart: down-strums sweep from the low strings, up-strums
 * from the high ones and are `accentDb` (3 dB) quieter; 'x' is a heavily damped (muted) strum.
 * The chord rings until the next strum (damped over `dampSec` right before it) and the whole
 * thing sits on a seeded white-noise floor. Returns the signal with the bar grid and the strums.
 */
export function synthStrummedProgression(
  chords: string[],
  sampleRate: number,
  opts: StrummedProgressionOpts,
): StrummedProgression {
  const pattern = opts.pattern;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  if (!/^[DUx-]+$/.test(pattern)) throw new Error(`invalid strum pattern "${pattern}"`);
  const charsPerBeat = pattern.length / beatsPerBar;
  if (charsPerBeat !== 1 && charsPerBeat !== 2 && charsPerBeat !== 4) {
    throw new Error(`pattern of ${pattern.length} chars does not fit ${beatsPerBar} beats per bar`);
  }
  const bpm = opts.bpm ?? 100;
  const periodSec = 60 / bpm;
  const barSec = periodSec * beatsPerBar;
  const slotSec = periodSec / charsPerBeat;
  const barsPerChord = opts.barsPerChord ?? 1;
  const rounds = opts.rounds ?? 1;
  const leadSec = opts.leadSec ?? 0;
  const tailSec = opts.tailSec ?? 0;
  const seed = opts.seed ?? 1;
  const dbfs = opts.dbfs ?? -20;
  const accentDb = opts.accentDb ?? 3;
  const staggerSec = opts.staggerSec ?? 0.008;
  const dampSec = opts.dampSec ?? 0.015;

  const barChords: string[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const name of chords) for (let b = 0; b < barsPerChord; b++) barChords.push(name);
  }
  const barTimes = barChords.map((_, i) => leadSec + i * barSec);
  const totalSec = leadSec + barChords.length * barSec + tailSec;

  const strums: StrummedStrum[] = [];
  barChords.forEach((chord, bar) => {
    for (let slot = 0; slot < pattern.length; slot++) {
      const c = pattern[slot];
      if (c === '-') continue;
      strums.push({ timeSec: barTimes[bar] + slot * slotSec, dir: c as StrumChar, chord, bar, slot });
    }
  });

  const parts: MixPart[] = [];
  strums.forEach((s, i) => {
    const end = i + 1 < strums.length ? strums[i + 1].timeSec : totalSec;
    const len = Math.max(0, end - s.timeSec);
    const notes = opts.voicings?.[s.chord] ?? libraryVoicing(s.chord);
    // Down-strums sweep from the low strings, up-strums from the high ones.
    const order = s.dir === 'U' ? [...notes].reverse() : notes;
    const chordOpts: ChordSynthOpts = {
      dbfs: s.dir === 'U' ? dbfs - accentDb : dbfs,
      seed: seed + i,
      offsets: order.map((_, j) => j * staggerSec),
      decayScale: s.dir === 'x' ? 0.03 : (opts.decayScale ?? 1),
    };
    if (opts.harmonics !== undefined) chordOpts.harmonics = opts.harmonics;
    const sig = synthChord(order, sampleRate, len, chordOpts);
    if (i + 1 < strums.length && dampSec > 0) {
      const damp = Math.min(sig.length, Math.round(dampSec * sampleRate));
      for (let k = 0; k < damp; k++) sig[sig.length - 1 - k] *= k / damp;
    }
    parts.push({ signal: sig, atSec: s.timeSec });
  });
  const noiseDb = opts.noiseDb === undefined ? -40 : opts.noiseDb;
  if (noiseDb !== null) parts.push({ signal: whiteNoise(sampleRate, totalSec, noiseDb, seed + 1000), atSec: 0 });
  const signal = mix(parts, sampleRate, totalSec);
  return { signal, periodSec, barSec, beatsPerBar, charsPerBeat, pattern, barTimes, barChords, strums };
}

// ---------------------------------------------------------------- click tracks with a tempo map (SPEC section 15)

/**
 * Percussive click: a short burst of white noise with a 1 ms linear attack and an exponential
 * decay (tau), peak at `dbfs`. A drum hit is broadband, unlike synthClick (a sine).
 */
export function noiseBurst(
  sampleRate: number,
  rng: () => number,
  opts: { durSec?: number; tau?: number; dbfs?: number } = {},
): Float32Array {
  const durSec = opts.durSec ?? 0.04;
  const tau = opts.tau ?? 0.008;
  const amp = dbToLin(opts.dbfs ?? -12);
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const s = t / sampleRate;
    const env = Math.min(1, s / 0.001) * Math.exp(-s / tau);
    out[t] = amp * env * (2 * rng() - 1);
  }
  return out;
}

/**
 * Beat times of a tempo ramp: the tempo goes linearly from `bpmFrom` (at `fromSec`) to `bpmTo`
 * (at `toSec`); every beat lasts 60 / bpm(t) seconds at the tempo in force when it starts.
 */
export function rampBeatTimes(bpmFrom: number, bpmTo: number, fromSec: number, toSec: number): number[] {
  const times: number[] = [];
  const span = Math.max(1e-9, toSec - fromSec);
  for (let t = fromSec; t < toSec; ) {
    times.push(t);
    const bpm = bpmFrom + ((bpmTo - bpmFrom) * (t - fromSec)) / span;
    t += 60 / bpm;
  }
  return times;
}

/**
 * Beat times of a tempo jump: `bpmA` from `fromSec`, then `bpmB` from the first beat at or after
 * `jumpSec` (the phase is continuous: the beat period changes, the grid does not restart).
 */
export function jumpBeatTimes(bpmA: number, bpmB: number, fromSec: number, jumpSec: number, toSec: number): number[] {
  const times: number[] = [];
  for (let t = fromSec; t < toSec; ) {
    times.push(t);
    t += 60 / (t >= jumpSec ? bpmB : bpmA);
  }
  return times;
}

export interface ClickTrackOpts {
  /** Level of the clicks in dBFS (default -12), each varied by +-`jitterDb`. */
  dbfs?: number;
  /** Random level variation of every click in dB (default 3). */
  jitterDb?: number;
  /** RMS of the noise floor in dBFS, or null for none (default -40). */
  noiseDb?: number | null;
  seed?: number;
}

/** Percussive clicks (noiseBurst) at `beatTimes` over a white-noise floor; `seconds` long. */
export function synthClickTrack(beatTimes: number[], sampleRate: number, seconds: number, opts: ClickTrackOpts = {}): Float32Array {
  const seed = opts.seed ?? 11;
  const rng = makeRng(seed);
  const jitter = opts.jitterDb ?? 3;
  const parts: MixPart[] = [];
  const noiseDb = opts.noiseDb === undefined ? -40 : opts.noiseDb;
  if (noiseDb !== null) parts.push({ signal: whiteNoise(sampleRate, seconds, noiseDb, seed + 100), atSec: 0 });
  for (const t of beatTimes) {
    if (t < 0 || t >= seconds) continue;
    const dbfs = (opts.dbfs ?? -12) + jitter * (2 * rng() - 1);
    parts.push({ signal: noiseBurst(sampleRate, rng, { dbfs }), atSec: t });
  }
  return mix(parts, sampleRate, seconds);
}

// ---------------------------------------------------------------- structured songs (SPEC section 15)

export interface SongSectionSpec {
  /** Chord names of the progression, one per `barsPerChord` bars. */
  chords: string[];
  /** Bars each chord lasts (default 1). */
  barsPerChord?: number;
  /** Times the progression is played in this section (default 1). */
  rounds?: number;
  /** Peak level of the strums of this section in dBFS (default: the song's `dbfs`, -20). */
  dbfs?: number;
}

export interface StructuredSongOpts {
  /** Tempo in BPM (default 100). */
  bpm?: number;
  /** Beats per bar (default 4); one strum per beat. */
  beatsPerBar?: number;
  /** Silence before the first bar, seconds (default 0). */
  leadSec?: number;
  /** Extra seconds after the last bar where the last chord keeps ringing (default 0). */
  tailSec?: number;
  /** RMS of a white-noise floor in dBFS, or null for none (default -40). */
  noiseDb?: number | null;
  /** Default peak level of a strum in dBFS (default -20). */
  dbfs?: number;
  /** Seed of the first strum (strum i uses seed + i); the noise uses seed + 1000 (default 1). */
  seed?: number;
  /** MIDI notes per chord name; names missing here use the CHORD_LIBRARY voicing. */
  voicings?: Record<string, number[]>;
  /** Passed to synthStrumSequence. */
  dampSec?: number;
  spreadSec?: number;
  decayScale?: number;
  harmonics?: number;
}

export interface StructuredSong {
  signal: Float32Array;
  bpm: number;
  periodSec: number;
  barSec: number;
  beatsPerBar: number;
  /** Start time of every beat (= strum), seconds. */
  beatTimes: number[];
  /** Chord name sounding at every beat. */
  beatChords: string[];
  /** Start time of every bar, seconds. */
  barTimes: number[];
  /** Chord name of every bar. */
  barChords: string[];
  /** Index of the section every bar belongs to. */
  barSection: number[];
  /** Bar index where every section starts, and its length in bars. */
  sectionStarts: number[];
  sectionBars: number[];
}

/**
 * A song made of consecutive sections, each a chord progression strummed once per beat at
 * `bpm`, `rounds` times, at its own level (a louder chorus, a quieter intro). Every strum is a
 * fresh chord attack (synthStrumSequence: the previous chord is damped right before it) and the
 * whole thing sits on a seeded white-noise floor. Returns the signal with the beat / bar grids,
 * the expected chord per beat and bar and the section boundaries in bars.
 */
export function synthStructuredSong(sections: SongSectionSpec[], sampleRate: number, opts: StructuredSongOpts = {}): StructuredSong {
  const bpm = opts.bpm ?? 100;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const periodSec = 60 / bpm;
  const barSec = periodSec * beatsPerBar;
  const leadSec = opts.leadSec ?? 0;
  const tailSec = opts.tailSec ?? 0;
  const seed = opts.seed ?? 1;
  const defaultDb = opts.dbfs ?? -20;

  const barChords: string[] = [];
  const barSection: number[] = [];
  const sectionStarts: number[] = [];
  const sectionBars: number[] = [];
  const barLevels: number[] = [];
  sections.forEach((sec, si) => {
    const barsPerChord = sec.barsPerChord ?? 1;
    const rounds = sec.rounds ?? 1;
    sectionStarts.push(barChords.length);
    for (let r = 0; r < rounds; r++) {
      for (const name of sec.chords) {
        for (let b = 0; b < barsPerChord; b++) {
          barChords.push(name);
          barSection.push(si);
          barLevels.push(sec.dbfs ?? defaultDb);
        }
      }
    }
    sectionBars.push(barChords.length - sectionStarts[si]);
  });
  const barTimes = barChords.map((_, i) => leadSec + i * barSec);
  const beatChords: string[] = [];
  const beatLevels: number[] = [];
  barChords.forEach((name, i) => {
    for (let b = 0; b < beatsPerBar; b++) {
      beatChords.push(name);
      beatLevels.push(barLevels[i]);
    }
  });
  const beatTimes = beatChords.map((_, i) => leadSec + i * periodSec);
  const totalSec = leadSec + beatChords.length * periodSec + tailSec;
  const notes = beatChords.map((name) => opts.voicings?.[name] ?? libraryVoicing(name));
  const seqOpts: StrumSequenceOpts = { dbfs: beatLevels, seed };
  if (opts.dampSec !== undefined) seqOpts.dampSec = opts.dampSec;
  if (opts.spreadSec !== undefined) seqOpts.spreadSec = opts.spreadSec;
  if (opts.decayScale !== undefined) seqOpts.decayScale = opts.decayScale;
  if (opts.harmonics !== undefined) seqOpts.harmonics = opts.harmonics;
  let signal = beatChords.length > 0 ? synthStrumSequence(notes, sampleRate, beatTimes, totalSec, seqOpts) : silence(sampleRate, totalSec);
  const noiseDb = opts.noiseDb === undefined ? -40 : opts.noiseDb;
  if (noiseDb !== null) {
    signal = mix(
      [
        { signal, atSec: 0 },
        { signal: whiteNoise(sampleRate, totalSec, noiseDb, seed + 1000), atSec: 0 },
      ],
      sampleRate,
      totalSec,
    );
  }
  return { signal, bpm, periodSec, barSec, beatsPerBar, beatTimes, beatChords, barTimes, barChords, barSection, sectionStarts, sectionBars };
}
