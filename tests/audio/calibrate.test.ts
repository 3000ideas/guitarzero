import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALIBRATION_MAX_LATENCY_SEC,
  CALIBRATION_MAX_MAD_SEC,
  CALIBRATION_MESSAGES,
  CALIBRATION_MIN_LATENCY_SEC,
  CALIBRATION_SETTLE_SEC,
  CALIBRATION_WINDOW_AFTER_SEC,
  CalibrationError,
  computeLatency,
  frameOnsetTime,
  matchClicksToOnsets,
  median,
  runCalibration,
} from '../../src/audio/calibrate';
import type { ClickScheduler, Clock, DetectorFrame, DetectorSource } from '../../src/types';

// ---------------------------------------------------------------- fakes

class FakeClock implements Clock {
  t: number;
  constructor(t = 100) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
}

class FakeSource implements DetectorSource {
  readonly subs = new Set<(frame: DetectorFrame) => void>();
  onFrame(cb: (frame: DetectorFrame) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  emit(frame: DetectorFrame): void {
    for (const cb of Array.from(this.subs)) cb(frame);
  }
}

class FakeClicks implements ClickScheduler {
  readonly scheduled: Array<{ t: number; accent: boolean }> = [];
  clears = 0;
  scheduleClick(timeSec: number, accent: boolean): void {
    this.scheduled.push({ t: timeSec, accent });
  }
  clear(): void {
    this.clears++;
  }
}

function frame(timeSec: number, patch: Partial<DetectorFrame> = {}): DetectorFrame {
  return {
    timeSec,
    rmsDb: -30,
    onset: false,
    energyChroma: new Float32Array(12),
    chroma: new Float32Array(12),
    bestChord: null,
    ...patch,
  };
}

/** A frame carrying an accepted onset refined to `onsetSec`; the frame itself ends 80 ms later. */
function onsetFrame(onsetSec: number): DetectorFrame {
  return frame(onsetSec + 0.08, { onset: true, onsetTimeSec: onsetSec });
}

interface Harness {
  clock: FakeClock;
  source: FakeSource;
  clicks: FakeClicks;
  progress: number[];
  nominals: number[];
  promise: Promise<{ latencySec: number; samples: number[] }>;
  advance(sec: number): void;
  settled(): Promise<'pending' | 'resolved' | 'rejected'>;
}

function setup(opts: { n?: number; intervalSec?: number; signal?: AbortSignal } = {}): Harness {
  const clock = new FakeClock(100);
  const source = new FakeSource();
  const clicks = new FakeClicks();
  const progress: number[] = [];
  const n = opts.n ?? 8;
  const interval = opts.intervalSec ?? 1;
  const nominals = Array.from({ length: n }, (_, i) => 100 + 1 + i * interval);
  const promise = runCalibration(source, clicks, clock, { ...opts, onProgress: (i) => progress.push(i) });
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return {
    clock,
    source,
    clicks,
    progress,
    nominals,
    promise,
    advance(sec: number) {
      clock.t += sec;
      vi.advanceTimersByTime(sec * 1000);
    },
    async settled() {
      await vi.advanceTimersByTimeAsync(0);
      return state;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- pure helpers

describe('median', () => {
  it('handles odd and even counts and ignores order', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('matchClicksToOnsets', () => {
  it('takes the nearest onset inside [nominal - 0.15, nominal + 0.5] and ignores the rest', () => {
    // click at 10: onsets at 9.8 (too early), 9.9 (in window, 0.1 away), 10.05 (nearest), 10.6 (too late)
    expect(matchClicksToOnsets([10], [9.8, 9.9, 10.05, 10.6])).toEqual([10.05 - 10]);
    // window bounds are inclusive
    expect(matchClicksToOnsets([10], [9.85])).toEqual([9.85 - 10]);
    expect(matchClicksToOnsets([10], [10.5])).toEqual([0.5]);
    expect(matchClicksToOnsets([10], [9.849])).toEqual([]);
    expect(matchClicksToOnsets([10], [10.501])).toEqual([]);
  });

  it('produces one sample per matched click, in click order, and never reuses an onset', () => {
    expect(matchClicksToOnsets([1, 2, 3], [1.1, 3.05])).toEqual([1.1 - 1, 3.05 - 3]);
    // clicks 0.3 s apart share a window: the single onset serves only the click it is closest to
    expect(matchClicksToOnsets([1, 1.3], [1.28])).toEqual([1.28 - 1]);
    expect(matchClicksToOnsets([1, 1.3], [1.28, 1.31]).map((s) => +s.toFixed(3))).toEqual([0.28, 0.01]);
    expect(matchClicksToOnsets([], [1, 2])).toEqual([]);
    expect(matchClicksToOnsets([1, 2], [])).toEqual([]);
  });
});

describe('computeLatency', () => {
  it('needs at least 5 samples', () => {
    expect(() => computeLatency([0.08, 0.08, 0.08, 0.08])).toThrow(CalibrationError);
    try {
      computeLatency([0.08, 0.08, 0.08, 0.08]);
    } catch (e) {
      expect(e).toBeInstanceOf(CalibrationError);
      expect((e as CalibrationError).code).toBe('insufficient');
      expect((e as CalibrationError).message).toBe('No se detectaron suficientes rasgueos');
      expect((e as CalibrationError).samples).toEqual([0.08, 0.08, 0.08, 0.08]);
    }
    expect(computeLatency([0.08, 0.08, 0.08, 0.08, 0.08]).latencySec).toBeCloseTo(0.08, 9);
  });

  it('accepts a median absolute deviation of exactly the limit and rejects just above it', () => {
    const m = CALIBRATION_MAX_MAD_SEC;
    expect(computeLatency([0.1, 0.1 + m, 0.1 - m, 0.1 + m, 0.1 - m]).latencySec).toBeCloseTo(0.1, 9);
    const over = m + 0.01;
    expect(() => computeLatency([0.1, 0.1 + over, 0.1 - over, 0.1 + over, 0.1 - over])).toThrow(
      'Demasiada variación, repite la calibración',
    );
    try {
      computeLatency([0.1, 0.1 + over, 0.1 - over, 0.1 + over, 0.1 - over]);
    } catch (e) {
      expect((e as CalibrationError).code).toBe('unstable');
    }
  });

  it('is robust to a single outlier (median, not mean)', () => {
    const r = computeLatency([0.08, 0.081, 0.079, 0.08, 0.45, 0.08, 0.082, 0.078]);
    expect(r.latencySec).toBeCloseTo(0.08, 9);
    expect(r.samples).toHaveLength(8);
  });

  it('clamps the median to [-0.1, 0.5]', () => {
    expect(computeLatency([-0.14, -0.14, -0.13, -0.15, -0.14]).latencySec).toBe(CALIBRATION_MIN_LATENCY_SEC);
    expect(computeLatency([0.5, 0.5, 0.5, 0.5, 0.5]).latencySec).toBe(CALIBRATION_MAX_LATENCY_SEC);
    expect(computeLatency([0.3, 0.31, 0.29, 0.3, 0.3]).latencySec).toBeCloseTo(0.3, 9);
  });

  it('returns a copy of the samples', () => {
    const input = [0.1, 0.1, 0.1, 0.1, 0.1];
    const r = computeLatency(input);
    expect(r.samples).toEqual(input);
    expect(r.samples).not.toBe(input);
  });
});

describe('frameOnsetTime', () => {
  it('prefers the refined onsetTimeSec and falls back to timeSec', () => {
    expect(frameOnsetTime(frame(5, { onset: true, onsetTimeSec: 4.9 }))).toBe(4.9);
    expect(frameOnsetTime(frame(5, { onset: true }))).toBe(5);
  });
});

// ---------------------------------------------------------------- runCalibration

describe('runCalibration', () => {
  it('schedules n clicks at now + 1 + i * intervalSec, the first one accented', () => {
    const h = setup();
    expect(h.clicks.scheduled.map((c) => c.t)).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(h.clicks.scheduled.map((c) => c.accent)).toEqual([true, false, false, false, false, false, false, false]);
    expect(h.source.subs.size).toBe(1);
    h.advance(20); // let it settle so no timer leaks into the next test
  });

  it('SPEC: 8 clicks with onsets at +80 ms -> latencySec ≈ 0.08', async () => {
    const h = setup();
    for (const nominal of h.nominals) h.source.emit(onsetFrame(nominal + 0.08));
    // a few non-onset frames must not disturb anything
    h.source.emit(frame(104.5));
    expect(await h.settled()).toBe('pending');
    h.advance(9); // 1 s lead + 7 intervals + 1 s tail
    const r = await h.promise;
    expect(r.latencySec).toBeCloseTo(0.08, 6);
    expect(r.samples).toHaveLength(8);
    for (const s of r.samples) expect(s).toBeCloseTo(0.08, 6);
    expect(h.progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(h.source.subs.size).toBe(0); // unsubscribed
  });

  it('SPEC: only 3 onsets -> rejects with "No se detectaron suficientes rasgueos"', async () => {
    const h = setup();
    for (const nominal of h.nominals.slice(0, 3)) h.source.emit(onsetFrame(nominal + 0.1));
    h.advance(9);
    await expect(h.promise).rejects.toBeInstanceOf(CalibrationError);
    await expect(h.promise).rejects.toThrow(CALIBRATION_MESSAGES.insufficient);
    await h.promise.catch((e: CalibrationError) => {
      expect(e.code).toBe('insufficient');
      expect(e.samples).toHaveLength(3);
    });
    expect(h.source.subs.size).toBe(0);
  });

  it('high variance -> rejects with "Demasiada variación, repite la calibración"', async () => {
    const h = setup();
    const offsets = [0.0, 0.3, -0.1, 0.4, 0.05, 0.35, -0.05, 0.45];
    h.nominals.forEach((nominal, i) => h.source.emit(onsetFrame(nominal + offsets[i])));
    h.advance(9);
    await expect(h.promise).rejects.toThrow('Demasiada variación, repite la calibración');
    await h.promise.catch((e: CalibrationError) => expect(e.code).toBe('unstable'));
  });

  it('uses onsetTimeSec ?? timeSec and ignores frames without an onset', async () => {
    const h = setup();
    h.nominals.forEach((nominal, i) => {
      if (i % 2 === 0) {
        h.source.emit(frame(nominal + 0.12, { onset: true })); // no refinement: the frame end is the onset
      } else {
        h.source.emit(onsetFrame(nominal + 0.12));
      }
      h.source.emit(frame(nominal + 0.3, { onset: false, onsetTimeSec: nominal })); // onset === false: ignored
    });
    h.advance(9);
    const r = await h.promise;
    expect(r.latencySec).toBeCloseTo(0.12, 6);
    expect(r.samples).toHaveLength(8);
  });

  it('matches each click to the nearest RAW onset inside [nominal - 0.15, nominal + 0.5]', async () => {
    const h = setup();
    for (const nominal of h.nominals) {
      h.source.emit(onsetFrame(nominal - 0.2)); // outside (too early)
      h.source.emit(onsetFrame(nominal - 0.1)); // inside but farther than the next one
      h.source.emit(onsetFrame(nominal + 0.06)); // nearest
      h.source.emit(onsetFrame(nominal + 0.55)); // outside (too late)
    }
    h.advance(9);
    const r = await h.promise;
    expect(r.latencySec).toBeCloseTo(0.06, 6);
    for (const s of r.samples) expect(s).toBeCloseTo(0.06, 6);
  });

  it('clamps the result to [-0.1, 0.5]', async () => {
    const early = setup();
    for (const nominal of early.nominals) early.source.emit(onsetFrame(nominal - 0.14));
    early.advance(9);
    expect((await early.promise).latencySec).toBe(-0.1);

    const late = setup();
    for (const nominal of late.nominals) late.source.emit(onsetFrame(nominal + 0.5));
    late.advance(9);
    expect((await late.promise).latencySec).toBe(0.5);
  });

  it('settles via setTimeout at the latest 1 s after the last nominal click', async () => {
    const h = setup();
    for (const nominal of h.nominals) h.source.emit(onsetFrame(nominal + 0.08));
    h.advance(8.99);
    expect(await h.settled()).toBe('pending');
    h.advance(0.01);
    expect(await h.settled()).toBe('resolved');
  });

  it('rejects (insufficient) when no frame ever arrives', async () => {
    const h = setup();
    h.advance(9);
    await expect(h.promise).rejects.toThrow(CALIBRATION_MESSAGES.insufficient);
    expect(h.progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('settles early once the frames show the last window has closed', async () => {
    const h = setup();
    for (const nominal of h.nominals) h.source.emit(onsetFrame(nominal + 0.08));
    const last = h.nominals[h.nominals.length - 1];
    h.source.emit(frame(last + CALIBRATION_WINDOW_AFTER_SEC + CALIBRATION_SETTLE_SEC - 0.01));
    expect(await h.settled()).toBe('pending');
    h.source.emit(frame(last + CALIBRATION_WINDOW_AFTER_SEC + CALIBRATION_SETTLE_SEC));
    expect(await h.settled()).toBe('resolved');
    expect((await h.promise).latencySec).toBeCloseTo(0.08, 6);
    expect(h.source.subs.size).toBe(0);
    h.advance(20); // the deadline timer was cleared: nothing else happens
    expect(h.progress).toEqual([]); // finished before any nominal click passed on the timer clock
  });

  it('honours n and intervalSec', async () => {
    const h = setup({ n: 5, intervalSec: 0.5 });
    expect(h.clicks.scheduled.map((c) => c.t)).toEqual([101, 101.5, 102, 102.5, 103]);
    for (const nominal of h.nominals) h.source.emit(onsetFrame(nominal + 0.05));
    h.advance(1 + 4 * 0.5 + 1);
    const r = await h.promise;
    expect(r.samples).toHaveLength(5);
    expect(r.latencySec).toBeCloseTo(0.05, 6);
    expect(h.progress).toEqual([1, 2, 3, 4, 5]);
  });

  it('4 matched clicks are not enough, 5 are', async () => {
    const four = setup();
    for (const nominal of four.nominals.slice(0, 4)) four.source.emit(onsetFrame(nominal + 0.1));
    four.advance(9);
    await expect(four.promise).rejects.toThrow(CALIBRATION_MESSAGES.insufficient);

    const five = setup();
    for (const nominal of five.nominals.slice(0, 5)) five.source.emit(onsetFrame(nominal + 0.1));
    five.advance(9);
    expect((await five.promise).samples).toHaveLength(5);
  });

  it('can be cancelled with an AbortSignal: clears the clicks and rejects', async () => {
    const controller = new AbortController();
    const h = setup({ signal: controller.signal });
    h.source.emit(onsetFrame(h.nominals[0] + 0.08));
    h.advance(1.5);
    controller.abort();
    await expect(h.promise).rejects.toThrow(CALIBRATION_MESSAGES.cancelled);
    await h.promise.catch((e: CalibrationError) => {
      expect(e.code).toBe('cancelled');
      expect(e.samples).toHaveLength(1);
    });
    expect(h.clicks.clears).toBe(1);
    expect(h.source.subs.size).toBe(0);
    h.advance(20);
    expect(h.progress).toEqual([1]); // only the click that passed before the abort
  });

  it('rejects invalid options without scheduling anything', async () => {
    const clicks = new FakeClicks();
    await expect(runCalibration(new FakeSource(), clicks, new FakeClock(), { n: 0 })).rejects.toThrow(RangeError);
    await expect(runCalibration(new FakeSource(), clicks, new FakeClock(), { intervalSec: 0 })).rejects.toThrow(RangeError);
    expect(clicks.scheduled).toEqual([]);
  });
});
