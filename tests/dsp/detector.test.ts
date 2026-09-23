import { describe, expect, it } from 'vitest';
import type { DetectorFrame } from '../../src/types';
import { CHORD_LIBRARY, shapeMidiNotes } from '../../src/music/chords';
import { ChordDetector, NOISE_RING_FRAMES, REFINE_BLOCK, SILENCE_DB, refineOnsetSample, rmsDbOf } from '../../src/dsp/detector';
import { mix, runDetector, silence, sine, synthChord, synthStrum, whiteNoise } from '../helpers/synth';

const SR = 48000;
const N = 8192;
const HOP = 0.04;

function notes(name: string): number[] {
  const shape = CHORD_LIBRARY.find((s) => s.name === name);
  if (!shape) throw new Error(`missing library shape ${name}`);
  return shapeMidiNotes(shape);
}

function allZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

function l2(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function topBins(v: Float32Array, n: number): number[] {
  return Array.from(v)
    .map((value, pc) => ({ value, pc }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((x) => x.pc)
    .sort((a, b) => a - b);
}

function expectGated(f: DetectorFrame): void {
  expect(f.onset).toBe(false);
  expect(f.onsetTimeSec).toBeUndefined();
  expect(f.bestChord).toBeNull();
  expect(allZero(f.chroma)).toBe(true);
  expect(allZero(f.energyChroma)).toBe(true);
}

describe('ChordDetector: gate and noise floor', () => {
  it('is gated in silence: zero chroma, no chord, no onset, rmsDb = -100', () => {
    const det = new ChordDetector(SR);
    const frames = runDetector(silence(SR, 1.5), SR, {}, det);
    expect(frames.length).toBeGreaterThan(20);
    for (const f of frames) {
      expect(f.rmsDb).toBe(SILENCE_DB);
      expectGated(f);
    }
    expect(det.getGateDb()).toBe(-50);
    expect(det.getNoiseFloorDb()).toBe(SILENCE_DB);
  });

  it('is gated by a quiet noise floor below gateDb', () => {
    const frames = runDetector(whiteNoise(SR, 1.5, -60), SR);
    for (const f of frames) {
      expect(f.rmsDb).toBeLessThan(-50);
      expect(f.rmsDb).toBeCloseTo(-60, 0);
      expectGated(f);
    }
  });

  it('noise floor: -100 before 0.5 s, then the 10th percentile of the last 75 rmsDb', () => {
    const det = new ChordDetector(SR);
    const sig = whiteNoise(SR, 4.0, -60);
    const hop = Math.round(HOP * SR);
    let end = N;
    for (; end / SR < 0.5 + N / SR - 1e-9; end += hop) {
      det.process(sig.subarray(end - N, end), end / SR);
      expect(det.getNoiseFloorDb()).toBe(SILENCE_DB);
    }
    for (; end <= sig.length; end += hop) {
      det.process(sig.subarray(end - N, end), end / SR);
      expect(det.getNoiseFloorDb()).toBeCloseTo(-60, 0);
    }
    expect(det.getGateDb()).toBeCloseTo(-50, 0);
    expect(NOISE_RING_FRAMES).toBe(75);
  });

  it('gate = max(gateDb, noiseFloor + 10): a -45 dBFS floor gates frames above gateDb', () => {
    const det = new ChordDetector(SR); // gateDb -50
    const frames = runDetector(whiteNoise(SR, 3.0, -45), SR, {}, det);
    expect(det.getNoiseFloorDb()).toBeCloseTo(-45, 0);
    expect(det.getGateDb()).toBeCloseTo(-35, 0);
    for (const f of frames.slice(15)) {
      expect(f.rmsDb).toBeGreaterThan(-50);
      expectGated(f);
    }
    // A chord well above the floor opens the gate.
    const det2 = new ChordDetector(SR);
    const sig = mix(
      [
        { signal: whiteNoise(SR, 3.0, -45), atSec: 0 },
        { signal: synthChord(notes('E'), SR, 2.0, { dbfs: -15 }), atSec: 1.0 },
      ],
      SR,
      3.0,
    );
    const frames2 = runDetector(sig, SR, {}, det2);
    const open = frames2.filter((f) => f.timeSec > 1.25 && f.timeSec < 1.8);
    expect(open.length).toBeGreaterThan(5);
    for (const f of open) {
      expect(f.rmsDb).toBeGreaterThanOrEqual(det2.getGateDb());
      expect(f.bestChord?.name).toBe('E');
    }
  });

  it('the floor is not updated within 1 s of an accepted onset (continuous strumming keeps it)', () => {
    const det = new ChordDetector(SR, { gateDb: -70 });
    const total = 9;
    const parts = [{ signal: whiteNoise(SR, total, -60), atSec: 0 }];
    for (let t = 1.0; t < 5.0; t += 0.5) parts.push({ signal: synthStrum(notes('G'), SR, total - t, { dbfs: -20 }), atSec: t });
    const sig = mix(parts, SR, total);
    const hop = Math.round(HOP * SR);
    let onsets = 0;
    for (let end = N; end <= sig.length; end += hop) {
      const f = det.process(sig.subarray(end - N, end), end / SR);
      if (f.onset) onsets++;
      const t = end / SR;
      if (t > 0.8 && t < 5.5) {
        // Loud frames dominate the ring, but the floor holds.
        expect(det.getNoiseFloorDb()).toBeCloseTo(-60, 0);
        expect(det.getGateDb()).toBeCloseTo(-50, 0);
      }
      if (t > 1.2 && t < 5.4) expect(f.rmsDb).toBeGreaterThan(-45);
    }
    expect(onsets).toBe(8);
    // One second after the last onset the estimate follows the ring again (the chords keep
    // ringing until the end, so the 10th percentile of the last 3 s is now above -60).
    expect(det.getNoiseFloorDb()).toBeGreaterThan(-55);
  });

  it('setOptions updates gateDb, a4 and onsetThreshold live', () => {
    const det = new ChordDetector(SR);
    det.setOptions({ gateDb: -30 });
    expect(det.getGateDb()).toBe(-30);
    det.setOptions({ gateDb: -50 });
    expect(det.getGateDb()).toBe(-50);
    // a4: an 82.41 Hz sine reads as E with 440, as F with 415.3.
    const sig = sine(82.41, SR, 0.6, 0.3);
    const e = runDetector(sig, SR, {}, det);
    expect(topBins(e[e.length - 1].chroma, 1)).toEqual([4]);
    det.setOptions({ a4: 415.3 });
    const f = runDetector(sig, SR, {}, det);
    expect(topBins(f[f.length - 1].chroma, 1)).toEqual([5]);
    // onsetThreshold: a huge multiplier over a noise floor swallows the strums.
    const noisy = mix(
      [
        { signal: whiteNoise(SR, 3.0, -50), atSec: 0 },
        ...[0.5, 1.0, 1.5, 2.0].map((atSec) => ({ signal: synthStrum(notes('G'), SR, 3.0 - atSec, { dbfs: -30 }), atSec })),
      ],
      SR,
      3.0,
    );
    const d1 = new ChordDetector(SR, { gateDb: -70 });
    expect(runDetector(noisy, SR, {}, d1).filter((x) => x.onset)).toHaveLength(4);
    const d2 = new ChordDetector(SR, { gateDb: -70 });
    d2.setOptions({ onsetThreshold: 10 });
    expect(runDetector(noisy, SR, {}, d2).filter((x) => x.onset)).toHaveLength(0);
    // Invalid patches are ignored.
    det.setOptions({ gateDb: Number.NaN, a4: -1, onsetThreshold: 0 });
    expect(det.getGateDb()).toBe(-50);
  });
});

describe('ChordDetector: chroma and chord', () => {
  it('reports the chord of a ringing library voicing with a unit-norm chroma and fresh arrays', () => {
    for (const [name, sr] of [
      ['E', 48000],
      ['Am', 44100],
      ['D', 48000],
    ] as Array<[string, number]>) {
      // Quiet lead-in (like the count-in) so the noise floor is initialised from silence.
      const sig = mix([{ signal: synthStrum(notes(name), sr, 1.2, { dbfs: -20 }), atSec: 0.6 }], sr, 1.8);
      const frames = runDetector(sig, sr);
      const steady = frames.filter((f) => f.timeSec > 0.9 && f.timeSec < 1.4);
      expect(steady.length).toBeGreaterThan(10);
      for (const f of steady) {
        expect(f.bestChord?.name).toBe(name);
        expect(f.bestChord!.score).toBeGreaterThan(0.85);
        expect(l2(f.chroma)).toBeCloseTo(1, 4);
        expect(allZero(f.energyChroma)).toBe(false);
        expect(f.rmsDb).toBeGreaterThan(-50);
      }
      for (let i = 1; i < steady.length; i++) {
        expect(steady[i].chroma).not.toBe(steady[i - 1].chroma);
        expect(steady[i].energyChroma).not.toBe(steady[i - 1].energyChroma);
        expect(steady[i]).not.toBe(steady[i - 1]);
      }
    }
  });

  it('setTranspose rolls chroma and bestChord into written space (capo 2: sounding A -> written G)', () => {
    const sig = mix([{ signal: synthStrum(notes('A'), SR, 1.2, { dbfs: -20 }), atSec: 0.6 }], SR, 1.8);
    const steady = (frames: DetectorFrame[]) => frames.filter((f) => f.timeSec > 0.9 && f.timeSec < 1.4);
    const det = new ChordDetector(SR);
    expect(det.getTranspose()).toBe(0);
    det.setTranspose(2);
    expect(det.getTranspose()).toBe(2);
    const frames = steady(runDetector(sig, SR, {}, det));
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) {
      expect(f.bestChord?.name).toBe('G');
      expect(topBins(f.energyChroma, 3)).toEqual([2, 7, 11]); // D G B
      expect(topBins(f.chroma, 3)).toEqual([2, 7, 11]);
    }
    const plainDet = new ChordDetector(SR);
    for (const f of steady(runDetector(sig, SR, {}, plainDet))) expect(f.bestChord?.name).toBe('A');
    det.setTranspose(-10);
    expect(det.getTranspose()).toBe(2);
    det.setTranspose(14);
    expect(det.getTranspose()).toBe(2);
    det.setTranspose(12);
    expect(det.getTranspose()).toBe(0);
  });

  it('accepts frames shorter or longer than fftSize', () => {
    const det = new ChordDetector(SR);
    const sig = synthChord(notes('C'), SR, 0.5, { dbfs: -20 });
    const short = det.process(sig.subarray(0, 4096), 0.1);
    expect(short.rmsDb).toBeLessThan(rmsDbOf(sig.subarray(0, 4096)));
    expect(short.chroma.length).toBe(12);
    const long = det.process(sig, 0.5);
    const exact = det.process(sig.subarray(sig.length - N), 0.5);
    for (let i = 0; i < 12; i++) expect(long.chroma[i]).toBeCloseTo(exact.chroma[i], 5);
    expect(long.rmsDb).toBeCloseTo(exact.rmsDb, 5);
  });

  it('exposes the vocabulary built once in the constructor', () => {
    const det = new ChordDetector(SR);
    expect(det.getTemplates()).toHaveLength(84);
    expect(det.getTemplates()).toBe(det.getTemplates());
    expect(det.fftSize).toBe(N);
    expect(new ChordDetector(SR, { fftSize: 4096 }).fftSize).toBe(4096);
    expect(() => new ChordDetector(0)).toThrow();
  });
});

describe('ChordDetector: onsets', () => {
  for (const sr of [44100, 48000]) {
    it(`refines the onset time of a strum to within +-5 ms at ${sr} Hz (silence background)`, () => {
      const at = 0.5;
      const sig = mix([{ signal: synthStrum(notes('G'), sr, 1.3, { dbfs: -20 }), atSec: at }], sr, 1.8);
      const frames = runDetector(sig, sr);
      const onsets = frames.filter((f) => f.onset);
      expect(onsets).toHaveLength(1);
      const o = onsets[0];
      expect(o.onsetTimeSec).toBeDefined();
      expect(Math.abs(o.onsetTimeSec! - at)).toBeLessThanOrEqual(0.005);
      expect(o.onsetTimeSec!).toBeLessThanOrEqual(o.timeSec);
      expect(o.timeSec).toBeGreaterThanOrEqual(at);
      expect(o.timeSec - at).toBeLessThanOrEqual(2 * HOP + 1e-6);
      expect(o.rmsDb).toBeGreaterThanOrEqual(-50);
      for (const f of frames) if (!f.onset) expect(f.onsetTimeSec).toBeUndefined();
    });
  }

  it('refines to within +-5 ms over a -60 dBFS noise floor and for a quiet (-35 dBFS) strum', () => {
    for (const [sr, dbfs] of [
      [48000, -20],
      [44100, -20],
      [48000, -35],
      [44100, -35],
    ] as Array<[number, number]>) {
      const at = 0.5;
      const sig = mix(
        [
          { signal: whiteNoise(sr, 1.8, -60), atSec: 0 },
          { signal: synthStrum(notes('G'), sr, 1.3, { dbfs }), atSec: at },
        ],
        sr,
        1.8,
      );
      const det = new ChordDetector(sr, { gateDb: -70 });
      const onsets = runDetector(sig, sr, {}, det).filter((f) => f.onset);
      expect(onsets, `sr ${sr} dbfs ${dbfs}`).toHaveLength(1);
      expect(Math.abs(onsets[0].onsetTimeSec! - at), `sr ${sr} dbfs ${dbfs}`).toBeLessThanOrEqual(0.005);
    }
  });

  it('every strum of a re-struck sequence is an onset with a refined time within +-8 ms', () => {
    // Re-striking a string stops its old vibration: model each strum as the previous one damped
    // over the 15 ms before the new attack (a purely additive mix would pile up 5 ringing
    // copies of the same chord, which no guitar does). The damping ramp sits inside the ~10 ms
    // reference window of the refinement, so the first single string can be up to two 2.7 ms
    // blocks late: 8 ms here versus +-5 ms for an isolated strum.
    const times = [0.5, 1.0, 1.5, 2.0, 2.5];
    const damp = Math.round(0.015 * SR);
    const parts = times.map((atSec, i) => {
      const len = i + 1 < times.length ? times[i + 1] - atSec : 3.2 - atSec;
      const s = synthStrum(notes(i % 2 ? 'G' : 'C'), SR, len, { dbfs: -20, seed: i + 1 });
      for (let k = 0; k < damp; k++) s[s.length - 1 - k] *= k / damp;
      return { signal: s, atSec };
    });
    const onsets = runDetector(mix(parts, SR, 3.2), SR).filter((f) => f.onset);
    expect(onsets.map((f) => f.timeSec)).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(Math.abs(onsets[i].onsetTimeSec! - times[i]), `strum ${i}`).toBeLessThanOrEqual(0.008);
  });

  it('refineOnsetSample: no rise -> -1, a step -> its first block, ringing bass does not fake a rise', () => {
    const steady = sine(98, SR, N / SR, 0.3);
    expect(refineOnsetSample(steady, SR)).toBe(-1);
    expect(refineOnsetSample(new Float32Array(N), SR)).toBe(-1);
    const stepAt = N - Math.round(0.07 * SR);
    const frame = new Float32Array(N);
    for (let i = stepAt; i < N; i++) frame[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (i - stepAt)) / SR);
    const s = refineOnsetSample(frame, SR);
    expect(s).toBeGreaterThanOrEqual(stepAt - REFINE_BLOCK);
    expect(s).toBeLessThanOrEqual(stepAt);
    // A quiet ringing background before the step.
    for (let i = 0; i < stepAt; i++) frame[i] = 0.02 * Math.sin((2 * Math.PI * 82.41 * i) / SR);
    const s2 = refineOnsetSample(frame, SR);
    expect(s2).toBeGreaterThanOrEqual(stepAt - REFINE_BLOCK);
    expect(s2).toBeLessThanOrEqual(stepAt + REFINE_BLOCK);
  });

  it('falls back to timeSec - hop when the frame has no clear rise but the flux fires', () => {
    // Two identical frames, then a frame with the chord already fully present in every block
    // (no rise inside the frame): the onset detector fires on the spectral change, the refinement
    // finds no attack and the fallback is used.
    const det = new ChordDetector(SR);
    const quiet = silence(SR, N / SR);
    const chord = synthChord(notes('E'), SR, 2.0, { dbfs: -20 }).subarray(SR, SR + N); // 1 s in, steady ringing
    det.process(quiet, 0.17);
    det.process(quiet, 0.21);
    det.process(quiet, 0.25);
    const f = det.process(chord, 0.29);
    expect(f.onset).toBe(true);
    expect(f.onsetTimeSec).toBeCloseTo(0.29 - HOP, 6);
  });

  it('rmsDbOf floors at -100 dBFS', () => {
    expect(rmsDbOf(new Float32Array(100))).toBe(SILENCE_DB);
    expect(rmsDbOf(new Float32Array(100).fill(0.1))).toBeCloseTo(-20, 6);
    expect(rmsDbOf(new Float32Array(0))).toBe(SILENCE_DB);
  });
});

describe('ChordDetector: performance', () => {
  it('process(8192) averages well under 10 ms over 200 frames', () => {
    const det = new ChordDetector(SR);
    const sig = synthChord(notes('C'), SR, 1.0, { dbfs: -20 });
    const frame = sig.subarray(0, N);
    for (let i = 0; i < 20; i++) det.process(frame, i * HOP);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) det.process(frame, 1 + i * HOP);
    const avgMs = (performance.now() - t0) / 200;
    expect(avgMs).toBeLessThan(10);
  });
});
