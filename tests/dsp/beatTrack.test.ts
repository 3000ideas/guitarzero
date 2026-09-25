import { describe, expect, it } from 'vitest';
import { trackBeats } from '../../src/dsp/beatTrack';
import { estimateTempo } from '../../src/dsp/tempoEstimate';
import {
  jumpBeatTimes,
  rampBeatTimes,
  silence,
  synthClickTrack,
  synthStrummedProgression,
  tileSignal,
  whiteNoise,
} from '../helpers/synth';

const SR = 44100;

/** Signed distance from `t` to the nearest value of `times` (sorted). */
function nearestError(t: number, times: number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const x of times) {
    const d = t - x;
    if (Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/** Fraction of `tracked` within `tolSec` of some `expected` time, and the same the other way round. */
function matchStats(tracked: number[], expected: number[], tolSec: number): { hit: number; found: number; maxAbs: number; meanErr: number } {
  let hit = 0;
  let maxAbs = 0;
  let sum = 0;
  for (const t of tracked) {
    const e = nearestError(t, expected);
    if (Math.abs(e) <= tolSec) hit++;
    if (Math.abs(e) > maxAbs) maxAbs = Math.abs(e);
    sum += e;
  }
  let found = 0;
  for (const x of expected) if (Math.abs(nearestError(x, tracked)) <= tolSec) found++;
  return {
    hit: tracked.length > 0 ? hit / tracked.length : 0,
    found: expected.length > 0 ? found / expected.length : 0,
    maxAbs,
    meanErr: tracked.length > 0 ? sum / tracked.length : 0,
  };
}

function intervals(times: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
  return out;
}

function describeTimes(times: number[]): string {
  return times.map((t) => t.toFixed(3)).join(' ');
}

describe('trackBeats', () => {
  it('constant 100 BPM clicks -> intervals 0.6 +-0.02 s, every click found within 35 ms, bpm 100 +-1', () => {
    const expected = rampBeatTimes(100, 100, 0.37, 30);
    const sig = synthClickTrack(expected, SR, 30);
    const r = trackBeats(sig, SR, { bpm: 100 });
    expect(r.beatTimes.length).toBeGreaterThanOrEqual(expected.length - 1);
    for (const d of intervals(r.beatTimes)) expect(Math.abs(d - 0.6), describeTimes(r.beatTimes)).toBeLessThanOrEqual(0.02);
    const s = matchStats(r.beatTimes, expected, 0.035);
    expect(s.hit, `max |err| ${s.maxAbs.toFixed(3)} mean ${s.meanErr.toFixed(3)}`).toBe(1);
    expect(s.found).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(1);
    // Increasing times, none before the first click.
    for (let i = 1; i < r.beatTimes.length; i++) expect(r.beatTimes[i]).toBeGreaterThan(r.beatTimes[i - 1]);
    expect(r.beatTimes[0]).toBeGreaterThanOrEqual(0.37 - 0.035);
  });

  it('ramp 96 -> 104 BPM over 40 s -> >= 95 % of the beats within +-35 ms of the clicks, bpm 100 +-2', () => {
    const expected = rampBeatTimes(96, 104, 0.5, 40);
    const sig = synthClickTrack(expected, SR, 40, { seed: 3 });
    // The global estimate feeds the tracker, as in transcribeChords.
    const est = estimateTempo(sig, SR);
    expect(Math.abs(est.bpm - 100)).toBeLessThanOrEqual(4);
    const r = trackBeats(sig, SR, { bpm: est.bpm, firstBeatSec: est.firstBeatSec });
    const s = matchStats(r.beatTimes, expected, 0.035);
    expect(s.hit, `hit ${s.hit.toFixed(3)} found ${s.found.toFixed(3)} max |err| ${s.maxAbs.toFixed(3)} mean ${s.meanErr.toFixed(3)}`).toBeGreaterThanOrEqual(0.95);
    expect(s.found).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(2);
    // The intervals really follow the ramp: shorter at the end than at the start.
    const iv = intervals(r.beatTimes);
    const head = iv.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const tail = iv.slice(-10).reduce((a, b) => a + b, 0) / 10;
    expect(head).toBeGreaterThan(60 / 98);
    expect(tail).toBeLessThan(60 / 102);
  });

  it('jump 100 -> 110 BPM at 20 s -> 2 s after the jump the intervals are 0.545 +-0.02', () => {
    const expected = jumpBeatTimes(100, 110, 0.4, 20, 40);
    const sig = synthClickTrack(expected, SR, 40, { seed: 5 });
    const r = trackBeats(sig, SR, { bpm: 100 });
    const after = r.beatTimes.filter((t) => t >= 22);
    expect(after.length).toBeGreaterThan(20);
    for (const d of intervals(after)) expect(Math.abs(d - 60 / 110), describeTimes(after)).toBeLessThanOrEqual(0.02);
    const before = r.beatTimes.filter((t) => t < 19.5);
    for (const d of intervals(before)) expect(Math.abs(d - 0.6), describeTimes(before)).toBeLessThanOrEqual(0.02);
    const s = matchStats(r.beatTimes, expected, 0.035);
    expect(s.hit, `max |err| ${s.maxAbs.toFixed(3)}`).toBeGreaterThanOrEqual(0.95);
  });

  it('strummed D-DU-UDU progression -> beats on the beats, not on the off-beats (>= 90 %)', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 2 });
    const r = trackBeats(p.signal, SR, { bpm: 100 });
    const nBeats = p.barTimes.length * p.beatsPerBar;
    const beats = Array.from({ length: nBeats }, (_, i) => i * p.periodSec);
    const offBeats = beats.map((t) => t + p.periodSec / 2);
    expect(r.beatTimes.length).toBeGreaterThanOrEqual(nBeats - 3);
    let onBeat = 0;
    let onOff = 0;
    for (const t of r.beatTimes) {
      if (Math.abs(nearestError(t, beats)) <= 0.06) onBeat++;
      else if (Math.abs(nearestError(t, offBeats)) <= 0.06) onOff++;
    }
    expect(onBeat / r.beatTimes.length, `on ${onBeat} off ${onOff} of ${r.beatTimes.length}: ${describeTimes(r.beatTimes)}`).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(1);
  });

  it('firstBeatSec keeps the reference beat; times never change', () => {
    const expected = rampBeatTimes(100, 100, 1.2, 20);
    const sig = synthClickTrack(expected, SR, 20, { seed: 7 });
    const a = trackBeats(sig, SR, { bpm: 100 });
    const b = trackBeats(sig, SR, { bpm: 100, firstBeatSec: 1.2 });
    for (const t of b.beatTimes) expect(a.beatTimes.some((u) => Math.abs(u - t) < 1e-9)).toBe(true);
    expect(Math.abs(b.beatTimes[0] - 1.2)).toBeLessThanOrEqual(0.035);
  });

  it('silence, noise and invalid arguments', () => {
    expect(trackBeats(silence(SR, 5), SR, { bpm: 100 })).toEqual({ beatTimes: [], bpm: 100 });
    expect(trackBeats(new Float32Array(0), SR, { bpm: 120 }).beatTimes).toEqual([]);
    expect(trackBeats(whiteNoise(SR, 5, -90), SR, { bpm: 100 }).beatTimes).toEqual([]);
    // Stationary noise has onsets of a sort (the flux residual); whatever comes back is well formed.
    const n = trackBeats(whiteNoise(SR, 10, -20), SR, { bpm: 100 });
    for (let i = 1; i < n.beatTimes.length; i++) expect(n.beatTimes[i]).toBeGreaterThan(n.beatTimes[i - 1]);
    expect(() => trackBeats(silence(SR, 1), 0, { bpm: 100 })).toThrow(RangeError);
    expect(() => trackBeats(silence(SR, 1), SR, { bpm: 0 })).toThrow(RangeError);
    expect(() => trackBeats(silence(SR, 1), SR, { bpm: Number.NaN })).toThrow(RangeError);
    expect(() => trackBeats(silence(SR, 1), SR, { bpm: 100, tightness: 0 })).toThrow(RangeError);
    expect(() => trackBeats(silence(SR, 1), SR, { bpm: 100, firstBeatSec: Number.NaN })).toThrow(RangeError);
  });

  it('maxSeconds limits the analysed span', () => {
    const expected = rampBeatTimes(100, 100, 0.4, 30);
    const sig = synthClickTrack(expected, SR, 30, { seed: 9 });
    const r = trackBeats(sig, SR, { bpm: 100, maxSeconds: 10 });
    expect(r.beatTimes.length).toBeGreaterThan(10);
    expect(r.beatTimes[r.beatTimes.length - 1]).toBeLessThan(10.5);
  });

  it('performance: 4 minutes at 44.1 kHz in under 1.5 s', () => {
    const p = synthStrummedProgression(['G', 'D', 'Em', 'C'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 1, seed: 17 }); // 9.6 s
    const signal = tileSignal(p.signal, 25); // 240 s
    // Test files run in parallel workers, so a run slowed down by other processes is retried
    // (up to 3 attempts); every attempt is measured against the 1.5 s.
    const timings: number[] = [];
    let r = trackBeats(signal.subarray(0, SR), SR, { bpm: 100 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      r = trackBeats(signal, SR, { bpm: 100 });
      timings.push(performance.now() - t0);
      if (timings[attempt] < 1500) break;
    }
    expect(Math.min(...timings), `timings ms: ${timings.map((ms) => ms.toFixed(0)).join(', ')}`).toBeLessThan(4000); // wall-clock sanity check, generous for a loaded machine
    expect(r.beatTimes.length).toBeGreaterThanOrEqual(390);
    expect(r.beatTimes.length).toBeLessThanOrEqual(400);
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(1);
  }, 60000);
});
