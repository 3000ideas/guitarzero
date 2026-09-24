/**
 * Automatic chord transcription of a backing track (docs/SPEC.md section 12). Pure TypeScript
 * on typed arrays (no Web Audio), testable in Node.
 *
 * Pipeline:
 *  1. Tempo / first beat (estimateTempo unless given) -> beat grid. By default (opts.trackBeats)
 *     the grid is the beat sequence of trackBeats (dsp/beatTrack.ts, a DP beat tracker seeded
 *     with that tempo), so it follows a tempo that drifts or jumps; the tracked beats are
 *     extended at both ends with their median interval to cover the whole audio. With
 *     trackBeats: false the grid is constant, t_k = firstBeatSec + k * 60/bpm, extended back to
 *     the start of the audio (k may be negative: the estimator reports the first beat it can
 *     see, not always the first beat of the song). Either way near-silent beats are trimmed at
 *     the start (energy < 1 % of the loudest beat) and at the end (a tail below 5 % of the
 *     loudest beat that lasts more than 2 bars).
 *  2. Beat-synchronous chroma: block-average decimation to ~11025 Hz (decimateForTempo), STFT
 *     with RealFFT(4096) at a hop of 1024 (frames centred on n * hop, zero padded at the edges),
 *     computeEnergyChroma per frame; a beat's energy chroma is the mean over the frames whose
 *     centre falls in [t_k, t_k+1), its energy the mean of sum(energyChroma); then compressChroma.
 *  3. Key: the summed energy chroma, compressed, is Pearson-correlated with the 24 rotations of
 *     the Krumhansl-Kessler major / minor profiles. Spanish key names ("Do mayor", "La menor").
 *  4. Vocabulary: 'basic' = 12 x {maj, min}, 'extended' adds {7, m7, maj7}; templates from
 *     templateForPitchClasses. Diatonic chords of the key (major: I ii iii IV V vi + V7; minor:
 *     i III iv v V VI VII + V7) get +0.06, every other chord -0.03.
 *  5. Emission per beat and chord = cosine(beat chroma, template) + bonus. An extra state N (no
 *     chord) emits 0.45 when the beat energy is below 8 % of the median beat energy, else 0.
 *  6. Viterbi over the beats: score = sum(emissions) - sum(change penalties), 0.28 for a chord
 *     change on a beat that is not a bar start and 0.10 on a bar start. The downbeat phase is
 *     unknown, so the sequence is decoded once per phase phi in [0, beatsPerBar) (bar start
 *     <=> k = phi mod beatsPerBar); the phase with the best total score wins,
 *     firstDownbeatSec = t_phi and the beats before phi are dropped. Every phase decodes the
 *     same beats (the pickup beats before phi included), so the totals are comparable.
 *     confidence = mean over beats of (best - second best chord emission), clamped to 0..1.
 *  7. Bars: from phi, groups of beatsPerBar beats with consecutive equal chords merged; a final
 *     incomplete bar is padded with its last chord. With the tracked grid, barTempos[i] =
 *     60 * beatsPerBar / (start of bar i+1 - start of bar i) rounded to 0.1 (the last bar
 *     repeats the previous one) and bpm = median of barTempos.
 *  8. Structure (opts.detectSections, default true): segmentStructure over the bar chroma,
 *     bar energy and bar chord sequences -> sections (absent when it finds a single one).
 */
import type { ChordQuality, ChordTemplate, ChordTranscription, TranscribedBar, TranscribedBeat, TranscribedSection } from '../types';
import { RealFFT } from './fft';
import { compressChroma, computeEnergyChroma, cosine, templateForPitchClasses } from './chroma';
import { decimateForTempo, estimateTempo } from './tempoEstimate';
import { trackBeats } from './beatTrack';
import { NOTE_NAMES_SHARP, chordPitchClasses, makeChordSymbol } from '../music/notes';

export type TranscriptionVocabulary = 'basic' | 'extended';
export type KeyMode = 'major' | 'minor';

export interface TranscribeOpts {
  /** Tempo in BPM; estimated with estimateTempo when missing. */
  bpm?: number;
  /**
   * Seconds into the audio of any beat of the grid (typically TempoEstimate.firstBeatSec);
   * estimated when missing. The grid is extended back to the start of the audio and near-silent
   * leading beats are dropped.
   */
  firstBeatSec?: number;
  /** Beats per bar (default 4). */
  beatsPerBar?: 4 | 3;
  /** 'basic' = 12 x {maj, min} (24 chords); 'extended' adds {7, m7, maj7} (60). Default 'basic'. */
  vocabulary?: TranscriptionVocabulary;
  /** Reference pitch in Hz (default 440). */
  a4?: number;
  /** Progress callback with values 0..1, non-decreasing, reported at most about every 1 %. */
  onProgress?: (p: number) => void;
  /**
   * Follow the beats of the recording with the DP beat tracker (default true): the grid follows
   * tempo drifts and jumps, `barTempos` is filled and `bpm` is the median bar tempo. With false
   * the grid is constant (bpm / firstBeatSec) and `barTempos` is absent.
   */
  trackBeats?: boolean;
  /** Detect the song structure (default true): `sections` when more than one section is found. */
  detectSections?: boolean;
}

