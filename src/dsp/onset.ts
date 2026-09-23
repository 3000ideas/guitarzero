/**
 * Attack (onset) detector: half-wave rectified spectral flux of log(1 + |X|) restricted to the
 * loHz..hiHz band, against an adaptive threshold median(last N flux) * threshold + eps.
 * The metronome click (4.5 / 5.5 kHz) lives above hiHz, so it cannot create onsets.
 * Pure TypeScript, testable in Node.
 */

export interface OnsetOpts {
  /** Nominal hop between frames (informative; the refractory uses real timeSec deltas). Default 0.04. */
  hopSeconds?: number;
  /** Minimum time between two onsets in seconds. Default 0.1. */
  minIntervalSec?: number;
  /** Multiplier over the median flux. Default 1.5. */
  threshold?: number;
  /** Number of past flux values in the median. Default 24 (~1 s at a 40 ms hop). */
  historyFrames?: number;
  /** Band analysed, Hz. Defaults 70 and 3500. */
  loHz?: number;
  hiHz?: number;
}

/**
 * Absolute floor of the adaptive threshold, per analysed bin (eps = ONSET_EPS_PER_BIN * bins,
 * about 15 at 48 kHz / 8192). Measured with the test synthesiser (unnormalised 8192-point
 * magnitudes, 70..3500 Hz): digital silence 0, a -80 dBFS noise floor ~0.6, the in-band leakage
 * of a -20 dBFS metronome click (4.5/5.5 kHz, 3 ms attack, 8 ms decay) <= 5.5, a strum at
 * -20 dBFS 60..190, at -40 dBFS ~30..60. The floor must sit well above the click and below
 * quiet strums.
 */
export const ONSET_EPS_PER_BIN = 0.025;

export class OnsetDetector {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hopSeconds: number;
  readonly minIntervalSec: number;
  readonly historyFrames: number;
  /** First / last bin (inclusive) of the analysed band. */
  readonly kLo: number;
  readonly kHi: number;
  /** Absolute threshold floor. */
  readonly eps: number;
  /** Flux and threshold of the last processed frame (diagnostics). */
  lastFlux = 0;
  lastThreshold = 0;

  private threshold: number;
  private prevLog: Float64Array;
  private curLog: Float64Array;
  private hasPrev = false;
  private readonly history: Float64Array;
  private readonly scratch: Float64Array;
  private historyCount = 0;
  private historyPos = 0;
  private lastOnsetTime = -Infinity;
  /** Whether the previous (armed) frame was already above its threshold. */
  private wasAbove = false;

  constructor(sampleRate: number, fftSize: number, opts: OnsetOpts = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hopSeconds = opts.hopSeconds ?? 0.04;
    this.minIntervalSec = opts.minIntervalSec ?? 0.1;
    this.threshold = opts.threshold ?? 1.5;
    this.historyFrames = Math.max(1, Math.round(opts.historyFrames ?? 24));
    const loHz = opts.loHz ?? 70;
    const hiHz = opts.hiHz ?? 3500;
    const df = sampleRate / fftSize;
    const half = fftSize >> 1;
    this.kLo = Math.min(half, Math.max(0, Math.round(loHz / df)));
    this.kHi = Math.min(half, Math.max(this.kLo, Math.round(hiHz / df)));
    const bins = this.kHi - this.kLo + 1;
    this.eps = ONSET_EPS_PER_BIN * bins;
    this.prevLog = new Float64Array(bins);
    this.curLog = new Float64Array(bins);
    this.history = new Float64Array(this.historyFrames);
    this.scratch = new Float64Array(this.historyFrames);
  }

  setThreshold(t: number): void {
    if (Number.isFinite(t) && t > 0) this.threshold = t;
  }

  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Feeds one magnitude spectrum stamped at `timeSec` (end of the frame). Returns true when the
   * frame is an accepted onset: flux above the adaptive threshold on an UPWARD crossing (the
   * first frame of a run above the threshold; with a 171 ms Hann frame and a 40 ms hop one
   * attack keeps the flux positive for 3-4 hops while it slides towards the window centre, and
   * only the first of them is the onset) and at least `minIntervalSec` after the previous onset
   * (real timeSec deltas). The first frame is never an onset. With `armed = false` the detector
   * only updates its state (spectrum, flux history) and never fires nor starts the refractory
   * period (used while the level gate is closed); a run above the threshold that started while
   * disarmed still counts as a fresh crossing once armed.
   */
  process(mag: Float32Array, timeSec: number, armed = true): boolean {
    const cur = this.curLog;
    const prev = this.prevLog;
    const kLo = this.kLo;
    const bins = cur.length;
    for (let i = 0; i < bins; i++) {
      const m = mag[kLo + i];
      cur[i] = Math.log(1 + (m > 0 ? m : 0));
    }
    if (!this.hasPrev) {
      this.hasPrev = true;
      this.swap();
      this.lastFlux = 0;
      this.lastThreshold = this.eps;
      return false;
    }
    let flux = 0;
    for (let i = 0; i < bins; i++) {
      const d = cur[i] - prev[i];
      if (d > 0) flux += d;
    }
    // Without history the frame cannot be compared with anything: never fire.
    const median = this.historyCount > 0 ? this.medianHistory() : flux;
    const thr = median * this.threshold + this.eps;
    this.lastFlux = flux;
    this.lastThreshold = thr;
    const above = this.historyCount > 0 && flux > thr;
    let fire = false;
    if (armed && above && !this.wasAbove && timeSec - this.lastOnsetTime >= this.minIntervalSec) {
      fire = true;
      this.lastOnsetTime = timeSec;
    }
    this.wasAbove = armed && above;
    this.pushHistory(flux);
    this.swap();
    return fire;
  }

  private swap(): void {
    const t = this.prevLog;
    this.prevLog = this.curLog;
    this.curLog = t;
  }

  private pushHistory(flux: number): void {
    this.history[this.historyPos] = flux;
    this.historyPos = (this.historyPos + 1) % this.historyFrames;
    if (this.historyCount < this.historyFrames) this.historyCount++;
  }

  private medianHistory(): number {
    const n = this.historyCount;
    const s = this.scratch;
    for (let i = 0; i < n; i++) s[i] = this.history[i];
    const view = s.subarray(0, n);
    view.sort();
    const mid = n >> 1;
    return n % 2 === 1 ? view[mid] : 0.5 * (view[mid - 1] + view[mid]);
  }
}
