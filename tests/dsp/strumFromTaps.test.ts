import { describe, expect, it } from 'vitest';
import type { StrumDetection } from '../../src/types';
import { patternFromTaps } from '../../src/dsp/strumFromTaps';
import { makeRng, rampBeatTimes } from '../helpers/synth';

/** Beat times of a constant tempo: `beats` beats at `bpm` from `startSec`. */
function constantBeats(bpm: number, beats: number, startSec = 0): number[] {
  return Array.from({ length: beats }, (_, i) => startSec + (i * 60) / bpm);
}

/**
 * Tap times of `pattern` (D/U/- at `pattern.length / beatsPerBar` characters per beat) played
 * for `bars` bars on `beatTimes` (slots interpolated between consecutive beats, extrapolated
 * with the last interval past the end).
 */
function tapsFor(pattern: string, beatTimes: number[], beatsPerBar: number, bars: number): number[] {
  const cpb = pattern.length / beatsPerBar;
  const last = beatTimes.length - 1;
  const lastInterval = beatTimes[last] - beatTimes[last - 1];
  const beatAt = (j: number): number => (j <= last ? beatTimes[j] : beatTimes[last] + (j - last) * lastInterval);
  const taps: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < pattern.length; k++) {
      if (pattern[k] === '-') continue;
      const beat = b * beatsPerBar + Math.floor(k / cpb);
      const a = beatAt(beat);
      const t = a + ((k % cpb) / cpb) * (beatAt(beat + 1) - a);
      taps.push(t);
    }
  }
  return taps;
}

/** Number of positions where two patterns of the same length have the same character. */
function agreement(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) n++;
  return n;
}

function describeDetection(d: StrumDetection): string {
  return `${d.pattern} (cpb ${d.charsPerBeat}, conf ${d.confidence.toFixed(2)}, ${d.bars} bars, slots ${d.slotStrength
    .map((v) => v.toFixed(2))
    .join(' ')})`;
}

function expectWellFormed(d: StrumDetection, beatsPerBar: number): void {
  expect([2, 4]).toContain(d.charsPerBeat);
  expect(d.pattern).toHaveLength(d.charsPerBeat * beatsPerBar);
  expect(d.pattern).toMatch(/^[DU-]+$/);
  expect(d.slotStrength).toHaveLength(d.pattern.length);
  for (const v of d.slotStrength) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
  expect(d.confidence).toBeGreaterThanOrEqual(0);
  expect(d.confidence).toBeLessThanOrEqual(1);
  expect(Number.isInteger(d.bars)).toBe(true);
}

const BEATS_100 = constantBeats(100, 40);