/** STFT frame length and hop at the decimated rate (~11025 Hz): 372 ms frames every 93 ms. */
export const TRANSCRIBE_FFT_SIZE = 4096;
export const TRANSCRIBE_HOP = 1024;

/** Krumhansl-Kessler key profiles (index 0 = tonic). */
export const KK_MAJOR: readonly number[] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MINOR: readonly number[] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Emission bonus for chords diatonic to the estimated key, and for the rest. */
export const DIATONIC_BONUS = 0.06;
export const NON_DIATONIC_BONUS = -0.03;
/** Emission of the N (no chord) state on a near-silent beat (energy < 8 % of the median). */
export const NO_CHORD_EMISSION = 0.45;
export const NO_CHORD_ENERGY_FRACTION = 0.08;
/** Chord-change penalties: on a beat inside a bar, and on a bar start. */
export const CHANGE_PENALTY = 0.28;
export const DOWNBEAT_CHANGE_PENALTY = 0.1;

/** Leading beats below this fraction of the loudest beat's energy are dropped. */
const LEADING_SILENCE_FRACTION = 0.01;
/** A trailing run below this fraction of the loudest beat, longer than TRAILING_SILENCE_BARS, is dropped. */
const TRAILING_SILENCE_FRACTION = 0.05;
const TRAILING_SILENCE_BARS = 2;

const BASIC_QUALITIES: readonly ChordQuality[] = ['maj', 'min'];
const EXTENDED_QUALITIES: readonly ChordQuality[] = ['maj', 'min', '7', 'm7', 'maj7'];

/** Diatonic chords as [semitones from the tonic, quality]. */
const MAJOR_DIATONIC: ReadonlyArray<readonly [number, ChordQuality]> = [
  [0, 'maj'], [2, 'min'], [4, 'min'], [5, 'maj'], [7, 'maj'], [9, 'min'], [7, '7'],
];
const MINOR_DIATONIC: ReadonlyArray<readonly [number, ChordQuality]> = [
  [0, 'min'], [3, 'maj'], [5, 'min'], [7, 'min'], [7, 'maj'], [8, 'maj'], [10, 'maj'], [7, '7'],
];

// ---------------------------------------------------------------- key

const SOLFEGE: Record<string, string> = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };

/** Spanish key name with sharps: (0, 'major') -> "Do mayor", (6, 'minor') -> "Fa# menor". */
export function keyNameEs(root: number, mode: KeyMode): string {
  const r = ((Math.round(root) % 12) + 12) % 12;
  const note = NOTE_NAMES_SHARP[r].replace(/^[A-G]/, (letter) => SOLFEGE[letter]);
  return `${note} ${mode === 'major' ? 'mayor' : 'menor'}`;
}

/** Pearson correlation of two 12-bin vectors (0 when either one is constant). */
function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < 12; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (!(saa > 0) || !(sbb > 0)) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Key of a global chroma (12 bins, any scale): the rotation of the Krumhansl-Kessler major or
 * minor profile with the highest Pearson correlation. A null chroma gives C major.
 */
export function estimateKey(globalChroma: ArrayLike<number>): ChordTranscription['key'] {
  let best = -Infinity;
  let root = 0;
  let mode: KeyMode = 'major';
  const rotated = new Float64Array(12);
  for (let r = 0; r < 12; r++) {
    for (const [profile, m] of [[KK_MAJOR, 'major'], [KK_MINOR, 'minor']] as const) {
      for (let pc = 0; pc < 12; pc++) rotated[pc] = profile[(((pc - r) % 12) + 12) % 12];
      const c = pearson(globalChroma, rotated);
      if (c > best) {
        best = c;
        root = r;
        mode = m;
      }
    }
  }
  return { root, mode, name: keyNameEs(root, mode) };
}

/** Keys `${root}:${quality}` of the diatonic chords of a key (major: I ii iii IV V vi V7; minor: i III iv v V VI VII V7). */
export function diatonicChordKeys(key: { root: number; mode: KeyMode }): Set<string> {
  const table = key.mode === 'major' ? MAJOR_DIATONIC : MINOR_DIATONIC;
  const out = new Set<string>();
  for (const [offset, quality] of table) out.add(`${(((key.root + offset) % 12) + 12) % 12}:${quality}`);
  return out;
}

// ---------------------------------------------------------------- vocabulary

/** Chord templates of a vocabulary, sharp names ('F#m'), ordered by quality then root. */
export function buildVocabulary(vocabulary: TranscriptionVocabulary = 'basic'): ChordTemplate[] {
  const qualities = vocabulary === 'extended' ? EXTENDED_QUALITIES : BASIC_QUALITIES;
  const out: ChordTemplate[] = [];
  for (const quality of qualities) {
    for (let root = 0; root < 12; root++) {
      const sym = makeChordSymbol(root, quality);
      out.push(templateForPitchClasses(chordPitchClasses(sym), sym.name, root, quality));
    }
  }
  return out;
}

// ---------------------------------------------------------------- beat features

interface BeatFeatures {
  /** Mean energy chroma per beat, 12 bins each, beat k at [12k, 12k + 12). */
  meanEnergy: Float32Array;
  /** Mean of sum(energyChroma) over the frames of each beat. */
  energy: Float64Array;
}

