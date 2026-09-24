import { describe, expect, it } from 'vitest';
import type { StrumDetection } from '../../src/types';
import { detectStrumPattern } from '../../src/dsp/strumDetect';
import { mix, rampBeatTimes, silence, synthClickTrack, synthStrummedProgression, tileSignal, whiteNoise } from '../helpers/synth';

const SR = 44100;

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

/** Common invariants of every result. */
function expectWellFormed(d: StrumDetection, beatsPerBar: number): void {
  expect([1, 2, 4]).toContain(d.charsPerBeat);
  expect(d.pattern).toHaveLength(d.charsPerBeat * beatsPerBar);
  expect(d.pattern).toMatch(/^[DU-]+$/);
  expect(d.pattern[0]).toBe('D');
  expect(d.slotStrength).toHaveLength(d.pattern.length);
  for (const v of d.slotStrength) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
  expect(d.confidence).toBeGreaterThanOrEqual(0);
  expect(d.confidence).toBeLessThanOrEqual(1);
  expect(Number.isInteger(d.bars)).toBe(true);
}

describe('detectStrumPattern', () => {
  it('D-DU-UDU at 100 BPM (C G Am F, 2 rounds) -> D-DU-UDU, charsPerBeat 2, confidence >= 0.8, 8 bars', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 2 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
    expect(d.bars).toBe(8);
    // The strongest slot is a down-strum and every up-strum is clearly above the threshold.
    expect(Math.max(...d.slotStrength)).toBe(1);
    expect(d.slotStrength[3]).toBeGreaterThanOrEqual(0.4);
    expect(d.slotStrength[5]).toBeGreaterThanOrEqual(0.4);
    expect(d.slotStrength[7]).toBeGreaterThanOrEqual(0.4);
    // Rests stay well below it.
    expect(d.slotStrength[1]).toBeLessThan(0.2);
    expect(d.slotStrength[4]).toBeLessThan(0.2);
  });

  it('D-D-D-D- -> D-D-D-D-', () => {
    const p = synthStrummedProgression(['G', 'D', 'Em', 'C'], SR, { bpm: 100, pattern: 'D-D-D-D-', rounds: 2, seed: 5 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-D-D-D-');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('DUDUDUDU -> DUDUDUDU', () => {
    const p = synthStrummedProgression(['Am', 'F', 'C', 'G'], SR, { bpm: 100, pattern: 'DUDUDUDU', rounds: 2, seed: 9 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('DUDUDUDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('D---D--- -> D---D---', () => {
    const p = synthStrummedProgression(['C', 'Am', 'F', 'G'], SR, { bpm: 100, pattern: 'D---D---', rounds: 2, seed: 13 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D---D---');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('3/4 D-DUDU -> D-DUDU', () => {
    const p = synthStrummedProgression(['D', 'G', 'A', 'Bm'], SR, { bpm: 100, pattern: 'D-DUDU', beatsPerBar: 3, rounds: 2, seed: 17 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 3 });
    expectWellFormed(d, 3);
    expect(d.pattern, describeDetection(d)).toBe('D-DUDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
    expect(d.bars).toBe(8);
  });

  it('sixteenths D-DUD-DUD-DUD-DU -> charsPerBeat 4 and >= 14 of 16 positions equal', () => {
    const pattern = 'D-DUD-DUD-DUD-DU';
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern, rounds: 2, seed: 21 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.charsPerBeat, describeDetection(d)).toBe(4);
    expect(agreement(d.pattern, pattern), describeDetection(d)).toBeGreaterThanOrEqual(14);
    // Every "&" (third sixteenth) is a down-strum and every "a" (fourth) an up-strum.
    for (let beat = 0; beat < 4; beat++) {
      expect(d.pattern[4 * beat]).toBe('D');
      expect(d.pattern[4 * beat + 2]).toBe('D');
      expect(['U', '-']).toContain(d.pattern[4 * beat + 3]);
    }
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('silence -> "D-" per beat, confidence 0, 0 bars (4/4 and 3/4)', () => {
    expect(detectStrumPattern(silence(SR, 10), SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 })).toEqual({
      pattern: 'D-D-D-D-',
      charsPerBeat: 2,
      slotStrength: [0, 0, 0, 0, 0, 0, 0, 0],
      confidence: 0,
      bars: 0,
    });
    expect(detectStrumPattern(silence(SR, 10), SR, { bpm: 120, firstDownbeatSec: 0.5, beatsPerBar: 3 })).toEqual({
      pattern: 'D-D-D-',
      charsPerBeat: 2,
      slotStrength: [0, 0, 0, 0, 0, 0],
      confidence: 0,
      bars: 0,
    });
    // Empty input and a floor below the RMS gate (1e-4) count as silence too.
    expect(detectStrumPattern(new Float32Array(0), SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 }).confidence).toBe(0);
    const faint = detectStrumPattern(whiteNoise(SR, 10, -90), SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expect(faint.pattern).toBe('D-D-D-D-');
    expect(faint.confidence).toBe(0);
  });

  it('audio shorter than one bar -> default pattern, confidence 0, 0 bars', () => {
    const p = synthStrummedProgression(['C'], SR, { bpm: 100, pattern: 'D-DU-UDU' });
    const short = p.signal.subarray(0, Math.round(1.5 * SR));
    const d = detectStrumPattern(short, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expect(d).toMatchObject({ pattern: 'D-D-D-D-', charsPerBeat: 2, confidence: 0, bars: 0 });
  });

  it('firstDownbeatSec places the grid: 1.3 s of lead silence, 2 silent bars in the middle -> pattern kept, silent bars dropped', () => {
    const first = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', leadSec: 1.3, seed: 31, noiseDb: null });
    const second = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', seed: 41, noiseDb: null });
    const barSec = first.barSec;
    const total = 1.3 + 4 * barSec + 2 * barSec + 4 * barSec;
    const sig = mix(
      [
        { signal: first.signal, atSec: 0 },
        { signal: second.signal, atSec: 1.3 + 6 * barSec },
        { signal: whiteNoise(SR, total, -40, 77), atSec: 0 },
      ],
      SR,
      total,
    );
    const d = detectStrumPattern(sig, SR, { bpm: 100, firstDownbeatSec: 1.3, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.charsPerBeat).toBe(2);
    expect(d.bars).toBe(8);
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('a negative firstDownbeatSec (chart starts before the audio) skips the bars before the audio', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 2, seed: 51 });
    // The grid says bar 1 started two bars before sample 0: bars 3.. line up with the audio.
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: -2 * p.barSec, beatsPerBar: 4 });
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.bars).toBe(8);
    expect(d.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('maxSeconds limits the analysed span (bars count only the analysed audio)', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 2, seed: 61 });
    const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4, maxSeconds: 3 * p.barSec });
    expect(d.bars).toBe(3);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
  });

  it('works at 48 kHz too', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], 48000, { bpm: 120, pattern: 'D-DUDUDU', rounds: 2, seed: 71 });
    const d = detectStrumPattern(p.signal, 48000, { bpm: 120, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.pattern, describeDetection(d)).toBe('D-DUDUDU');
    expect(d.confidence, describeDetection(d)).toBeGreaterThanOrEqual(0.8);
  });

  it('confidence is the fraction of bars that agree: 7 bars of D-DU-UDU + 1 bar of D---D--- -> 7/8', () => {
    const a = synthStrummedProgression(['C', 'G', 'Am', 'F', 'C', 'G', 'Am'], SR, { bpm: 100, pattern: 'D-DU-UDU', seed: 81, noiseDb: null });
    const b = synthStrummedProgression(['F'], SR, { bpm: 100, pattern: 'D---D---', seed: 91, noiseDb: null });
    const total = 8 * a.barSec;
    const sig = mix(
      [
        { signal: a.signal, atSec: 0 },
        { signal: b.signal, atSec: 7 * a.barSec },
        { signal: whiteNoise(SR, total, -40, 99), atSec: 0 },
      ],
      SR,
      total,
    );
    const d = detectStrumPattern(sig, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
    expectWellFormed(d, 4);
    expect(d.bars).toBe(8);
    // The majority pattern wins; the half-note bar shares only 2 of 8 slot states with it.
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.confidence, describeDetection(d)).toBeCloseTo(7 / 8, 6);
  });

  it('a sparse pattern stays at eighth resolution (the noise floor of the odd 16th slots is not a subdivision)', () => {
    for (const seed of [21, 33]) {
      const p = synthStrummedProgression(['C', 'Am', 'F', 'G'], SR, { bpm: 100, pattern: 'D---D---', rounds: 2, seed });
      const d = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 });
      expect(d.charsPerBeat, describeDetection(d)).toBe(2);
      expect(d.pattern, describeDetection(d)).toBe('D---D---');
    }
  });

  it('invalid arguments throw', () => {
    const sig = silence(SR, 1);
    expect(() => detectStrumPattern(sig, 0, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4 })).toThrow(RangeError);
    expect(() => detectStrumPattern(sig, SR, { bpm: 0, firstDownbeatSec: 0, beatsPerBar: 4 })).toThrow(RangeError);
    expect(() => detectStrumPattern(sig, SR, { bpm: 1e6, firstDownbeatSec: 0, beatsPerBar: 4 })).toThrow(RangeError);
    expect(() => detectStrumPattern(sig, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 0 })).toThrow(RangeError);
    expect(() => detectStrumPattern(sig, SR, { bpm: 100, firstDownbeatSec: Number.NaN, beatsPerBar: 4 })).toThrow(RangeError);
  });

  it('performance: 3 min at 44.1 kHz in under 1.5 s', () => {
    // 5 bars (12 s) synthesised once and tiled to 180 s: the tile is a whole number of bars.
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F', 'Dm'], SR, { bpm: 100, pattern: 'D-DU-UDU', seed: 101 });
    expect(p.signal.length).toBe(12 * SR);
    const sig = tileSignal(p.signal, 15);
    const t0 = performance.now();
    const d = detectStrumPattern(sig, SR, { bpm: 100, firstDownbeatSec: 0, beatsPerBar: 4, maxSeconds: 180 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(d.bars).toBe(75);
    expect(d.pattern, describeDetection(d)).toBe('D-DU-UDU');
    expect(d.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe('detectStrumPattern with tracked beat times', () => {
  it('follows a tempo ramp when the beat times are given (a constant grid drifts)', () => {
    const beats = rampBeatTimes(92, 108, 0.3, 40);
    const signal = synthClickTrack(beats, SR, 41, { noiseDb: -45, seed: 3 });
    const tracked = detectStrumPattern(signal, SR, { bpm: 100, firstDownbeatSec: beats[0], beatsPerBar: 4, beatTimes: beats });
    expect(tracked.pattern).toBe('D-D-D-D-');
    expect(tracked.charsPerBeat).toBe(2);
    expect(tracked.confidence).toBeGreaterThanOrEqual(0.8);
    expect(tracked.bars).toBeGreaterThanOrEqual(16);
    const constant = detectStrumPattern(signal, SR, { bpm: 100, firstDownbeatSec: beats[0], beatsPerBar: 4 });
    expect(tracked.confidence).toBeGreaterThanOrEqual(constant.confidence);
  });

  it('interpolates sixteenth slots between tracked beats for a strummed pattern', () => {
    const p = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { pattern: 'D-DU-UDU', bpm: 100, rounds: 2, seed: 4 });
    const beatTimes: number[] = [];
    for (let b = 0; b * p.periodSec < p.barTimes[p.barTimes.length - 1] + p.barSec; b++) beatTimes.push(p.barTimes[0] + b * p.periodSec);
    const r = detectStrumPattern(p.signal, SR, { bpm: 100, firstDownbeatSec: p.barTimes[0], beatsPerBar: 4, beatTimes });
    expect(r.pattern).toBe('D-DU-UDU');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
