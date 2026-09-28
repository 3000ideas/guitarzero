import { describe, expect, it } from 'vitest';
import { detectPitch } from '../../src/dsp/tuner';
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