describe('patternFromTaps', () => {
  it('exact taps of D-DU-UDU over 8 bars at 100 BPM -> same pattern, charsPerBeat 2, confidence 1, 8 bars', () => {
    const taps = tapsFor('D-DU-UDU', BEATS_100, 4, 8);
    expect(taps).toHaveLength(48);
    const d = patternFromTaps(taps, BEATS_100, 4);
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence).toBe(1);
    expect(d.bars).toBe(8);
    expect(d.slotStrength).toEqual([1, 0, 1, 1, 0, 1, 1, 1]);
  });

  it('the same taps with +90 ms of constant latency -> same pattern (auto latency)', () => {
    const taps = tapsFor('D-DU-UDU', BEATS_100, 4, 8).map((t) => t + 0.09);
    const d = patternFromTaps(taps, BEATS_100, 4);
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence).toBe(1);
    expect(d.bars).toBe(8);
    // Without the correction the same taps would smear onto the sixteenths.
    const raw = patternFromTaps(taps, BEATS_100, 4, { latencySec: 0 });
    expect(raw.pattern, describeDetection(raw)).not.toBe('D-DU-UDU');
    // An explicit latency is honoured as given.
    const explicit = patternFromTaps(taps, BEATS_100, 4, { latencySec: 0.09 });
    expect(explicit.pattern).toBe('D-DU-UDU');
    expect(explicit.confidence).toBe(1);
  });

  it('taps with +-40 ms of jitter -> same pattern, confidence >= 0.75', () => {
    const rng = makeRng(7);
    const taps = tapsFor('D-DU-UDU', BEATS_100, 4, 8).map((t) => t + (rng() * 2 - 1) * 0.04);
    const d = patternFromTaps(taps, BEATS_100, 4);
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence).toBeGreaterThanOrEqual(0.75);
    expect(d.bars).toBe(8);
    // Jitter on top of latency, too.
    const rng2 = makeRng(11);
    const late = tapsFor('D-DU-UDU', BEATS_100, 4, 8).map((t) => t + 0.12 + (rng2() * 2 - 1) * 0.04);
    const dl = patternFromTaps(late, BEATS_100, 4);
    expect(dl.pattern, describeDetection(dl)).toBe('D-DU-UDU');
    expect(dl.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('one bar with an extra tap does not change the pattern', () => {
    const taps = tapsFor('D-DU-UDU', BEATS_100, 4, 8);
    // Bar 3, slot 4 (the '-' on beat 3): 3 bars * 2.4 s + 1.2 s.
    taps.push(3 * 2.4 + 1.2);
    const d = patternFromTaps(taps, BEATS_100, 4);
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.bars).toBe(8);
    // That bar still agrees in 7 of 8 positions, so it counts.
    expect(d.confidence).toBe(1);
    expect(d.slotStrength[4]).toBeCloseTo(1 / 8, 10);
    // A bar with a missing tap: the pattern holds and that bar still agrees (7 of 8).
    const missing = tapsFor('D-DU-UDU', BEATS_100, 4, 8).filter((t) => Math.abs(t - (2 * 2.4 + 0.9)) > 1e-9);
    const dm = patternFromTaps(missing, BEATS_100, 4);
    expect(dm.pattern, describeDetection(dm)).toBe('D-DU-UDU');
    expect(dm.confidence).toBe(1);
  });

  it('sixteenths D-DUD-DUD-DUD-DU -> charsPerBeat 4 and >= 14 of 16 positions right', () => {
    const taps = tapsFor('D-DUD-DUD-DUD-DU', BEATS_100, 4, 8);
    const d = patternFromTaps(taps, BEATS_100, 4);
    expectWellFormed(d, 4);
    expect(d.charsPerBeat, describeDetection(d)).toBe(4);
    expect(agreement(d.pattern, 'D-DUD-DUD-DUD-DU'), describeDetection(d)).toBeGreaterThanOrEqual(14);
    expect(d.bars).toBe(8);
    // With a small latency the sixteenths still come out.
    const late = taps.map((t) => t + 0.04);
    const dl = patternFromTaps(late, BEATS_100, 4);
    expect(dl.charsPerBeat, describeDetection(dl)).toBe(4);
    expect(agreement(dl.pattern, 'D-DUD-DUD-DUD-DU'), describeDetection(dl)).toBeGreaterThanOrEqual(14);
    // A plain eighth pattern with sixteenths lands at eighth resolution.
    const eighths = patternFromTaps(tapsFor('DUDUDUDU', BEATS_100, 4, 8), BEATS_100, 4);
    expect(eighths.pattern, describeDetection(eighths)).toBe('DUDUDUDU');
    expect(eighths.charsPerBeat).toBe(2);
  });

  it('follows a tempo ramp when the taps sit on the ramped beat grid', () => {
    // 90 -> 110 BPM over 30 s: a constant grid would drift by several slots.
    const beats = rampBeatTimes(90, 110, 0, 30);
    const taps = tapsFor('D-DU-UDU', beats, 4, 10);
    const d = patternFromTaps(taps, beats, 4);
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence).toBe(1);
    expect(d.bars).toBe(10);
    // The same taps against a constant 90 BPM grid do not match: the ramp matters.
    const wrong = patternFromTaps(taps, constantBeats(90, 40), 4);
    expect(wrong.confidence, describeDetection(wrong)).toBeLessThan(1);
    // Anacrusis-style grid: beat 0 later than 0 s, and a 3/4 pattern.
    const waltz = constantBeats(120, 30, 1.25);
    const dw = patternFromTaps(tapsFor('D-DUDU', waltz, 3, 8), waltz, 3);
    expect(dw.pattern, describeDetection(dw)).toBe('D-DUDU');
    expect(dw.bars).toBe(8);
    expect(dw.confidence).toBe(1);
  });

  it('no taps -> one down-strum per beat, confidence 0, 0 bars', () => {
    const d = patternFromTaps([], BEATS_100, 4);
    expect(d).toEqual({ pattern: 'D-D-D-D-', charsPerBeat: 2, slotStrength: [0, 0, 0, 0, 0, 0, 0, 0], confidence: 0, bars: 0 });
    expect(patternFromTaps([], BEATS_100, 3).pattern).toBe('D-D-D-');
    // Non-finite taps are ignored; a grid of one beat cannot place anything.
    expect(patternFromTaps([Number.NaN, Number.POSITIVE_INFINITY], BEATS_100, 4).bars).toBe(0);
    expect(patternFromTaps([0, 0.6], [0], 4).pattern).toBe('D-D-D-D-');
    // Taps scattered too thinly over many bars activate no slot: default with confidence 0.
    const sparse = [0.9, 2.4 * 3 + 1.5, 2.4 * 6 + 0.3, 2.4 * 9 + 2.1, 2.4 * 12 + 1.8];
    const ds = patternFromTaps(sparse, BEATS_100, 4);
    expect(ds.pattern).toBe('D-D-D-D-');
    expect(ds.confidence).toBe(0);
    expect(ds.bars).toBe(5);
    expect(() => patternFromTaps([0], BEATS_100, 0)).toThrow(RangeError);
    expect(() => patternFromTaps([0], BEATS_100, 2.5)).toThrow(RangeError);
  });

  it('bars past the tracked beats are extrapolated, silent bars do not count, an early downbeat stays on its bar', () => {
    // 4 bars of beats (16), taps over 8 bars: the second half of the taps falls on extrapolated bars.
    const short = constantBeats(100, 16);
    const d = patternFromTaps(tapsFor('D-DU-UDU', BEATS_100, 4, 8), short, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.bars).toBe(8);
    expect(d.confidence).toBe(1);
    // Bars 2..5 without taps: only 4 bars count, and the confidence is not diluted by them.
    const gapped = tapsFor('D-DU-UDU', BEATS_100, 4, 8).filter((t) => t < 2 * 2.4 || t >= 6 * 2.4);
    const dg = patternFromTaps(gapped, BEATS_100, 4);
    expect(dg.pattern).toBe('D-DU-UDU');
    expect(dg.bars).toBe(4);
    expect(dg.confidence).toBe(1);
    // Every downbeat tapped 50 ms early (explicit latency 0 so nothing is corrected): still slot 0 of its bar.
    const early = tapsFor('D-DU-UDU', BEATS_100, 4, 8).map((t, i) => (i % 6 === 0 ? t - 0.05 : t));
    const de = patternFromTaps(early, BEATS_100, 4, { latencySec: 0 });
    expect(de.pattern, describeDetection(de)).toBe('D-DU-UDU');
    expect(de.bars).toBe(8);
    expect(de.confidence).toBe(1);
    // minBarFraction: a slot tapped in 3 of 8 bars is a strum at 0.3 but not at the default 0.5.
    const some = tapsFor('D-D-D-D-', BEATS_100, 4, 8);
    for (const b of [1, 4, 6]) some.push(b * 2.4 + 0.3);
    expect(patternFromTaps(some, BEATS_100, 4).pattern).toBe('D-D-D-D-');
    expect(patternFromTaps(some, BEATS_100, 4, { minBarFraction: 0.3 }).pattern).toBe('DUD-D-D-');
  });

  it('slotStrength is the fraction of bars with a tap in the slot: bounces in one bar count once', () => {
    // Bar 1, slot 1 (the "and" of beat 1) tapped three times within 40 ms: one bar out of 8.
    const taps = tapsFor('D-D-D-D-', BEATS_100, 4, 8);
    for (const dt of [0, 0.02, 0.04]) taps.push(2.4 + 0.3 + dt);
    const d = patternFromTaps(taps, BEATS_100, 4, { latencySec: 0 });
    expectWellFormed(d, 4);
    expect(d.slotStrength[1]).toBeCloseTo(1 / 8, 10);
    expect(d.pattern, describeDetection(d)).toBe('D-D-D-D-');
    // Even at a threshold the three raw taps would pass (3/8 >= 0.3), one bar is not enough.
    expect(patternFromTaps(taps, BEATS_100, 4, { latencySec: 0, minBarFraction: 0.3 }).pattern).toBe('D-D-D-D-');
    // Every downbeat tapped twice: strength stays 1, never above.
    const doubled = tapsFor('D-D-D-D-', BEATS_100, 4, 8).flatMap((t, i) => (i % 4 === 0 ? [t, t + 0.03] : [t]));
    const dd = patternFromTaps(doubled, BEATS_100, 4, { latencySec: 0 });
    expect(dd.slotStrength).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    expect(dd.pattern).toBe('D-D-D-D-');
    expect(dd.confidence).toBe(1);
  });
});
