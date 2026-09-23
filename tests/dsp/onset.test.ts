import { describe, expect, it } from 'vitest';
import { CHORD_LIBRARY, shapeMidiNotes } from '../../src/music/chords';
import { ONSET_EPS_PER_BIN, OnsetDetector } from '../../src/dsp/onset';
import { magnitudesAt, mix, runOnsets, silence, synthClick, synthStrum, whiteNoise } from '../helpers/synth';

const SR = 48000;
const HOP = 0.04;
const N = 8192;

function gNotes(): number[] {
  return shapeMidiNotes(CHORD_LIBRARY.find((s) => s.name === 'G')!);
}

/** Four strums (each ringing until the end of the signal) at the given times. */
function fourStrums(times: number[], sampleRate: number, dbfs: number, total = 3.0): Float32Array {
  return mix(
    times.map((atSec) => ({ signal: synthStrum(gNotes(), sampleRate, total - atSec, { dbfs }), atSec })),
    sampleRate,
    total,
  );
}

describe('OnsetDetector', () => {
  it('exposes the analysed band (70..3500 Hz) and an eps proportional to the bins', () => {
    const det = new OnsetDetector(SR, N);
    const df = SR / N;
    expect(det.kLo).toBe(Math.round(70 / df));
    expect(det.kHi).toBe(Math.round(3500 / df));
    expect(det.eps).toBeCloseTo(ONSET_EPS_PER_BIN * (det.kHi - det.kLo + 1), 9);
    expect(det.getThreshold()).toBe(1.5);
    expect(det.minIntervalSec).toBe(0.1);
    expect(det.hopSeconds).toBe(HOP);
  });

  for (const sr of [44100, 48000]) {
    it(`4 synthetic strums -> 4 onsets within +-1 hop of the expected detection at ${sr} Hz`, () => {
      const times = [0.5, 1.0, 1.5, 2.0];
      const onsets = runOnsets(fourStrums(times, sr, -20), sr);
      expect(onsets).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        // The attack is detected on the first hop where it carries weight: t + 1 hop, +-1 hop.
        expect(Math.abs(onsets[i] - (times[i] + HOP))).toBeLessThanOrEqual(HOP + 1e-6);
      }
    });
  }

  it('4 quiet strums (-40 dBFS) -> 4 onsets, each within 3 hops after the attack', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const onsets = runOnsets(fourStrums(times, SR, -40), SR);
    expect(onsets).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(onsets[i]).toBeGreaterThanOrEqual(times[i]);
      expect(onsets[i] - times[i]).toBeLessThanOrEqual(3 * HOP + 1e-6);
    }
  });

  it('4 strums over a -50 dBFS noise floor -> 4 onsets (adaptive threshold)', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const sig = mix([{ signal: whiteNoise(SR, 3.0, -50), atSec: 0 }, { signal: fourStrums(times, SR, -30), atSec: 0 }], SR, 3.0);
    const onsets = runOnsets(sig, SR);
    expect(onsets).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      // Over noise the threshold is higher, so the crossing may need one more hop of the attack.
      expect(onsets[i]).toBeGreaterThanOrEqual(times[i]);
      expect(onsets[i] - times[i]).toBeLessThanOrEqual(3 * HOP + 1e-6);
    }
  });

  it('stationary white noise -> 0 onsets (-30 and -50 dBFS)', () => {
    expect(runOnsets(whiteNoise(SR, 3.0, -30), SR)).toEqual([]);
    expect(runOnsets(whiteNoise(SR, 3.0, -50, 3), SR)).toEqual([]);
  });

  it('silence and a faint noise floor -> 0 onsets', () => {
    expect(runOnsets(silence(SR, 2.0), SR)).toEqual([]);
    expect(runOnsets(whiteNoise(SR, 2.0, -80), SR)).toEqual([]);
    expect(runOnsets(whiteNoise(SR, 2.0, -70, 5), SR)).toEqual([]);
  });

  it('metronome clicks at 4500 / 5500 Hz (25 ms, 3 ms attack, tau 8 ms, -20 dBFS) over silence -> 0 onsets', () => {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push({ signal: synthClick(i % 2 ? 5500 : 4500, SR, { dbfs: -20 }), atSec: 0.3 + 0.25 * i });
    const sig = mix(parts, SR, 2.6);
    expect(runOnsets(sig, SR)).toEqual([]);
    // Same at 44.1 kHz.
    const parts44 = parts.map((p, i) => ({ signal: synthClick(i % 2 ? 5500 : 4500, 44100, { dbfs: -20 }), atSec: p.atSec }));
    expect(runOnsets(mix(parts44, 44100, 2.6), 44100)).toEqual([]);
  });

  it('click + strum 60 ms later -> exactly 1 onset, after the strum', () => {
    const sig = mix(
      [
        { signal: synthClick(4500, SR, { dbfs: -20 }), atSec: 0.5 },
        { signal: synthStrum(gNotes(), SR, 1.5, { dbfs: -20 }), atSec: 0.56 },
      ],
      SR,
      2.0,
    );
    const onsets = runOnsets(sig, SR);
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toBeGreaterThanOrEqual(0.56);
    expect(onsets[0]).toBeLessThanOrEqual(0.56 + 2 * HOP + 1e-6);
  });

  it('only the band 70..3500 Hz is analysed: a 5 kHz decaying tone is ignored, a 1 kHz one is an onset', () => {
    const tone = (freq: number) => synthClick(freq, SR, { attackSec: 0.003, tau: 0.05, durSec: 0.4, dbfs: -20 });
    expect(runOnsets(mix([{ signal: tone(5000), atSec: 0.5 }], SR, 1.5), SR)).toEqual([]);
    const onsets = runOnsets(mix([{ signal: tone(1000), atSec: 0.5 }], SR, 1.5), SR);
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toBeGreaterThanOrEqual(0.5);
    expect(onsets[0]).toBeLessThanOrEqual(0.5 + 2 * HOP + 1e-6);
  });

  it('two attacks closer than minIntervalSec count once (refractory on real timeSec deltas)', () => {
    const sig = mix(
      [
        { signal: synthStrum(gNotes(), SR, 1.5, { dbfs: -20 }), atSec: 0.5 },
        { signal: synthStrum(gNotes(), SR, 1.44, { dbfs: -20, seed: 3 }), atSec: 0.56 },
      ],
      SR,
      2.0,
    );
    expect(runOnsets(sig, SR)).toHaveLength(1);
    // With a long refractory the second strum at +0.5 s is swallowed too.
    const two = mix(
      [
        { signal: synthStrum(gNotes(), SR, 1.5, { dbfs: -20 }), atSec: 0.5 },
        { signal: synthStrum(gNotes(), SR, 1.0, { dbfs: -20 }), atSec: 1.0 },
      ],
      SR,
      2.0,
    );
    expect(runOnsets(two, SR)).toHaveLength(2);
    expect(runOnsets(two, SR, { minIntervalSec: 0.8 })).toHaveLength(1);
  });

  it('the first frame is never an onset, and a loud second frame needs history too', () => {
    const det = new OnsetDetector(SR, N);
    const chord = synthStrum(gNotes(), SR, 0.5, { dbfs: -20 });
    const loud = magnitudesAt(chord, N);
    const quiet = magnitudesAt(silence(SR, 0.5), N);
    expect(det.process(loud, 0.17)).toBe(false);
    const det2 = new OnsetDetector(SR, N);
    expect(det2.process(quiet, 0.17)).toBe(false);
    expect(det2.process(loud, 0.21)).toBe(false);
    const det3 = new OnsetDetector(SR, N);
    expect(det3.process(quiet, 0.17)).toBe(false);
    expect(det3.process(quiet, 0.21)).toBe(false);
    expect(det3.process(loud, 0.25)).toBe(true);
    expect(det3.lastFlux).toBeGreaterThan(det3.lastThreshold);
  });

  it('setThreshold changes the sensitivity (strums over noise); invalid values are ignored', () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const sig = mix([{ signal: whiteNoise(SR, 3.0, -50), atSec: 0 }, { signal: fourStrums(times, SR, -30), atSec: 0 }], SR, 3.0);
    expect(runOnsets(sig, SR, { threshold: 1.5 })).toHaveLength(4);
    expect(runOnsets(sig, SR, { threshold: 10 })).toHaveLength(0);
    const det = new OnsetDetector(SR, N, { threshold: 2 });
    expect(det.getThreshold()).toBe(2);
    det.setThreshold(3);
    expect(det.getThreshold()).toBe(3);
    det.setThreshold(0);
    det.setThreshold(Number.NaN);
    expect(det.getThreshold()).toBe(3);
  });

  it('disarmed frames update the state but never fire; the next armed crossing does', () => {
    const times = [0.5];
    const sig = fourStrums(times, SR, -20, 1.5);
    const det = new OnsetDetector(SR, N);
    const hop = Math.round(HOP * SR);
    const fired: number[] = [];
    for (let end = N; end <= sig.length; end += hop) {
      const t = end / SR;
      const armed = t > 0.55; // gate "closed" for the first hop that contains the attack
      if (det.process(magnitudesAt(sig, end), t, armed)) fired.push(t);
    }
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeGreaterThan(0.55);
    expect(fired[0]).toBeLessThanOrEqual(0.5 + 3 * HOP + 1e-6);
  });
});
