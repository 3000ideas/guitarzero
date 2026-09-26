/**
 * Monophonic pitch detector for a simple chromatic tuner: finds the strongest spectral peak in
 * the guitar's fundamental range and reports it as a note (with octave) plus its deviation in
 * cents from equal temperament. Deliberately separate from chroma.ts: a tuner needs the actual
 * octave (which string is ringing), not chroma.ts's 12 pitch classes folded across octaves, and
 * it only tracks the single loudest peak (built for one plucked string at a time, the way every
 * hardware/app tuner works), not a full chord. Pure TypeScript, testable in Node.
 */
import { freqToMidi, noteName } from '../music/notes';

export interface TunerReading {
  /** Nearest integer MIDI note. */
  midi: number;
  /** Scientific pitch name, e.g. 'E2'. */
  noteName: string;
  /** Parabolically refined frequency, Hz. */
  freqHz: number;
  /** Signed deviation from the nearest note, cents (-50..50; negative = flat, positive = sharp). */
  centsOff: number;
  /** Peak magnitude relative to the loudest bin in the searched range, 0..1 (diagnostic only). */
  strength: number;
}

/** Just below open low E2 (82.41 Hz), so a slightly flat low E is still found. */
export const TUNER_DEFAULT_MIN_HZ = 70;
/** A bit above open high e4 (329.63 Hz), so a slightly sharp high e is still found. */
export const TUNER_DEFAULT_MAX_HZ = 400;

export interface DetectPitchOpts {
  a4?: number;
  minHz?: number;
  maxHz?: number;
}

/**
 * Finds the loudest local peak of `mag` (an unnormalised magnitude spectrum, e.g. from
 * RealFFT.magnitudes) within [minHz, maxHz] (default the open-string range of a standard-tuned
 * guitar, sections 70..400 Hz), refines it with parabolic interpolation in log-magnitude (same
 * method as chroma.ts's peak picking), and reports it as a note + cents. Returns null when no
 * local peak exists in range (silence, or energy that never dips between two bins there).
 */
export function detectPitch(mag: Float32Array, sampleRate: number, fftSize: number, opts: DetectPitchOpts = {}): TunerReading | null {
  const a4 = opts.a4 ?? 440;
  const minHz = opts.minHz ?? TUNER_DEFAULT_MIN_HZ;
  const maxHz = opts.maxHz ?? TUNER_DEFAULT_MAX_HZ;
  if (!(sampleRate > 0) || !(fftSize > 0)) throw new RangeError(`detectPitch: invalid sampleRate/fftSize ${sampleRate}/${fftSize}`);
  const df = sampleRate / fftSize;
  const half = fftSize >> 1;
  const kLo = Math.max(1, Math.floor(minHz / df));
  const kHi = Math.min(half - 1, Math.ceil(maxHz / df));
  if (kHi <= kLo || kHi + 1 >= mag.length) return null;

  let bestK = -1;
  let bestMag = 0;
  let maxMagInRange = 0;
  for (let k = kLo; k <= kHi; k++) {
    const m = mag[k];
    if (m > maxMagInRange) maxMagInRange = m;
    if (m > mag[k - 1] && m >= mag[k + 1] && m > bestMag) {
      bestMag = m;
      bestK = k;
    }
  }
  if (bestK < 0 || bestMag <= 0) return null;

  const a = Math.log(mag[bestK - 1] + 1e-12);
  const b = Math.log(mag[bestK] + 1e-12);
  const g = Math.log(mag[bestK + 1] + 1e-12);
  const den = a - 2 * b + g;
  const d = den === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - g)) / den));
  const freqHz = (bestK + d) * df;
  if (!(freqHz > 0)) return null;

  const midiFloat = freqToMidi(freqHz, a4);
  const midi = Math.round(midiFloat);
  const centsOff = Math.max(-50, Math.min(50, (midiFloat - midi) * 100));
  return {
    midi,
    noteName: noteName(midi),
    freqHz,
    centsOff,
    strength: maxMagInRange > 0 ? bestMag / maxMagInRange : 0,
  };
}
