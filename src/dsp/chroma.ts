/**
 * Spectrum -> chroma (peak picking with parabolic interpolation), log compression, chord
 * templates and cosine matching. Pure functions on Float32Array, testable in Node.
 *
 * Pipeline (identical for observed frames and for templates):
 *   energy chroma (12 bins, octave weighted, linear energy)
 *   -> compressChroma: e' = e / max(e); c = log(1 + gamma * e') / log(1 + gamma); L2 = 1
 *
 * Known limitation of peak picking: two partials closer than ~2 FFT bins (about 12 Hz at
 * 48 kHz / 8192) merge into one peak. This does not happen for standard-tuning guitar voicings.
 */
import type { ChordMatch, ChordQuality, ChordTemplate } from '../types';
import { chordPitchClasses, makeChordSymbol, midiToFreq } from '../music/notes';

/** Lowest / highest MIDI note considered by the chroma (E2 .. E6). */
export const CHROMA_MIDI_LO = 40;
export const CHROMA_MIDI_HI = 88;
/** Default log-compression strength. */
export const DEFAULT_GAMMA = 10;
/** Peak floor = PEAK_FLOOR_FACTOR * median(|X| in band). */
export const PEAK_FLOOR_FACTOR = 8;
/** Semitone offsets of harmonics 1..6 (h * f0 rounded to the nearest semitone). */
export const HARMONIC_OFFSETS: readonly number[] = [0, 12, 19, 24, 28, 31];
/** Amplitude ratio between consecutive template harmonics (energy = ratio^(2*(h-1))). */
export const HARMONIC_DECAY = 0.6;
/** Qualities in the matching vocabulary (12 roots x 7 = 84 templates). */
export const TEMPLATE_QUALITIES: readonly ChordQuality[] = ['maj', 'min', '7', 'm7', 'maj7', 'sus2', 'sus4'];

const CENTS_50_DOWN = Math.pow(2, -50 / 1200);
const CENTS_50_UP = Math.pow(2, 50 / 1200);

/** Linear octave weight: 1.0 at MIDI 40 -> 0.6 at MIDI 88. */
export function octaveWeight(midi: number): number {
  const t = (midi - CHROMA_MIDI_LO) / (CHROMA_MIDI_HI - CHROMA_MIDI_LO);
  return 1 - 0.4 * Math.min(1, Math.max(0, t));
}

