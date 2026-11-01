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

function magAt(mag: Float32Array, bin: number): number {
  const i = Math.floor(bin);
  if (i < 0 || i + 1 >= mag.length) return 0;
  const t = bin - i;
  return mag[i] * (1 - t) + mag[i + 1] * t;
}

/** Interpolated peak of `mag` near `bin`: strongest local maximum within ±halfWidth bins. */
function peakNear(mag: Float32Array, bin: number, halfWidth: number): { k: number; m: number } | null {
  const lo = Math.max(1, Math.floor(bin - halfWidth));
  const hi = Math.min(mag.length - 2, Math.ceil(bin + halfWidth));
  let bestK = -1;
  let bestM = 0;
  for (let k = lo; k <= hi; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > bestM) {
      bestM = mag[k];
      bestK = k;
    }
  }
  return bestK < 0 ? null : { k: bestK, m: bestM };
}

/**
 * Guided pitch detection for a KNOWN target string (the tuner always names one). Phone and laptop
 * mics roll off the low end, so on E2/A2/D3 the fundamental can be much weaker than its 2nd-4th
 * harmonics — and "loudest peak" then reads a harmonic as the note (the wrong note, an octave
 * or a fifth up). Instead, within ±3 semitones of the target it picks the f0 whose first four
 * harmonics carry the most energy, then reads the exact frequency off the lowest harmonic that is
 * clearly present (divided back down), so the cents are accurate too.
 * Returns null when nothing harmonic near the target stands out against the rest of the
 * spectrum (e.g. another string was played), so the caller can fall back to detectPitch().
 */
export function detectPitchNear(
  mag: Float32Array,
  sampleRate: number,
  fftSize: number,
  targetHz: number,
  opts: { a4?: number } = {},
): TunerReading | null {
  if (!(sampleRate > 0) || !(fftSize > 0) || !(targetHz > 0)) return null;
  const a4 = opts.a4 ?? 440;
  const df = sampleRate / fftSize;
  const HARMONICS = 4;

  let bestC = 0;
  let bestS = -1;
  for (let c = -300; c <= 300; c += 5) {
    const f = targetHz * Math.pow(2, c / 1200);
    let sum = 0;
    for (let h = 1; h <= HARMONICS; h++) sum += magAt(mag, (h * f) / df);
    if (sum > bestS) {
      bestS = sum;
      bestC = c;
    }
  }
  const f0 = targetHz * Math.pow(2, bestC / 1200);

  const peaks: Array<{ h: number; k: number; m: number }> = [];
  let maxPeak = 0;
  for (let h = 1; h <= HARMONICS; h++) {
    const p = peakNear(mag, (h * f0) / df, 3);
    if (!p) continue;
    peaks.push({ h, ...p });
    if (p.m > maxPeak) maxPeak = p.m;
  }
  if (maxPeak <= 0) return null;
  // A string rings with several harmonics; a lone tone (mains hum, a whistle) is not one.
  if (peaks.filter((p) => p.m >= 0.15 * maxPeak).length < 2) return null;

  // Must stand out from the rest of the spectrum, else it is not this string.
  const kLo = Math.max(1, Math.floor(70 / df));
  const kHi = Math.min(mag.length - 2, Math.ceil(1500 / df));
  let globalMax = 0;
  for (let k = kLo; k <= kHi; k++) if (mag[k] > globalMax) globalMax = mag[k];
  if (maxPeak < 0.25 * globalMax) return null;

  // Every strong peak must sit on a harmonic of f0; otherwise f0 is a sub-harmonic ghost of
  // some other note (e.g. D2's 3rd harmonic matching an A2 pluck's 2nd).
  for (let k = kLo + 1; k < kHi; k++) {
    if (!(mag[k] > 0.4 * globalMax && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
    const ratio = (k * df) / f0;
    const h = Math.round(ratio);
    if (h < 1 || Math.abs(1200 * Math.log2(ratio / h)) > 40) return null;
  }

  // Lowest harmonic that is clearly present: least inharmonic stretch, then divide back to f0.
  const chosen = peaks.find((p) => p.m >= 0.5 * maxPeak) ?? peaks[0];
  const a = Math.log(mag[chosen.k - 1] + 1e-12);
  const b = Math.log(mag[chosen.k] + 1e-12);
  const g = Math.log(mag[chosen.k + 1] + 1e-12);
  const den = a - 2 * b + g;
  const d = den === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - g)) / den));
  const freqHz = ((chosen.k + d) * df) / chosen.h;
  if (!(freqHz > 0)) return null;

  const midiFloat = freqToMidi(freqHz, a4);
  const midi = Math.round(midiFloat);
  return {
    midi,
    noteName: noteName(midi),
    freqHz,
    centsOff: Math.max(-50, Math.min(50, (midiFloat - midi) * 100)),
    strength: globalMax > 0 ? maxPeak / globalMax : 0,
  };
}

