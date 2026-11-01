import { describe, expect, it } from 'vitest';
import { detectOpenString, detectPitch, detectPitchNear } from '../../src/dsp/tuner';
import { magnitudesAt, synthChord } from '../helpers/synth';

const OPEN = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

describe('detectPitch on a realistic (harmonic-rich) plucked string, not a pure sine', () => {
  it.each(OPEN)('open string MIDI %i settles near the true fundamental once past the pick attack', (midi) => {
    const sampleRate = 44100;
    const fftSize = 8192;
    const signal = synthChord([midi], sampleRate, 2.5, { dbfs: -18 });
    // Sample several windows well after the noisy attack, where the harmonic content is what a
    // sustained real pluck looks like.
    const results: Array<{ tSec: number; reading: ReturnType<typeof detectPitch> }> = [];
    for (const tSec of [0.3, 0.6, 1.0, 1.5]) {
      const endSample = Math.round(tSec * sampleRate);
      const mag = magnitudesAt(signal, endSample, fftSize);
      results.push({ tSec, reading: detectPitch(mag, sampleRate, fftSize) });
    }
    for (const { tSec, reading } of results) {
      expect(reading, `no reading at t=${tSec}s for midi ${midi}`).not.toBeNull();
      if (!reading) continue;
      expect(reading.midi, `t=${tSec}s midi ${midi}: got ${reading.noteName} (${reading.freqHz.toFixed(1)} Hz) instead`).toBe(midi);
      expect(Math.abs(reading.centsOff)).toBeLessThan(15);
    }
  });
});

describe('detectPitchNear: weak fundamental (phone mic rolls off the low end)', () => {
  const sampleRate = 44100;
  const fftSize = 8192;
  /** Harmonics 2-4 strong, fundamental almost absent, detuned by `cents`. */
  function weakFundamental(midi: number, cents: number): Float32Array {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200);
    const n = fftSize * 2;
    const out = new Float32Array(n);
    const amps = [0.04, 1, 0.7, 0.5];
    for (let h = 1; h <= 4; h++) for (let t = 0; t < n; t++) out[t] += amps[h - 1] * Math.sin((2 * Math.PI * f0 * h * t) / sampleRate);
    return out;
  }

  it.each(OPEN)('string MIDI %i: finds the true note and cents even with almost no fundamental', (midi) => {
    for (const cents of [0, 20, -20]) {
      const mag = magnitudesAt(weakFundamental(midi, cents), fftSize * 2, fftSize);
      const targetHz = 440 * Math.pow(2, (midi - 69) / 12);
      const r = detectPitchNear(mag, sampleRate, fftSize, targetHz);
      expect(r, `midi ${midi} ${cents}c`).not.toBeNull();
      const got = 1200 * Math.log2(r!.freqHz / targetHz);
      expect(Math.abs(got - cents)).toBeLessThan(8);
    }
  });

  it('returns null when a different string is played (so the caller can name the heard note)', () => {
    const mag = magnitudesAt(weakFundamental(45, 0), fftSize * 2, fftSize); // A2 played
    expect(detectPitchNear(mag, sampleRate, fftSize, 440 * Math.pow(2, (40 - 69) / 12))).toBeNull(); // target E2
  });
});

describe('detectOpenString: which string was plucked, with no string pre-selected', () => {
  const sampleRate = 44100;
  const fftSize = 8192;
  const targets = OPEN.map((m) => 440 * Math.pow(2, (m - 69) / 12));

  it.each(OPEN.map((m, i) => [m, i]))('realistic pluck of MIDI %i is string index %i, in tune', (midi, index) => {
    const signal = synthChord([midi], sampleRate, 2.5, { dbfs: -18 });
    for (const tSec of [0.3, 0.6, 1.0]) {
      const mag = magnitudesAt(signal, Math.round(tSec * sampleRate), fftSize);
      const r = detectOpenString(mag, sampleRate, fftSize, targets);
      expect(r?.index, `t=${tSec}`).toBe(index);
      expect(Math.abs(r!.reading.centsOff)).toBeLessThan(15);
    }
  });

  it.each(OPEN.map((m, i) => [m, i]))('weak-fundamental pluck of MIDI %i (±30 cents) is string index %i', (midi, index) => {
    for (const cents of [-30, 0, 30]) {
      const f0 = 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200);
      const n = fftSize * 2;
      const sig = new Float32Array(n);
      const amps = [0.05, 1, 0.7, 0.5];
      for (let h = 1; h <= 4; h++) for (let t = 0; t < n; t++) sig[t] += amps[h - 1] * Math.sin((2 * Math.PI * f0 * h * t) / sampleRate);
      const r = detectOpenString(magnitudesAt(sig, n, fftSize), sampleRate, fftSize, targets);
      expect(r?.index, `${cents}c`).toBe(index);
    }
  });
});

describe('detectOpenString: no pluck means no string', () => {
  const sampleRate = 44100;
  const fftSize = 8192;
  const targets = OPEN.map((m) => 440 * Math.pow(2, (m - 69) / 12));
  it('white noise, and noise plus 50/100 Hz mains hum, are not a string', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const n = fftSize * 2;
    for (const hum of [0, 0.05]) {
      const sig = new Float32Array(n);
      for (let t = 0; t < n; t++) sig[t] = 0.02 * rnd() + hum * Math.sin((2 * Math.PI * 50 * t) / sampleRate) + hum * 0.5 * Math.sin((2 * Math.PI * 100 * t) / sampleRate);
      expect(detectOpenString(magnitudesAt(sig, n, fftSize), sampleRate, fftSize, targets), `hum ${hum}`).toBeNull();
    }
  });
});