/** Median of a typed array slice (sorts a copy). */
function medianOf(values: Float32Array): number {
  const n = values.length;
  if (n === 0) return 0;
  const copy = values.slice();
  copy.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

/**
 * Energy chroma by peak picking. `mag` = unnormalised magnitude spectrum (length >= fftSize/2+1).
 * Every spectral peak above 8x the in-band median is refined with a parabolic fit in the log
 * domain, assigned to the nearest MIDI note (within +-50 cents, 40..88) and its energy added to
 * that pitch class with a linear octave weight (1.0 at MIDI 40 -> 0.6 at MIDI 88).
 * Returns linear energy: NOT compressed, NOT normalised. `out` (12) is reused when given.
 */
export function computeEnergyChroma(
  mag: Float32Array,
  sampleRate: number,
  fftSize: number,
  opts: { a4?: number } = {},
  out?: Float32Array,
): Float32Array {
  const a4 = opts.a4 ?? 440;
  const res = out ?? new Float32Array(12);
  res.fill(0);
  const df = sampleRate / fftSize;
  const half = fftSize >> 1;
  const kLo = Math.max(1, Math.floor((midiToFreq(CHROMA_MIDI_LO, a4) * CENTS_50_DOWN) / df));
  const kHi = Math.min(half - 1, mag.length - 2, Math.ceil((midiToFreq(CHROMA_MIDI_HI, a4) * CENTS_50_UP) / df));
  if (kHi < kLo) return res;
  const peakFloor = PEAK_FLOOR_FACTOR * medianOf(mag.subarray(kLo, kHi + 1));
  for (let k = kLo; k <= kHi; k++) {
    const m = mag[k];
    if (!(m > mag[k - 1] && m >= mag[k + 1] && m > peakFloor)) continue;
    const a = Math.log(mag[k - 1] + 1e-12);
    const b = Math.log(m + 1e-12);
    const g = Math.log(mag[k + 1] + 1e-12);
    const den = a - 2 * b + g;
    let d = den === 0 ? 0 : (0.5 * (a - g)) / den;
    if (d > 0.5) d = 0.5;
    else if (d < -0.5) d = -0.5;
    const f = (k + d) * df;
    const energy = Math.exp(2 * (b - 0.25 * (a - g) * d));
    const midi = Math.round(69 + 12 * Math.log2(f / a4));
    if (midi < CHROMA_MIDI_LO || midi > CHROMA_MIDI_HI) continue;
    const cents = 1200 * Math.log2(f / midiToFreq(midi, a4));
    if (Math.abs(cents) > 50) continue;
    res[midi % 12] += octaveWeight(midi) * energy;
  }
  return res;
}

/**
 * Log compression + L2 normalisation, scale invariant: e' = e / max(e) (all zeros when the
 * max is 0), c = log(1 + gamma * e') / log(1 + gamma), then ||c|| = 1. `out` may alias `energy`.
 */
export function compressChroma(energy: Float32Array, gamma = DEFAULT_GAMMA, out?: Float32Array): Float32Array {
  const res = out ?? new Float32Array(12);
  let max = 0;
  for (let i = 0; i < 12; i++) if (energy[i] > max) max = energy[i];
  if (!(max > 0)) {
    res.fill(0);
    return res;
  }
  const denom = Math.log(1 + gamma);
  let norm = 0;
  for (let i = 0; i < 12; i++) {
    const c = Math.log(1 + (gamma * energy[i]) / max) / denom;
    res[i] = c;
    norm += c * c;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 12; i++) res[i] /= norm;
  return res;
}

/**
 * Rotates a chroma from sounding space to written space: out[pc] = v[(pc + shift) % 12]
 * (sounding = written + shift, so the written bin reads the sounding bin `shift` semitones up).
 * `out` may alias `v`.
 */
export function rollChroma(v: Float32Array, shift: number, out?: Float32Array): Float32Array {
  const s = ((Math.round(shift) % 12) + 12) % 12;
  const res = out ?? new Float32Array(12);
  if (res === v) {
    const tmp = v.slice(0, 12);
    for (let pc = 0; pc < 12; pc++) res[pc] = tmp[(pc + s) % 12];
  } else {
    for (let pc = 0; pc < 12; pc++) res[pc] = v[(pc + s) % 12];
  }
  return res;
}

/** Unique ascending pitch classes 0..11. */
function normalisePcs(pcs: number[]): number[] {
  const set = new Set<number>();
  for (const p of pcs) set.add(((Math.round(p) % 12) + 12) % 12);
  return [...set].sort((a, b) => a - b);
}

/**
 * Template for a set of chord notes, built in the ENERGY domain (harmonics 1..6 per note with
 * energy (0.6^(h-1))^2 at semitone offsets [0,12,19,24,28,31]) and then compressed exactly like
 * an observed chroma. `pcs` keeps the chord notes (unique, ascending), without harmonics.
 */
export function templateForPitchClasses(
  pcs: number[],
  name: string,
  root: number,
  quality: ChordQuality,
  gamma = DEFAULT_GAMMA,
): ChordTemplate {
  const notes = normalisePcs(pcs);
  const energy = new Float32Array(12);
  for (const p of notes) {
    for (let h = 1; h <= HARMONIC_OFFSETS.length; h++) {
      const amp = Math.pow(HARMONIC_DECAY, h - 1);
      energy[(p + HARMONIC_OFFSETS[h - 1]) % 12] += amp * amp;
    }
  }
  return { name, root, quality, pcs: notes, vector: compressChroma(energy, gamma) };
}

/** Vocabulary: 12 roots x { maj, min, 7, m7, maj7, sus2, sus4 } = 84 templates, sharp names. */
export function buildTemplates(gamma = DEFAULT_GAMMA): ChordTemplate[] {
  const out: ChordTemplate[] = [];
  for (let root = 0; root < 12; root++) {
    for (const quality of TEMPLATE_QUALITIES) {
      const sym = makeChordSymbol(root, quality);
      out.push(templateForPitchClasses(chordPitchClasses(sym), sym.name, root, quality, gamma));
    }
  }
  return out;
}

/** Cosine similarity; 0 when either vector is null (never NaN). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  const c = dot / Math.sqrt(na * nb);
  if (Number.isNaN(c)) return 0;
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

export interface MatchResult {
  best: ChordTemplate | null;
  score: number;
  /** Every template scored, best first. Empty for a null chroma. */
  ranked: ChordMatch[];
}

/** Ranks the vocabulary by cosine similarity. A null chroma gives best null, score 0, ranked []. */
export function matchChord(chroma: Float32Array, templates: ChordTemplate[]): MatchResult {
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  if (!(norm > 0) || templates.length === 0) return { best: null, score: 0, ranked: [] };
  const scored: Array<{ template: ChordTemplate; score: number }> = new Array(templates.length);
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    scored[i] = { template: t, score: cosine(chroma, t.vector) };
  }
  scored.sort((x, y) => y.score - x.score);
  const ranked: ChordMatch[] = scored.map((s) => ({ name: s.template.name, score: s.score }));
  return { best: scored[0].template, score: scored[0].score, ranked };
}

/** True when both pitch-class lists (unique, ascending) contain the same set. */
export function samePitchClasses(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Vocabulary with the expected template REPLACING every entry that has the same pitch-class
 * set (appended when none matches), so top-1 / top-2 never hold the same chord twice.
 * Returns a new array; `templates` is not modified.
 */
export function mergeExpectedTemplate(templates: ChordTemplate[], expected: ChordTemplate): ChordTemplate[] {
  const out: ChordTemplate[] = [];
  let replaced = false;
  for (const t of templates) {
    if (samePitchClasses(t.pcs, expected.pcs)) {
      if (!replaced) {
        out.push(expected);
        replaced = true;
      }
      continue;
    }
    out.push(t);
  }
  if (!replaced) out.push(expected);
  return out;
}