/**
 * Beat-synchronous energy chroma of the decimated signal: STFT frames (Hann, TRANSCRIBE_FFT_SIZE,
 * hop TRANSCRIBE_HOP) centred on n * hop, zero padded at both ends; each frame goes to the beat
 * k whose interval [edges[k], edges[k + 1]) contains its centre (`edges` has nBeats + 1
 * increasing times). Frames before the grid start are skipped.
 */
function beatFeatures(
  data: Float32Array,
  rate: number,
  edges: Float64Array,
  a4: number,
  progress: (p: number) => void,
): BeatFeatures {
  const nBeats = Math.max(0, edges.length - 1);
  const sum = new Float64Array(nBeats * 12);
  const energyAcc = new Float64Array(nBeats);
  const count = new Int32Array(nBeats);
  const meanEnergy = new Float32Array(nBeats * 12);
  const energy = new Float64Array(nBeats);
  if (nBeats === 0 || data.length === 0) return { meanEnergy, energy };

  const size = TRANSCRIBE_FFT_SIZE;
  const hop = TRANSCRIBE_HOP;
  const half = size >> 1;
  const padded = new Float32Array(data.length + size);
  padded.set(data, half);
  const nFrames = Math.ceil(data.length / hop);
  const fft = new RealFFT(size);
  const mag = new Float32Array(half + 1);
  const chromaOpts = { a4 };
  const ec = new Float32Array(12);
  const reportEvery = Math.max(1, Math.floor(nFrames / 100));

  let k = 0;
  for (let f = 0; f < nFrames; f++) {
    const centreSec = (f * hop) / rate;
    if (centreSec < edges[0]) continue;
    while (k < nBeats && centreSec >= edges[k + 1]) k++;
    if (k >= nBeats) break;
    fft.magnitudes(padded.subarray(f * hop, f * hop + size), mag, true);
    computeEnergyChroma(mag, rate, size, chromaOpts, ec);
    let e = 0;
    const base = k * 12;
    for (let i = 0; i < 12; i++) {
      sum[base + i] += ec[i];
      e += ec[i];
    }
    energyAcc[k] += e;
    count[k]++;
    if (f % reportEvery === 0) progress(f / nFrames);
  }
  for (let b = 0; b < nBeats; b++) {
    const c = count[b];
    if (c === 0) continue;
    energy[b] = energyAcc[b] / c;
    for (let i = 0; i < 12; i++) meanEnergy[b * 12 + i] = sum[b * 12 + i] / c;
  }
  progress(1);
  return { meanEnergy, energy };
}

