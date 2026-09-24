/**
 * ChordDetector: one audio frame (fftSize samples, newest last) -> DetectorFrame.
 * Per process(): Hann magnitudes -> rmsDb -> noise-floor tracking -> gate -> chroma -> onset
 * (with in-frame onset time refinement). Pure TypeScript, testable in Node.
 */
import type { ChordMatch, ChordTemplate, DetectorFrame, DetectorOpts } from '../types';
import { RealFFT } from './fft';
import { buildTemplates, compressChroma, computeEnergyChroma, matchChord, rollChroma } from './chroma';
import { OnsetDetector } from './onset';

/** Frames kept for the noise-floor estimate (3 s at a 40 ms hop). */
export const NOISE_RING_FRAMES = 75;
/** Percentile of the ring used as the noise floor. */
export const NOISE_PERCENTILE = 0.1;
/** Seconds of frames needed before the first noise-floor estimate. */
export const NOISE_INIT_SEC = 0.5;
/**
 * The floor is only updated when nothing was struck during this many seconds. "Struck" is any
 * frame whose spectral flux crossed the onset threshold, accepted as an onset or not: an attack
 * that the gate swallowed must still hold the estimate, otherwise a floor that has climbed too
 * high keeps every following strum gated and never sees an onset again (a self-locking gate).
 */
export const NOISE_HOLD_SEC = 1.0;
/**
 * The floor may only RISE when two attack-free rings a ring apart (>= 3 s) read the same level
 * within this many dB: a stationary background. Drops apply at once. The decaying ring of a
 * strummed chord (its level falls 8.7 dB per decay constant; even a 3.75 s constant loses
 * 7 dB in 3 s) never passes, so sparse strums (one per bar, or half notes on a guitar that
 * sustains for seconds) cannot lift the floor to the level of the ringing chord and gate the
 * next attack. A level that has been flat for two rings is noise, not a chord.
 */
export const NOISE_RISE_FLAT_DB = 2;
/** Gate = max(gateDb, noiseFloor + NOISE_GATE_MARGIN_DB). */
export const NOISE_GATE_MARGIN_DB = 10;
/** Level of digital silence in dBFS (and the noise floor before initialisation). */
export const SILENCE_DB = -100;
/** Onset refinement: block size in samples, window analysed at the end of the frame, criterion. */
export const REFINE_BLOCK = 128;
export const REFINE_WINDOW_SEC = 0.2;
export const REFINE_LAG_SEC = 0.01;
export const REFINE_MIN_RISE_DB = 6;
/** Once a rise is confirmed, the onset block is the first one this far above the reference. */
export const REFINE_WALK_DB = 3;

/**
 * Defaults are calibrated for 48 kHz / 8192 (a 171 ms Hann window, 5.9 Hz bins); the app pins
 * its AudioContext to 48 kHz (src/audio/context.ts) so the DSP sees that resolution on every
 * device. Should a browser refuse the pin and run at 96 kHz, the same fftSize gives an 85 ms
 * window with 11.7 Hz bins: chroma peaks 2-3 bins apart merge (see chroma.ts) and the onset
 * eps, which scales with the bin count, halves while the metronome click's leakage does not.
 * Derive fftSize from the sample rate (16384 above 64 kHz) if that path ever becomes reachable.
 */
const DEFAULTS: Required<DetectorOpts> = {
  fftSize: 8192,
  a4: 440,
  gateDb: -50,
  onsetThreshold: 1.5,
  hopSeconds: 0.04,
  gamma: 10,
};

/** RMS level of a frame in dBFS, floored at SILENCE_DB. */
export function rmsDbOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
  if (!(rms > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(rms));
}

