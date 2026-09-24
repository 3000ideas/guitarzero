/**
 * Automatic chord transcription of a backing track (docs/SPEC.md section 12). Pure TypeScript
 * on typed arrays (no Web Audio), testable in Node.
 *
 * Pipeline:
 *  1. Tempo / first beat (estimateTempo unless given) -> beat grid t_k = firstBeatSec + k * 60/bpm,
 *     extended back to the start of the audio (k may be negative: the estimator reports the
 *     first beat it can see, not always the first beat of the song). Near-silent beats are
 *     trimmed at the start (energy < 1 % of the loudest beat) and at the end (a tail below 5 %
 *     of the loudest beat that lasts more than 2 bars).
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
 *     incomplete bar is padded with its last chord.
 */
import type { ChordQuality, ChordTemplate, ChordTranscription, TranscribedBar, TranscribedBeat } from '../types';
import { RealFFT } from './fft';
import { compressChroma, computeEnergyChroma, cosine, templateForPitchClasses } from './chroma';
import { decimateForTempo, estimateTempo } from './tempoEstimate';
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
 * whose interval [t_k, t_k+1) contains its centre. Frames before the grid start are skipped.
 */
function beatFeatures(
  data: Float32Array,
  rate: number,
  gridStartSec: number,
  periodSec: number,
  nBeats: number,
  a4: number,
  progress: (p: number) => void,
): BeatFeatures {
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

  for (let f = 0; f < nFrames; f++) {
    const centreSec = (f * hop) / rate;
    const k = Math.floor((centreSec - gridStartSec) / periodSec);
    if (k < 0) continue;
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
  for (let k = 0; k < nBeats; k++) {
    const c = count[k];
    if (c === 0) continue;
    energy[k] = energyAcc[k] / c;
    for (let i = 0; i < 12; i++) meanEnergy[k * 12 + i] = sum[k * 12 + i] / c;
  }
  progress(1);
  return { meanEnergy, energy };
}

function medianOf(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  const copy = values.slice();
  copy.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
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
  progress(0.15);
  const periodSec = 60 / bpm;
  const durationSec = samples.length / sampleRate;
  // The grid is anchored on firstBeatSec but extended back to the start of the audio: the tempo
  // estimator reports the first beat it can see, which is not always the first beat of the song
  // (an attack right at sample 0 has no preceding frame). Near-silent leading beats are dropped
  // below, so nothing is lost when the audio really starts later.
  const gridStartSec = Math.max(0, firstBeatSec - Math.floor(firstBeatSec / periodSec) * periodSec);
  // Beats whose centre falls inside the audio.
  const nGrid = Math.max(0, Math.floor((durationSec - gridStartSec) / periodSec + 0.5));

  // 2. Beat-synchronous chroma.
  const { data, rate } = decimateForTempo(samples, sampleRate, Number.POSITIVE_INFINITY);
  const feat = beatFeatures(data, rate, gridStartSec, periodSec, nGrid, a4, (p) => progress(0.15 + 0.65 * p));
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
  const chroma = new Float32Array(12);
  let marginSum = 0;
  for (let k = 0; k < n; k++) {
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
      timeSec: gridStartSec + (lead + k) * periodSec,
      chord: s === N_STATE ? null : templates[s].name,
      score,
    });
  }
  const bars = buildBars(beats, beatsPerBar);
  progress(1);
  return {
    bpm,
    beatsPerBar,
    firstDownbeatSec: beats[0].timeSec,
    key,
    beats,
    bars,
    confidence,
  };
}
