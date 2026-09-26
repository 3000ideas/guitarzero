/**
 * Latency calibration: schedules n metronome clicks, asks the user to strum on each one and
 * measures median(onset - nominal) over the RAW detector onsets. Because the click lives above
 * the analysed band, the only onsets are the user's strums, so the median is exactly the offset
 * the judge sees when the user follows the metronome / ball.
 *
 * Pure helpers (median, matchClicksToOnsets, computeLatency) are exported for tests; the async
 * runner (runCalibration) only depends on DetectorSource, ClickScheduler, Clock and setTimeout.
 */
import type { ClickScheduler, Clock, DetectorFrame, DetectorSource } from '../types';

export const CALIBRATION_DEFAULT_CLICKS = 8;
export const CALIBRATION_DEFAULT_INTERVAL_SEC = 1;
/** Seconds between the call and the first click. */
export const CALIBRATION_LEAD_SEC = 1;
/** Onset search window around each click: [nominal - BEFORE, nominal + AFTER]. */
export const CALIBRATION_WINDOW_BEFORE_SEC = 0.15;
export const CALIBRATION_WINDOW_AFTER_SEC = 0.5;
export const CALIBRATION_MIN_SAMPLES = 5;
/**
 * Maximum median absolute deviation of the samples, in seconds. The median (and the MAD itself)
 * already has a 50% breakdown point, so it is inherently robust to a single mistimed strum among
 * several good ones (see the 'is robust to a single outlier' test); this bound is instead about
 * how precisely a real beginner can physically strum a guitar on a click — not just tap a button
 * — across a whole run. 40 ms matched a robot but rejected real, otherwise-consistent players;
 * 70 ms still catches someone who isn't really following the click at all (the high-variance test
 * sits at ~150-200 ms) while giving a genuine beginner a realistic chance to pass.
 */
export const CALIBRATION_MAX_MAD_SEC = 0.07;
export const CALIBRATION_MIN_LATENCY_SEC = -0.1;
export const CALIBRATION_MAX_LATENCY_SEC = 0.5;
/** The run settles at the latest this long after the last nominal click. */
export const CALIBRATION_TAIL_SEC = 1;
/**
 * Frames settle the run early once their end time is this far past the last click's window:
 * an onset is only reported 1-3 hops after the physical attack, so wait for the detector.
 */
export const CALIBRATION_SETTLE_SEC = 0.25;

export type CalibrationErrorCode = 'insufficient' | 'unstable' | 'cancelled';

export const CALIBRATION_MESSAGES: Record<CalibrationErrorCode, string> = {
  insufficient: 'No se detectaron suficientes rasgueos',
  unstable: 'Demasiada variación, repite la calibración',
  cancelled: 'Calibración cancelada',
};

export class CalibrationError extends Error {
  readonly code: CalibrationErrorCode;
  /** The offsets (onset - nominal, seconds) that were collected before failing. */
  readonly samples: number[];

  constructor(code: CalibrationErrorCode, samples: number[] = [], message: string = CALIBRATION_MESSAGES[code]) {
    super(message);
    this.name = 'CalibrationError';
    this.code = code;
    this.samples = samples;
  }
}

export interface CalibrationOpts {
  /** Number of clicks (default 8). */
  n?: number;
  /** Seconds between clicks (default 1). */
  intervalSec?: number;
  /** Called with 1..n as each click's nominal time passes. */
  onProgress?: (i: number) => void;
  /** Optional cancellation: rejects with CalibrationError('cancelled') and clears pending clicks. */
  signal?: AbortSignal;
}

export interface CalibrationResult {
  /** median(onset - nominal), clamped to [-0.1, 0.5]. */
  latencySec: number;
  /** One offset (onset - nominal, seconds) per matched click, in click order. */
  samples: number[];
}

/** Median of a list (mean of the two middle values for even counts). NaN for an empty list. */
export function median(values: number[]): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * For each nominal click time picks the nearest unused onset inside
 * [nominal - 0.15, nominal + 0.5] and returns the offsets `onset - nominal` of the matched clicks
 * (in click order; clicks without an onset produce no sample). An onset serves one click at most.
 */