function medianOf(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const copy = Float64Array.from(values);
  copy.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

// ---------------------------------------------------------------- beat grid

/** Ratio of a beat interval to the median interval beyond which the tracked grid is considered broken. */
const GRID_INTERVAL_MAX_RATIO = 3;

/**
 * Tracked beats extended at both ends with their median interval so that the grid covers the
 * whole audio like the constant grid does: backwards while the new beat is not more than a
 * quarter interval before the audio start (clamped to 0), forwards while the centre of the
 * beat (start + half an interval) is inside the audio. Returns null when the tracked sequence
 * is unusable (fewer than 2 beats or a gap wider than GRID_INTERVAL_MAX_RATIO median
 * intervals).
 */
function extendTrackedGrid(beatTimes: number[], durationSec: number): Float64Array | null {
  if (beatTimes.length < 2) return null;
  const intervals = new Float64Array(beatTimes.length - 1);
  for (let i = 1; i < beatTimes.length; i++) intervals[i - 1] = beatTimes[i] - beatTimes[i - 1];
  const m = medianOf(intervals);
  if (!(m > 0)) return null;
  for (let i = 0; i < intervals.length; i++) if (intervals[i] <= 0 || intervals[i] > GRID_INTERVAL_MAX_RATIO * m) return null;
  const before: number[] = [];
  for (let t = beatTimes[0] - m; t >= -0.25 * m; t -= m) before.push(Math.max(0, t));
  before.reverse();
  const after: number[] = [];
  for (let t = beatTimes[beatTimes.length - 1] + m; t + 0.5 * m < durationSec; t += m) after.push(t);
  return Float64Array.from([...before, ...beatTimes, ...after]);
}

// ---------------------------------------------------------------- decoding

interface ViterbiResult {
  /** Best total score: sum of emissions minus change penalties. */
  score: number;
  /** State index per beat. */
  path: Int32Array;
}

/**
 * Viterbi decoding over `n` beats and `states` states with emissions `emis[k * states + s]`.
 * A change of state into beat k costs `penalty(k)`. Ties prefer staying in the same state.
 */
function viterbi(emis: Float32Array, n: number, states: number, penalty: (k: number) => number): ViterbiResult {
  const path = new Int32Array(n);
  if (n === 0 || states === 0) return { score: 0, path };
  let prev = new Float64Array(states);
  let cur = new Float64Array(states);
  const back = new Int32Array(n * states);
  for (let s = 0; s < states; s++) prev[s] = emis[s];
  for (let k = 1; k < n; k++) {
    // Best and second best previous scores: switching into s comes from the best state != s.
    let b1 = -Infinity;
    let i1 = 0;
    let b2 = -Infinity;
    let i2 = 0;
    for (let s = 0; s < states; s++) {
      const v = prev[s];
      if (v > b1) {
        b2 = b1;
        i2 = i1;
        b1 = v;
        i1 = s;
      } else if (v > b2) {
        b2 = v;
        i2 = s;
      }
    }
    const pen = penalty(k);
    const base = k * states;
    for (let s = 0; s < states; s++) {
      const stay = prev[s];
      const from = s === i1 ? i2 : i1;
      const switched = (s === i1 ? b2 : b1) - pen;
      if (switched > stay) {
        cur[s] = switched + emis[base + s];
        back[base + s] = from;
      } else {
        cur[s] = stay + emis[base + s];
        back[base + s] = s;
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  let best = 0;
  for (let s = 1; s < states; s++) if (prev[s] > prev[best]) best = s;
  path[n - 1] = best;
  for (let k = n - 1; k > 0; k--) path[k - 1] = back[k * states + path[k]];
  return { score: prev[best], path };
}

/** Groups beats into bars of `beatsPerBar`, merging consecutive equal chords; pads the last bar. */
function buildBars(beats: TranscribedBeat[], beatsPerBar: number): TranscribedBar[] {
  const bars: TranscribedBar[] = [];
  for (let start = 0; start < beats.length; start += beatsPerBar) {
    const end = Math.min(beats.length, start + beatsPerBar);
    const chords: TranscribedBar['chords'] = [];
    for (let k = start; k < end; k++) {
      const chord = beats[k].chord;
      const last = chords[chords.length - 1];
      if (last !== undefined && last.chord === chord) last.beats++;
      else chords.push({ chord, beats: 1 });
    }
    const missing = beatsPerBar - (end - start);
    if (missing > 0) chords[chords.length - 1].beats += missing;
    bars.push({ startBeat: start, chords });
  }
  return bars;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Wraps onProgress so that values are clamped, non-decreasing and reported about every 1 %. */
function progressReporter(cb: ((p: number) => void) | undefined): (p: number) => void {
  if (!cb) return () => {};
  let last = -1;
  return (p: number) => {
    const v = clamp01(Number.isFinite(p) ? p : 0);
    if (v <= last) return;
    if (v < 1 && v - last < 0.01) return;
    last = v;
    cb(v);
  };
}

// ---------------------------------------------------------------- main

/**
 * Transcribes the chords of an audio signal (mono samples) beat by beat. See the file header for
 * the pipeline. Never throws for silent or short input (empty `beats` / `bars`, confidence 0);
 * throws RangeError for an invalid sampleRate or invalid numeric options.
 */
export function transcribeChords(samples: Float32Array, sampleRate: number, opts: TranscribeOpts = {}): ChordTranscription {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`transcribeChords: invalid sampleRate ${sampleRate}`);
  }
  if (opts.bpm !== undefined && !(Number.isFinite(opts.bpm) && opts.bpm > 0)) {
    throw new RangeError(`transcribeChords: invalid bpm ${opts.bpm}`);
  }
  if (opts.firstBeatSec !== undefined && !Number.isFinite(opts.firstBeatSec)) {
    throw new RangeError(`transcribeChords: invalid firstBeatSec ${opts.firstBeatSec}`);
  }
  const beatsPerBar = opts.beatsPerBar ?? 4;
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) {
    throw new RangeError(`transcribeChords: invalid beatsPerBar ${beatsPerBar}`);
  }
  const a4 = opts.a4 !== undefined && Number.isFinite(opts.a4) && opts.a4 > 0 ? opts.a4 : 440;
  const progress = progressReporter(opts.onProgress);
  progress(0);

  // 1. Tempo and beat grid.
  let bpm = opts.bpm;
  let firstBeatSec = opts.firstBeatSec;
  if (bpm === undefined || firstBeatSec === undefined) {
    const est = estimateTempo(samples, sampleRate);
    if (bpm === undefined) bpm = est.bpm;
    if (firstBeatSec === undefined) firstBeatSec = est.firstBeatSec;
  }
  progress(0.1);
  const periodSec = 60 / bpm;
  const durationSec = samples.length / sampleRate;
  // Beat times of the grid. Tracked by default (the tracker follows the attacks of the
  // recording); constant when trackBeats is false or the tracker finds nothing usable.
  let times: Float64Array | null = null;
  if (opts.trackBeats ?? true) {
    const tracked = trackBeats(samples, sampleRate, firstBeatSec > 0 ? { bpm, firstBeatSec } : { bpm });
    times = extendTrackedGrid(tracked.beatTimes, durationSec);
  }
  const tracked = times !== null;
  if (times === null) {
    // The grid is anchored on firstBeatSec but extended back to the start of the audio: the
    // tempo estimator reports the first beat it can see, which is not always the first beat of
    // the song (an attack right at sample 0 has no preceding frame). Near-silent leading beats
    // are dropped below, so nothing is lost when the audio really starts later.
    const gridStartSec = Math.max(0, firstBeatSec - Math.floor(firstBeatSec / periodSec) * periodSec);
    // Beats whose centre falls inside the audio.
    const nGrid = Math.max(0, Math.floor((durationSec - gridStartSec) / periodSec + 0.5));
    times = new Float64Array(nGrid);
    for (let k = 0; k < nGrid; k++) times[k] = gridStartSec + k * periodSec;
  }
  const nGrid = times.length;
  // Interval edges: the last beat ends one (median) interval after it starts.
  const edges = new Float64Array(nGrid + 1);
  edges.set(times);
  if (nGrid > 0) {
    let lastInterval = periodSec;
    if (nGrid >= 2) {
      const intervals = new Float64Array(nGrid - 1);
      for (let k = 1; k < nGrid; k++) intervals[k - 1] = times[k] - times[k - 1];
      lastInterval = medianOf(intervals);
    }
    edges[nGrid] = times[nGrid - 1] + lastInterval;
  }
  progress(0.2);

  // 2. Beat-synchronous chroma.
  const { data, rate } = decimateForTempo(samples, sampleRate, Number.POSITIVE_INFINITY);
  const feat = beatFeatures(data, rate, edges, a4, (p) => progress(0.2 + 0.6 * p));
  progress(0.8);

  // Trim near-silent beats at both ends.
  let maxEnergy = 0;
  for (let k = 0; k < nGrid; k++) if (feat.energy[k] > maxEnergy) maxEnergy = feat.energy[k];
  let lead = 0;
  let end = nGrid;
  if (maxEnergy > 0) {
    while (lead < nGrid && feat.energy[lead] < LEADING_SILENCE_FRACTION * maxEnergy) lead++;
    let last = nGrid - 1;
    while (last > lead && feat.energy[last] < TRAILING_SILENCE_FRACTION * maxEnergy) last--;
    if (nGrid - 1 - last > TRAILING_SILENCE_BARS * beatsPerBar) end = last + 1;
  } else {
    lead = nGrid;
  }
  const n = Math.max(0, end - lead);

  // 3. Key from the summed (then compressed) energy chroma of the kept beats.
  const globalEnergy = new Float32Array(12);
  for (let k = lead; k < end; k++) for (let i = 0; i < 12; i++) globalEnergy[i] += feat.meanEnergy[k * 12 + i];
  const key = estimateKey(compressChroma(globalEnergy));

  if (n === 0) {
    progress(1);
    return { bpm, beatsPerBar, firstDownbeatSec: firstBeatSec, key, beats: [], bars: [], confidence: 0 };
  }

  // 4. Vocabulary and diatonic bonus.
  const templates = buildVocabulary(opts.vocabulary ?? 'basic');
  const diatonic = diatonicChordKeys(key);
  const bonus = new Float32Array(templates.length);
  for (let c = 0; c < templates.length; c++) {
    bonus[c] = diatonic.has(`${templates[c].root}:${templates[c].quality}`) ? DIATONIC_BONUS : NON_DIATONIC_BONUS;
  }

  // 5. Emissions (chords + N as the last state).
  const nChords = templates.length;
  const states = nChords + 1;
  const N_STATE = nChords;
  const energy = feat.energy.subarray(lead, end);
  const gate = NO_CHORD_ENERGY_FRACTION * medianOf(energy);
  const emis = new Float32Array(n * states);
  const beatChroma = new Float32Array(n * 12);
  let marginSum = 0;
  for (let k = 0; k < n; k++) {
    const chroma = beatChroma.subarray(k * 12, k * 12 + 12);
    compressChroma(feat.meanEnergy.subarray((lead + k) * 12, (lead + k) * 12 + 12), undefined, chroma);
    const base = k * states;
    let b1 = -Infinity;
    let b2 = -Infinity;
    for (let c = 0; c < nChords; c++) {
      const e = cosine(chroma, templates[c].vector) + bonus[c];
      emis[base + c] = e;
      if (e > b1) {
        b2 = b1;
        b1 = e;
      } else if (e > b2) {
        b2 = e;
      }
    }
    emis[base + N_STATE] = energy[k] <= 0 || energy[k] < gate ? NO_CHORD_EMISSION : 0;
    if (nChords >= 2) marginSum += b1 - b2;
  }
  const confidence = clamp01(marginSum / n);
  progress(0.85);

  // 6. Viterbi once per downbeat phase; the best total score picks the phase.
  let bestPhase = 0;
  let bestScore = -Infinity;
  let bestPath: Int32Array | null = null;
  for (let phi = 0; phi < beatsPerBar && phi < n; phi++) {
    const r = viterbi(emis, n, states, (k) => ((k - phi) % beatsPerBar === 0 ? DOWNBEAT_CHANGE_PENALTY : CHANGE_PENALTY));
    if (r.score > bestScore) {
      bestScore = r.score;
      bestPhase = phi;
      bestPath = r.path;
    }
    progress(0.85 + (0.1 * (phi + 1)) / beatsPerBar);
  }
  const path = bestPath as Int32Array;

  // 7. Beats from the chosen phase, then bars.
  const beats: TranscribedBeat[] = [];
  for (let k = bestPhase; k < n; k++) {
    const s = path[k];
    const base = k * states;
    const score = s === N_STATE ? emis[base + s] : clamp01(emis[base + s] - bonus[s]);
    beats.push({
      timeSec: times[lead + k],
      chord: s === N_STATE ? null : templates[s].name,
      score,
    });
  }
  const bars = buildBars(beats, beatsPerBar);
  const result: ChordTranscription = {
    bpm,
    beatsPerBar,
    firstDownbeatSec: beats[0].timeSec,
    key,
    beats,
    bars,
    confidence,
  };

  // Bar tempos from the tracked grid; the transcription's bpm is their median.
  if (tracked) {
    const barTempos = bars.map((bar, i) => {
      const start = beats[bar.startBeat].timeSec;
      const nextStart = i + 1 < bars.length ? beats[bars[i + 1].startBeat].timeSec : edges[lead + n];
      const nBeatsInBar = i + 1 < bars.length ? beatsPerBar : beats.length - bar.startBeat;
      return (60 * nBeatsInBar) / (nextStart - start);
    });
    if (bars.length >= 2) barTempos[bars.length - 1] = barTempos[bars.length - 2];
    result.barTempos = barTempos.map((v) => Math.round(v * 10) / 10);
    result.bpm = medianOf(result.barTempos);
  }

  // 8. Structure.
  if ((opts.detectSections ?? true) && bars.length >= 2) {
    const barChroma: Float32Array[] = [];
    const barEnergy: number[] = [];
    const barChords: (string | null)[][] = [];
    let maxBarEnergy = 0;
    for (const bar of bars) {
      const first = bestPhase + bar.startBeat;
      const last = Math.min(n, first + beatsPerBar);
      const c = new Float32Array(12);
      let e = 0;
      for (let k = first; k < last; k++) {
        for (let i = 0; i < 12; i++) c[i] += beatChroma[k * 12 + i];
        e += energy[k];
      }
      let norm = 0;
      for (let i = 0; i < 12; i++) norm += c[i] * c[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 12; i++) c[i] /= norm;
      barChroma.push(c);
      e /= Math.max(1, last - first);
      barEnergy.push(e);
      if (e > maxBarEnergy) maxBarEnergy = e;
      const seq: (string | null)[] = [];
      for (const ch of bar.chords) for (let b = 0; b < ch.beats; b++) seq.push(ch.chord);
      barChords.push(seq);
    }
    const barDb = barEnergy.map((e) => (e > 0 && maxBarEnergy > 0 ? Math.max(SILENT_BAR_DB, 10 * Math.log10(e / maxBarEnergy)) : SILENT_BAR_DB));
    const sections = segmentStructure(barChroma, barDb, barChords, beatsPerBar);
    if (sections) result.sections = sections;
  }
  progress(1);
  return result;
}

// ---------------------------------------------------------------- structure

/** Floor of the bar energy in dB relative to the loudest bar. */
const SILENT_BAR_DB = -80;
/** Phrase length in bars: the checkerboard kernel spans this many bars on each side of a boundary and boundaries snap to its multiples. */
export const SECTION_PHRASE_BARS = 4;
/** Self-similarity factor of two bars whose chord sequences differ. */
const CHORD_MISMATCH_FACTOR = 0.7;
/** A novelty peak is a boundary when above mean + PEAK_SIGMA * sigma of the novelty curve ... */
const PEAK_SIGMA = 0.5;
/** ... and above this absolute value (the curve of a song without structure is noise around 0). */
const NOVELTY_FLOOR = 0.15;
/** Minimum distance between boundaries, bars. */
const MIN_BOUNDARY_DISTANCE = 4;
/** A boundary this close (bars) to a multiple of SECTION_PHRASE_BARS snaps to it. */
const SNAP_DISTANCE = 1;
/** Two segments share a letter when the mean self-similarity of their aligned bars reaches this. */
const SAME_LETTER_THRESHOLD = 0.75;

interface Segment {
  start: number;
  /** Exclusive. */
  end: number;
  letter: string;
}

/** Chord sequence of a bar padded / cut to `beatsPerBar` entries (an empty bar is all null). */
function chordSequence(bar: (string | null)[], beatsPerBar: number): (string | null)[] {
  const out = new Array<string | null>(beatsPerBar);
  for (let i = 0; i < beatsPerBar; i++) out[i] = bar.length === 0 ? null : bar[Math.min(i, bar.length - 1)];
  return out;
}

/** S[i][j] = cosine of the bar chroma x (1 when the chord sequences match, CHORD_MISMATCH_FACTOR when not). */
function selfSimilarity(barChroma: Float32Array[], barChords: (string | null)[][], beatsPerBar: number): Float64Array {
  const N = barChroma.length;
  const seqs = barChords.map((b) => chordSequence(b, beatsPerBar));
  const S = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    S[i * N + i] = 1;
    for (let j = i + 1; j < N; j++) {
      let same = true;
      for (let b = 0; b < beatsPerBar && same; b++) if (seqs[i][b] !== seqs[j][b]) same = false;
      const v = cosine(barChroma[i], barChroma[j]) * (same ? 1 : CHORD_MISMATCH_FACTOR);
      S[i * N + j] = v;
      S[j * N + i] = v;
    }
  }
  return S;
}

/**
 * Novelty before bar n (1..N-1), the sum of two checkerboard contrasts of SECTION_PHRASE_BARS
 * bars on each side of n:
 *  - block contrast (Foote): mean similarity inside the blocks before and after n (off-diagonal
 *    pairs) minus the mean similarity across them;
 *  - phrase contrast: the aligned similarity of the phrase before n with the phrase after it
 *    (mean of S[n - L + k][n + k]), subtracted from the best aligned similarity one phrase
 *    earlier or later. A chord progression repeats bar by bar every phrase, so its S is not
 *    block-homogeneous (the chorus shares chords with the verse at misaligned positions): the
 *    phrase contrast peaks exactly where the repetition breaks while the block contrast alone
 *    peaks a couple of bars late.
 * Both terms are about 0 inside a section and up to about 1 at a boundary. Near the edges the
 * blocks are truncated (a short intro of 1..3 bars still produces a peak through the phrase
 * term).
 */
function noveltyCurve(S: Float64Array, N: number): Float64Array {
  const L = SECTION_PHRASE_BARS;
  const at = (i: number, j: number): number => S[i * N + j];
  const aligned = new Float64Array(N + 1).fill(Number.NaN);
  const full = new Array<boolean>(N + 1).fill(false);
  for (let n = 1; n < N; n++) {
    let acc = 0;
    let cnt = 0;
    for (let k = 0; k < L; k++) {
      const i = n - L + k;
      const j = n + k;
      if (i < 0 || j >= N) continue;
      acc += at(i, j);
      cnt++;
    }
    if (cnt > 0) aligned[n] = acc / cnt;
    full[n] = cnt === L;
  }
  const nov = new Float64Array(N);
  for (let n = 1; n < N; n++) {
    // Phrase contrast.
    let ref = Number.NaN;
    for (const m of [n - L, n + L]) {
      if (m < 1 || m >= N || !full[m]) continue;
      if (Number.isNaN(ref) || aligned[m] > ref) ref = aligned[m];
    }
    const phrase = Number.isNaN(ref) || Number.isNaN(aligned[n]) ? 0 : ref - aligned[n];
    // Block contrast.
    const p0 = Math.max(0, n - L);
    const f1 = Math.min(N, n + L);
    let same = 0;
    let sameCnt = 0;
    for (let i = p0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        same += at(i, j);
        sameCnt++;
      }
    }
    for (let i = n; i < f1; i++) {
      for (let j = i + 1; j < f1; j++) {
        same += at(i, j);
        sameCnt++;
      }
    }
    let cross = 0;
    let crossCnt = 0;
    for (let i = p0; i < n; i++) {
      for (let j = n; j < f1; j++) {
        cross += at(i, j);
        crossCnt++;
      }
    }
    // Normalised by the cell counts of a complete kernel (zero padding): a truncated block at
    // the edges weighs less, so a 1..3 bar tail does not look like a section of its own.
    const block = sameCnt > 0 && crossCnt > 0 ? same / (L * (L - 1)) - cross / (L * L) : 0;
    nov[n] = phrase + block;
  }
  return nov;
}