/**
 * Which open string is sounding, and how far off is it? Tries each target with the guided
 * detector and picks the best-fitting one (see below): a pluck of a higher string also "fits" the
 * sub-octave candidates (its 2nd/4th harmonics land on their 4th/8th), whereas the true string
 * is the only one explaining the lowest partials. Falls back to the loudest-peak detector,
 * snapped to the nearest open string, when no candidate fits (noisy spectrum, very out of tune).
 */
export function detectOpenString(
  mag: Float32Array,
  sampleRate: number,
  fftSize: number,
  targetsHz: readonly number[],
  opts: { a4?: number; preferIndex?: number } = {},
): { index: number; reading: TunerReading } | null {
  if (!isTonal(mag, sampleRate / fftSize)) return null;
  const df = sampleRate / fftSize;
  const lo = Math.max(1, Math.floor(70 / df));
  const hi = Math.min(mag.length - 2, Math.ceil(1500 / df));
  const sortedBand = Array.from(mag.subarray(lo, hi + 1)).sort((x, y) => x - y);
  const median = sortedBand[sortedBand.length >> 1];
  const fits: Array<{ index: number; reading: TunerReading; hasFundamental: boolean }> = [];
  for (let i = 0; i < targetsHz.length; i++) {
    const r = detectPitchNear(mag, sampleRate, fftSize, targetsHz[i], opts);
    if (!r) continue;
    const fund = peakNear(mag, r.freqHz / df, 2);
    fits.push({ index: i, reading: r, hasFundamental: !!fund && fund.m > 4 * Math.max(median, 1e-12) });
  }
  if (fits.length > 0) {
    // A higher string's harmonics also fit the sub-octave candidates (and vice versa when a phone
    // mic drops the fundamental), so the order of preference matters: the lowest candidate whose
    // own fundamental is really there; else the one already selected (don't jump around); else
    // the highest fit.
    const withFund = fits.filter((f) => f.hasFundamental);
    const pick =
      withFund.sort((x, y) => x.index - y.index)[0] ??
      fits.find((f) => f.index === opts.preferIndex) ??
      fits.sort((x, y) => y.index - x.index)[0];
    return { index: pick.index, reading: pick.reading };
  }
  const r = detectPitch(mag, sampleRate, fftSize, opts);
  if (!r) return null;
  // Same "several harmonics" rule as the guided path: a lone tone is hum or a whistle.
  const fund = peakNear(mag, r.freqHz / df, 3);
  const second = peakNear(mag, (2 * r.freqHz) / df, 3);
  if (!fund || !second || second.m < 0.15 * fund.m) return null;
  let index = 0;
  let bestDist = Infinity;
  for (let i = 0; i < targetsHz.length; i++) {
    const d = Math.abs(1200 * Math.log2(r.freqHz / targetsHz[i]));
    if (d < bestDist) {
      bestDist = d;
      index = i;
    }
  }
  return { index, reading: r };
}

/**
 * A plucked string is PEAKY (a few harmonics far above everything else); room noise, hiss and
 * mains hum with a boosted mic gain are flat or smeared. Without this check a quiet room above
 * the gate was "recognised" as some string. Ratio of the loudest bin to the median bin in 70-1500 Hz.
 */
const TONAL_PEAK_TO_MEDIAN = 12;

export function isTonal(mag: Float32Array, df: number): boolean {
  const lo = Math.max(1, Math.floor(70 / df));
  const hi = Math.min(mag.length - 2, Math.ceil(1500 / df));
  if (hi <= lo) return false;
  const band = Array.from(mag.subarray(lo, hi + 1)).sort((a, b) => a - b);
  const median = band[band.length >> 1];
  return band[band.length - 1] > TONAL_PEAK_TO_MEDIAN * Math.max(median, 1e-12);
}