export function matchClicksToOnsets(nominals: number[], onsets: number[]): number[] {
  const used = new Set<number>();
  const samples: number[] = [];
  for (const nominal of nominals) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < onsets.length; i++) {
      if (used.has(i)) continue;
      const o = onsets[i];
      if (o < nominal - CALIBRATION_WINDOW_BEFORE_SEC || o > nominal + CALIBRATION_WINDOW_AFTER_SEC) continue;
      const dist = Math.abs(o - nominal);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      samples.push(onsets[bestIdx] - nominal);
    }
  }
  return samples;
}

/**
 * Turns the matched offsets into the result: requires >= 5 samples and a median absolute
 * deviation <= 0.04 s, otherwise throws a CalibrationError ('insufficient' / 'unstable').
 */
export function computeLatency(samples: number[]): CalibrationResult {
  if (samples.length < CALIBRATION_MIN_SAMPLES) throw new CalibrationError('insufficient', samples.slice());
  const med = median(samples);
  const mad = median(samples.map((s) => Math.abs(s - med)));
  if (mad > CALIBRATION_MAX_MAD_SEC + 1e-9) throw new CalibrationError('unstable', samples.slice());
  const latencySec = Math.min(CALIBRATION_MAX_LATENCY_SEC, Math.max(CALIBRATION_MIN_LATENCY_SEC, med));
  return { latencySec, samples: samples.slice() };
}

/** RAW onset time of a frame: the refined in-frame time when available, else the frame end. */
export function frameOnsetTime(frame: DetectorFrame): number {
  return frame.onsetTimeSec ?? frame.timeSec;
}

/**
 * Runs a calibration: n clicks at clock.now() + 1 + i * intervalSec, one sample per click from
 * the nearest RAW onset (onsetTimeSec ?? timeSec) in [nominal - 0.15, nominal + 0.5]. Resolves
 * with median(onset - nominal) clamped to [-0.1, 0.5], or rejects with a CalibrationError.
 * Settles (via setTimeout) at the latest 1 s after the last nominal click, earlier when the
 * detector's frames show that every window has closed.
 */
export function runCalibration(
  source: DetectorSource,
  clicks: ClickScheduler,
  clock: Clock,
  opts: CalibrationOpts = {},
): Promise<CalibrationResult> {
  return new Promise<CalibrationResult>((resolve, reject) => {
    const n = opts.n ?? CALIBRATION_DEFAULT_CLICKS;
    const intervalSec = opts.intervalSec ?? CALIBRATION_DEFAULT_INTERVAL_SEC;
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
    if (!(intervalSec > 0) || !Number.isFinite(intervalSec)) throw new RangeError(`intervalSec must be > 0, got ${intervalSec}`);
    if (opts.signal?.aborted) throw new CalibrationError('cancelled');

    const t0 = clock.now();
    const nominals: number[] = [];
    for (let i = 0; i < n; i++) nominals.push(t0 + CALIBRATION_LEAD_SEC + i * intervalSec);
    const lastNominal = nominals[n - 1];
    const settleAt = lastNominal + CALIBRATION_WINDOW_AFTER_SEC + CALIBRATION_SETTLE_SEC;

    const onsets: number[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let unsubscribe: (() => void) | null = null;
    let done = false;

    const cleanup = (): void => {
      done = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      unsubscribe?.();
      unsubscribe = null;
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (): void => {
      if (done) return;
      cleanup();
      try {
        resolve(computeLatency(matchClicksToOnsets(nominals, onsets)));
      } catch (err) {
        reject(err);
      }
    };
    const onAbort = (): void => {
      if (done) return;
      cleanup();
      clicks.clear();
      reject(new CalibrationError('cancelled', matchClicksToOnsets(nominals, onsets)));
    };
    const report = (i: number): void => {
      if (done || !opts.onProgress) return;
      try {
        opts.onProgress(i);
      } catch (err) {
        console.error('calibration onProgress failed', err);
      }
    };

    unsubscribe = source.onFrame((frame) => {
      if (done) return;
      if (frame.onset) onsets.push(frameOnsetTime(frame));
      if (frame.timeSec >= settleAt) finish();
    });
    opts.signal?.addEventListener('abort', onAbort);

    for (let i = 0; i < n; i++) clicks.scheduleClick(nominals[i], i === 0);
    for (let i = 0; i < n; i++) {
      timers.push(setTimeout(() => report(i + 1), Math.max(0, (nominals[i] - t0) * 1000)));
    }
    timers.push(setTimeout(finish, Math.max(0, (lastNominal + CALIBRATION_TAIL_SEC - t0) * 1000)));
  });
}