/**
 * Locates the attack inside a frame: RMS (dB) of 128-sample blocks over the last ~200 ms of the
 * frame; for every block, its rise with respect to the level ~10 ms earlier (the mean energy of
 * the ~10 ms ending one lag before, so the quarter-cycle level swings of bass strings in a
 * single 2.7 ms block do not fake a reference dip). The block with the largest rise wins when
 * the rise is at least REFINE_MIN_RISE_DB; the result is the first sample of the earliest block
 * of that rise (the first block already REFINE_WALK_DB above the reference: a strum builds up
 * over 20-40 ms, one string after another). Returns -1 when no clear rise exists (the caller
 * falls back to timeSec - hop).
 */
export function refineOnsetSample(frame: Float32Array, sampleRate: number): number {
  const n = frame.length;
  const block = REFINE_BLOCK;
  const nb = Math.min(Math.floor(n / block), Math.max(2, Math.floor((REFINE_WINDOW_SEC * sampleRate) / block)));
  const lag = Math.max(1, Math.round((REFINE_LAG_SEC * sampleRate) / block));
  if (nb < 2 * lag + 1) return -1;
  const start = n - nb * block;
  const energy = new Float64Array(nb);
  const db = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    let sum = 0;
    const s0 = start + i * block;
    for (let s = s0; s < s0 + block; s++) sum += frame[s] * frame[s];
    energy[i] = sum / block;
    db[i] = 10 * Math.log10(energy[i] + 1e-12);
  }
  // refDb[i] = mean energy of the `lag` blocks ending at i - lag, in dB.
  const refDb = new Float64Array(nb);
  let acc = 0;
  for (let i = 0; i < nb; i++) {
    acc += energy[i];
    if (i >= lag) acc -= energy[i - lag];
    if (i + lag < nb) refDb[i + lag] = 10 * Math.log10(acc / Math.min(lag, i + 1) + 1e-12);
  }
  let best = -Infinity;
  let bi = -1;
  for (let i = 2 * lag - 1; i < nb; i++) {
    const rise = db[i] - refDb[i];
    if (rise > best) {
      best = rise;
      bi = i;
    }
  }
  if (bi < 0 || best < REFINE_MIN_RISE_DB) return -1;
  const ref = refDb[bi];
  let j = bi;
  while (j > 0 && db[j - 1] - ref >= REFINE_WALK_DB) j--;
  return start + j * block;
}

function percentile(values: Float64Array, count: number, p: number): number {
  const copy = values.slice(0, count);
  copy.sort();
  const idx = Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))));
  return copy[idx];
}

export class ChordDetector {
  readonly sampleRate: number;
  readonly fftSize: number;

  private readonly opts: Required<DetectorOpts>;
  private readonly fft: RealFFT;
  private readonly mag: Float32Array;
  private readonly frameBuf: Float32Array;
  private readonly onsetDetector: OnsetDetector;
  private readonly templates: ChordTemplate[];
  private readonly energyTmp = new Float32Array(12);
  private transpose = 0;

  private readonly ring = new Float64Array(NOISE_RING_FRAMES);
  private ringCount = 0;
  private ringPos = 0;
  private noiseFloorDb = SILENCE_DB;
  private firstTimeSec: number | null = null;
  private lastTimeSec: number | null = null;
  /** Last frame whose flux crossed the onset threshold (onset accepted or not). */
  private lastActivitySec = -Infinity;
  /** Frames since the last digital-silence frame (Infinity until one is seen). */
  private framesSinceSilence = Infinity;
  /** Floor candidate read from an attack-free ring, kept for a ring's duration (rise reference). */
  private quietRefDb: number | null = null;
  private quietRefSec = -Infinity;

