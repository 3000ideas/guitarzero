import { describe, expect, it } from 'vitest';
import { estimateTempo, onsetEnvelope, decimateForTempo, TEMPO_HOP } from '../../src/dsp/tempoEstimate';
import { dbToLin, makeRng, mix, silence, whiteNoise } from '../helpers/synth';

/**
 * Percussive click: a short burst of white noise with a 1 ms linear attack and an exponential
 * decay (tau), peak at `dbfs`. Different from synthClick (a sine), which is what a metronome
 * sounds like; a drum hit is broadband.
 */
function noiseBurst(sampleRate: number, rng: () => number, opts: { durSec?: number; tau?: number; dbfs?: number } = {}): Float32Array {
  const durSec = opts.durSec ?? 0.04;
  const tau = opts.tau ?? 0.008;
  const amp = dbToLin(opts.dbfs ?? -12);
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const s = t / sampleRate;
    const env = Math.min(1, s / 0.001) * Math.exp(-s / tau);
    out[t] = amp * env * (2 * rng() - 1);
  }
  return out;
}

interface ClickTrackOpts {
  /** Level of the clicks in dBFS (default -12), each varied by +-3 dB. */
  dbfs?: number;
  /** RMS of the noise floor in dBFS (default -40). */
  noiseDb?: number;
  seed?: number;
}

/** Clicks every 60/bpm s from `fromSec` until `seconds`, over a white-noise floor. */
function clickTrack(bpm: number, fromSec: number, seconds: number, sampleRate: number, opts: ClickTrackOpts = {}): Float32Array {
  const rng = makeRng(opts.seed ?? 11);
  const period = 60 / bpm;
  const parts = [{ signal: whiteNoise(sampleRate, seconds, opts.noiseDb ?? -40, (opts.seed ?? 11) + 100), atSec: 0 }];
  for (let t = fromSec; t < seconds; t += period) {
    const dbfs = (opts.dbfs ?? -12) + 3 * (2 * rng() - 1);
    parts.push({ signal: noiseBurst(sampleRate, rng, { dbfs }), atSec: t });
  }
  return mix(parts, sampleRate, seconds);
}

/** Signed distance from x to the nearest point of the grid a + k * period. */
function gridError(x: number, a: number, period: number): number {
  const d = (x - a) / period;
  return (d - Math.round(d)) * period;
}