/** Boundaries (bar indices 1..N-1) from the novelty curve: peaks above mean + PEAK_SIGMA sigma and NOVELTY_FLOOR, MIN_BOUNDARY_DISTANCE apart, snapped to phrase multiples. */
function pickBoundaries(nov: Float64Array, N: number): number[] {
  if (N < 3) return [];
  let mean = 0;
  for (let n = 1; n < N; n++) mean += nov[n];
  mean /= N - 1;
  let sq = 0;
  for (let n = 1; n < N; n++) sq += (nov[n] - mean) * (nov[n] - mean);
  const threshold = Math.max(NOVELTY_FLOOR, mean + PEAK_SIGMA * Math.sqrt(sq / (N - 1)));
  // Only the opening section may be shorter than a phrase (intro / pickup bars): a boundary
  // has to leave a full phrase after it.
  const lastBoundary = N - SECTION_PHRASE_BARS;
  const candidates: number[] = [];
  for (let n = 1; n <= lastBoundary; n++) {
    const left = n === 1 ? Number.NEGATIVE_INFINITY : nov[n - 1];
    const right = n === N - 1 ? Number.NEGATIVE_INFINITY : nov[n + 1];
    if (nov[n] >= threshold && nov[n] >= left && nov[n] > right) candidates.push(n);
  }
  candidates.sort((a, b) => nov[b] - nov[a] || a - b);
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p - c) >= MIN_BOUNDARY_DISTANCE)) picked.push(c);
  }
  const snapped = new Set<number>();
  for (const b of picked) {
    const m = Math.round(b / SECTION_PHRASE_BARS) * SECTION_PHRASE_BARS;
    snapped.add(Math.abs(m - b) <= SNAP_DISTANCE && m > 0 && m <= lastBoundary ? m : b);
  }
  return [...snapped].sort((a, b) => a - b);
}