  constructor(sampleRate: number, opts: DetectorOpts = {}) {
    if (!(sampleRate > 0)) throw new Error(`invalid sampleRate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.opts = { ...DEFAULTS, ...stripUndefined(opts) };
    this.fftSize = this.opts.fftSize;
    this.fft = new RealFFT(this.fftSize);
    this.mag = new Float32Array((this.fftSize >> 1) + 1);
    this.frameBuf = new Float32Array(this.fftSize);
    this.onsetDetector = new OnsetDetector(sampleRate, this.fftSize, {
      hopSeconds: this.opts.hopSeconds,
      threshold: this.opts.onsetThreshold,
    });
    this.templates = buildTemplates(this.opts.gamma);
  }

  /** Live-updatable options. */
  setOptions(patch: Partial<Pick<DetectorOpts, 'a4' | 'gateDb' | 'onsetThreshold'>>): void {
    if (patch.a4 !== undefined && patch.a4 > 0) this.opts.a4 = patch.a4;
    if (patch.gateDb !== undefined && Number.isFinite(patch.gateDb)) this.opts.gateDb = patch.gateDb;
    if (patch.onsetThreshold !== undefined && patch.onsetThreshold > 0) {
      this.opts.onsetThreshold = patch.onsetThreshold;
      this.onsetDetector.setThreshold(patch.onsetThreshold);
    }
  }

  /** Semitones the sounding pitch is above the written pitch (capo + tuning offset), normalised 0..11. */
  setTranspose(semitones: number): void {
    this.transpose = ((Math.round(semitones) % 12) + 12) % 12;
  }

  getTranspose(): number {
    return this.transpose;
  }

  /** Current noise-floor estimate in dBFS (SILENCE_DB until the first 0.5 s of frames). */
  getNoiseFloorDb(): number {
    return this.noiseFloorDb;
  }

  /** Wall time of the last frame whose flux crossed the onset threshold, or -Infinity. */
  getLastActivitySec(): number {
    return this.lastActivitySec;
  }

  /** Effective silence gate = max(gateDb, noiseFloor + 10). */
  getGateDb(): number {
    return Math.max(this.opts.gateDb, this.noiseFloorDb + NOISE_GATE_MARGIN_DB);
  }

  /** The vocabulary (built once). Do not mutate. */
  getTemplates(): ChordTemplate[] {
    return this.templates;
  }

  /**
   * Analyses one frame (fftSize samples, the most recent at the end; shorter frames are
   * left-padded with zeros, longer ones keep their last fftSize samples) stamped with the RAW
   * wall time of its end. Returns a NEW DetectorFrame with fresh arrays every call.
   */
  process(frame: Float32Array, timeSec: number): DetectorFrame {
    const x = this.asFrame(frame);
    this.fft.magnitudes(x, this.mag, true);
    const rmsDb = rmsDbOf(x);

    // Noise floor: always record the level; re-estimate only when nothing was struck lately.
    this.ring[this.ringPos] = rmsDb;
    this.ringPos = (this.ringPos + 1) % NOISE_RING_FRAMES;
    if (this.ringCount < NOISE_RING_FRAMES) this.ringCount++;
    if (rmsDb <= SILENCE_DB) this.framesSinceSilence = 0;
    else this.framesSinceSilence++;
    if (this.firstTimeSec === null) this.firstTimeSec = timeSec;
    this.updateNoiseFloor(timeSec);
    const gate = this.getGateDb();
    const open = rmsDb >= gate;
    const hop =
      this.lastTimeSec !== null && timeSec > this.lastTimeSec ? timeSec - this.lastTimeSec : this.opts.hopSeconds;

    const energyChroma = new Float32Array(12);
    const chroma = new Float32Array(12);
    let bestChord: ChordMatch | null = null;
    let onset = false;
    let onsetTimeSec: number | undefined;

    if (open) {
      computeEnergyChroma(this.mag, this.sampleRate, this.fftSize, { a4: this.opts.a4 }, this.energyTmp);
      rollChroma(this.energyTmp, this.transpose, energyChroma);
      compressChroma(energyChroma, this.opts.gamma, chroma);
      const m = matchChord(chroma, this.templates);
      if (m.best !== null && m.score > 0) bestChord = { name: m.best.name, score: m.score };
    }
    // The onset detector always sees the spectrum (keeps its history current) but may only fire
    // when the gate is open.
    if (this.onsetDetector.process(this.mag, timeSec, open)) {
      onset = true;
      const sample = refineOnsetSample(x, this.sampleRate);
      onsetTimeSec = sample >= 0 ? timeSec - (this.fftSize - sample) / this.sampleRate : timeSec - hop;
    }
    // Any flux crossing, gated or not, counts as activity for the noise-floor hold.
    if (this.onsetDetector.lastAbove) this.lastActivitySec = timeSec;
    this.lastTimeSec = timeSec;

    const out: DetectorFrame = { timeSec, rmsDb, onset, energyChroma, chroma, bestChord };
    if (onset && onsetTimeSec !== undefined) out.onsetTimeSec = onsetTimeSec;
    return out;
  }

  /**
   * Noise-floor estimate from the ring (10th percentile of the last 75 rmsDb). Nothing changes
   * within NOISE_HOLD_SEC of a flux crossing. Otherwise the candidate is taken at once while the
   * floor is provisional (still SILENCE_DB, or the ring still holds a digital-silence frame: no
   * complete ring of real audio yet, e.g. the analyser's zeros before the AudioContext runs, so
   * the estimate must be free to settle on the first clean ring) or when it is lower (drops are
   * always safe). A provisional adoption is only taken from an attack-free ring, or of a level
   * the user's own gate already treats as silence (candidate <= gateDb): audio that starts with
   * strums straight after the zeros must not enshrine the ringing chord as the floor. A rise
   * only goes through when the whole ring is attack-free and a previous attack-free ring, read
   * at least a ring earlier, gave the same level within NOISE_RISE_FLAT_DB: stationary noise,
   * never the decaying ring of a chord.
   */
  private updateNoiseFloor(timeSec: number): void {
    if (this.firstTimeSec === null || timeSec - this.firstTimeSec < NOISE_INIT_SEC) return;
    const sinceActivity = timeSec - this.lastActivitySec;
    if (sinceActivity < NOISE_HOLD_SEC) return;
    const ringSec = NOISE_RING_FRAMES * this.opts.hopSeconds;
    const ringQuiet = sinceActivity >= ringSec;
    const candidate = percentile(this.ring, this.ringCount, NOISE_PERCENTILE);
    const provisional = this.noiseFloorDb === SILENCE_DB || this.framesSinceSilence <= NOISE_RING_FRAMES;
    if ((provisional && (ringQuiet || candidate <= this.opts.gateDb)) || candidate <= this.noiseFloorDb) {
      this.noiseFloorDb = candidate;
    } else if (
      ringQuiet &&
      this.quietRefDb !== null &&
      timeSec - this.quietRefSec >= ringSec &&
      Math.abs(candidate - this.quietRefDb) <= NOISE_RISE_FLAT_DB
    ) {
      this.noiseFloorDb = candidate;
    }
    if (!ringQuiet) {
      this.quietRefDb = null;
    } else if (this.quietRefDb === null || timeSec - this.quietRefSec >= ringSec) {
      this.quietRefDb = candidate;
      this.quietRefSec = timeSec;
    }
  }

  private asFrame(frame: Float32Array): Float32Array {
    const n = this.fftSize;
    if (frame.length === n) return frame;
    const buf = this.frameBuf;
    if (frame.length > n) {
      buf.set(frame.subarray(frame.length - n));
    } else {
      buf.fill(0, 0, n - frame.length);
      buf.set(frame, n - frame.length);
    }
    return buf;
  }
}

function stripUndefined(opts: DetectorOpts): DetectorOpts {
  const out: DetectorOpts = {};
  if (opts.fftSize !== undefined) out.fftSize = opts.fftSize;
  if (opts.a4 !== undefined) out.a4 = opts.a4;
  if (opts.gateDb !== undefined) out.gateDb = opts.gateDb;
  if (opts.onsetThreshold !== undefined) out.onsetThreshold = opts.onsetThreshold;
  if (opts.hopSeconds !== undefined) out.hopSeconds = opts.hopSeconds;
  if (opts.gamma !== undefined) out.gamma = opts.gamma;
  return out;
}