describe('estimateTempo', () => {
  it('100 BPM clicks from 0.37 s over a -40 dBFS floor -> 100 +-1 BPM, first beat on the grid, confidence >= 0.5', () => {
    const sig = clickTrack(100, 0.37, 30, 44100);
    const est = estimateTempo(sig, 44100);
    expect(Math.abs(est.bpm - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(gridError(est.firstBeatSec, 0.37, 0.6))).toBeLessThanOrEqual(0.03);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
    expect(est.beatPeriodSec).toBeCloseTo(60 / est.bpm, 2);
  });

  it('140 BPM -> 140 +-1.5 BPM (its half, 70 BPM, is in range but the 120 BPM preference wins)', () => {
    const sig = clickTrack(140, 0.37, 30, 44100, { seed: 5 });
    const est = estimateTempo(sig, 44100);
    expect(Math.abs(est.bpm - 140)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(gridError(est.firstBeatSec, 0.37, 60 / 140))).toBeLessThanOrEqual(0.03);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('works at 48 kHz too (decimated to 12 kHz): 100 BPM +-1', () => {
    const sig = clickTrack(100, 0.37, 30, 48000, { seed: 9 });
    const est = estimateTempo(sig, 48000);
    expect(Math.abs(est.bpm - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(gridError(est.firstBeatSec, 0.37, 0.6))).toBeLessThanOrEqual(0.03);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('silence -> confidence 0 and the 120 BPM fallback', () => {
    expect(estimateTempo(silence(44100, 5), 44100)).toEqual({ bpm: 120, beatPeriodSec: 0.5, firstBeatSec: 0, confidence: 0 });
    expect(estimateTempo(new Float32Array(0), 44100).confidence).toBe(0);
    // Below the RMS gate (1e-4) also counts as silence.
    expect(estimateTempo(whiteNoise(44100, 5, -90), 44100).confidence).toBe(0);
  });

  it('stationary noise (no onsets) -> low confidence', () => {
    const est = estimateTempo(whiteNoise(44100, 20, -20), 44100);
    expect(est.confidence).toBeLessThan(0.3);
  });

  it('firstBeatSec skips leading silence: clicks starting at 2.37 s -> first beat near 2.37 s, not earlier', () => {
    const sig = clickTrack(100, 2.37, 30, 44100, { seed: 3 });
    const est = estimateTempo(sig, 44100);
    expect(Math.abs(est.bpm - 100)).toBeLessThanOrEqual(1);
    expect(est.firstBeatSec).toBeGreaterThanOrEqual(2.37 - 0.03);
    expect(est.firstBeatSec).toBeLessThanOrEqual(2.37 + 0.6 + 0.03);
    expect(Math.abs(gridError(est.firstBeatSec, 2.37, 0.6))).toBeLessThanOrEqual(0.03);
  });

  it('minBpm / maxBpm restrict the search range', () => {
    const sig = clickTrack(100, 0.37, 30, 44100);
    // 100 BPM excluded from above: the octave below (50) is the only periodicity left.
    const slow = estimateTempo(sig, 44100, { minBpm: 40, maxBpm: 90 });
    expect(Math.abs(slow.bpm - 50)).toBeLessThanOrEqual(1);
    // Silly ranges fall back to the defaults.
    const est = estimateTempo(sig, 44100, { minBpm: 200, maxBpm: 60 });
    expect(Math.abs(est.bpm - 100)).toBeLessThanOrEqual(1);
  });

  it('maxSeconds limits the analysed span', () => {
    // Noise only during the first 5 s, clicks afterwards: with maxSeconds 5 there is no beat.
    const sig = mix(
      [
        { signal: whiteNoise(44100, 5, -40), atSec: 0 },
        { signal: clickTrack(100, 0.37, 20, 44100), atSec: 5 },
      ],
      44100,
      25,
    );
    const short = estimateTempo(sig, 44100, { maxSeconds: 5 });
    const full = estimateTempo(sig, 44100);
    expect(short.confidence).toBeLessThan(0.3);
    expect(Math.abs(full.bpm - 100)).toBeLessThanOrEqual(1);
    expect(full.firstBeatSec).toBeGreaterThanOrEqual(5.37 - 0.03);
  });

  it('invalid sampleRate throws', () => {
    expect(() => estimateTempo(silence(44100, 1), 0)).toThrow(RangeError);
    expect(() => estimateTempo(silence(44100, 1), Number.NaN)).toThrow(RangeError);
  });

  it('onsetEnvelope peaks at the clicks (time stamps within +-1 hop)', () => {
    const sig = clickTrack(100, 0.37, 6, 44100);
    const { data, rate } = decimateForTempo(sig, 44100, 90);
    expect(rate).toBe(11025);
    const { env, frameRate, frameOffsetSec } = onsetEnvelope(data, rate);
    expect(frameRate).toBeCloseTo(11025 / TEMPO_HOP, 9);
    let max = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
    // Every click has a strong frame within +-1 hop of its time.
    for (let t = 0.37; t < 6; t += 0.6) {
      const c = Math.round((t - frameOffsetSec) * frameRate);
      let local = 0;
      for (let i = Math.max(0, c - 1); i <= Math.min(env.length - 1, c + 1); i++) if (env[i] > local) local = env[i];
      expect(local).toBeGreaterThan(0.3 * max);
    }
    // Between clicks (a quarter period away) the envelope is small.
    for (let t = 0.37 + 0.15; t < 6; t += 0.6) {
      const c = Math.round((t - frameOffsetSec) * frameRate);
      expect(env[c]).toBeLessThan(0.3 * max);
    }
  });

  it('performance: 60 s at 44.1 kHz in under 1.5 s', () => {
    const sig = clickTrack(120, 0.5, 60, 44100, { seed: 21 });
    const t0 = performance.now();
    const est = estimateTempo(sig, 44100);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(Math.abs(est.bpm - 120)).toBeLessThanOrEqual(1);
  });
});