/** Mean self-similarity of the aligned bars of two segments (the shorter against the prefix of the longer). */
function alignedSimilarity(S: Float64Array, N: number, a: Segment, b: Segment): number {
  const len = Math.min(a.end - a.start, b.end - b.start);
  if (len <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < len; k++) acc += S[(a.start + k) * N + (b.start + k)];
  return acc / len;
}

function letterFor(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26) + 1}`;
}

/** Labels per segment following the spec: Estribillo / Estrofa for repeated letters, Intro / Puente / Final for unique ones, else Parte <letra>. */
function labelSegments(segments: Segment[], barEnergy: number[]): string[] {
  const count = new Map<string, number>();
  const energy = new Map<string, { sum: number; n: number }>();
  for (const s of segments) {
    count.set(s.letter, (count.get(s.letter) ?? 0) + 1);
    const e = energy.get(s.letter) ?? { sum: 0, n: 0 };
    for (let i = s.start; i < s.end; i++) {
      e.sum += barEnergy[i];
      e.n++;
    }
    energy.set(s.letter, e);
  }
  const meanEnergy = (letter: string): number => {
    const e = energy.get(letter);
    return e && e.n > 0 ? e.sum / e.n : Number.NEGATIVE_INFINITY;
  };
  const repeated = [...count.entries()].filter(([, c]) => c >= 2).map(([l]) => l);
  const names = new Map<string, string>();
  if (repeated.length >= 2) {
    // The loudest repeated letter is the chorus, the most repeated of the others the verse.
    let chorus = repeated[0];
    for (const l of repeated) if (meanEnergy(l) > meanEnergy(chorus)) chorus = l;
    names.set(chorus, 'Estribillo');
    let verse: string | null = null;
    for (const l of repeated) {
      if (l === chorus) continue;
      if (verse === null || (count.get(l) as number) > (count.get(verse) as number)) verse = l;
    }
    if (verse !== null) names.set(verse, 'Estrofa');
  } else if (repeated.length === 1) {
    // A single repeated part is the verse: a chorus only exists in contrast with one.
    names.set(repeated[0], 'Estrofa');
  }
  const labels = new Array<string>(segments.length);
  const isRepeated = (s: Segment): boolean => (count.get(s.letter) ?? 0) >= 2;
  let firstRepeated = -1;
  let lastRepeated = -1;
  segments.forEach((s, i) => {
    if (!isRepeated(s)) return;
    if (firstRepeated < 0) firstRepeated = i;
    lastRepeated = i;
  });
  let introDone = false;
  let bridgeDone = false;
  let finalIndex = -1;
  if (firstRepeated >= 0) {
    finalIndex = segments.length - 1;
    if (finalIndex <= lastRepeated) finalIndex = -1;
  } else if (segments.length >= 2) {
    // No repetition at all: a short opening part is the intro, a short closing part the final.
    const first = segments[0];
    const second = segments[1];
    if (first.end - first.start < second.end - second.start) {
      labels[0] = 'Intro';
      introDone = true;
    }
    const last = segments[segments.length - 1];
    const prev = segments[segments.length - 2];
    if (last.end - last.start < prev.end - prev.start) finalIndex = segments.length - 1;
  }
  segments.forEach((s, i) => {
    if (labels[i] !== undefined) return;
    const named = names.get(s.letter);
    if (named !== undefined) {
      labels[i] = named;
      return;
    }
    if (isRepeated(s)) {
      labels[i] = `Parte ${s.letter}`;
      return;
    }
    if (firstRepeated >= 0 && i < firstRepeated && !introDone) {
      labels[i] = 'Intro';
      introDone = true;
      return;
    }
    if (i === finalIndex) {
      labels[i] = 'Final';
      return;
    }
    if (firstRepeated >= 0 && i > firstRepeated && i < lastRepeated && !bridgeDone) {
      labels[i] = 'Puente';
      bridgeDone = true;
      return;
    }
    labels[i] = `Parte ${s.letter}`;
  });
  return labels;
}

/**
 * Song structure from bar features (docs/SPEC.md section 15): `barChroma[i]` is the mean chroma
 * of bar i (any scale), `barEnergy[i]` its mean energy in dB relative to the loudest bar,
 * `barChords[i]` its chord per beat (merged chords repeated by their duration are fine: the
 * sequence is padded / cut to `beatsPerBar`). Self-similarity = chroma cosine x (1 when the
 * chord sequences match, 0.7 when not); novelty from a checkerboard of 4 bars (see
 * noveltyCurve); peaks above mean + 0.5 sigma (and an absolute floor), at least 4 bars apart,
 * snapped to the nearest multiple of 4 bars when within 1 bar (the first bars may form a short
 * intro of 1..3 bars); segments share a letter (A, B, C... by first appearance) when the mean
 * similarity of their aligned bars reaches 0.75; the loudest repeated letter is 'Estribillo',
 * the most repeated other one 'Estrofa', a unique segment before the first repeated one
 * 'Intro', in the middle 'Puente', at the end 'Final', anything else 'Parte <letra>'. Returns
 * undefined when a single section covers everything.
 */
export function segmentStructure(
  barChroma: Float32Array[],
  barEnergy: number[],
  barChords: (string | null)[][],
  beatsPerBar: number,
): TranscribedSection[] | undefined {
  const N = barChroma.length;
  if (barEnergy.length !== N || barChords.length !== N) {
    throw new RangeError('segmentStructure: barChroma, barEnergy and barChords must have the same length');
  }
  const bpb = Number.isInteger(beatsPerBar) && beatsPerBar >= 1 ? beatsPerBar : 4;
  if (N < 2) return undefined;
  const S = selfSimilarity(barChroma, barChords, bpb);
  const boundaries = pickBoundaries(noveltyCurve(S, N), N);
  if (boundaries.length === 0) return undefined;
  const segments: Segment[] = [];
  let start = 0;
  for (const b of [...boundaries, N]) {
    if (b <= start) continue;
    segments.push({ start, end: b, letter: '' });
    start = b;
  }
  if (segments.length < 2) return undefined;
  let letters = 0;
  for (const s of segments) {
    let found: string | null = null;
    for (const e of segments) {
      if (e === s) break;
      if (alignedSimilarity(S, N, s, e) >= SAME_LETTER_THRESHOLD) {
        found = e.letter;
        break;
      }
    }
    s.letter = found ?? letterFor(letters++);
  }
  const labels = labelSegments(segments, barEnergy);
  return segments.map((s, i) => ({ startBar: s.start, endBar: s.end - 1, label: labels[i], letter: s.letter }));
}
