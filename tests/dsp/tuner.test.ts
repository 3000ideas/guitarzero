import { describe, expect, it } from 'vitest';
import { RealFFT } from '../../src/dsp/fft';
import { detectPitch, TUNER_DEFAULT_MAX_HZ, TUNER_DEFAULT_MIN_HZ } from '../../src/dsp/tuner';
import { midiToFreq } from '../../src/music/notes';

const SR = 44100;
const FFT_SIZE = 8192;

/** A pure sine at `freqHz`, `seconds` long, peak amplitude `amp`. */
function sine(freqHz: number, sampleRate: number, seconds: number, amp = 0.4): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function magnitudesOf(signal: Float32Array): Float32Array {
  const fft = new RealFFT(FFT_SIZE);
  const mag = new Float32Array((FFT_SIZE >> 1) + 1);
  fft.magnitudes(signal.subarray(signal.length - FFT_SIZE), mag);
  return mag;
}

/** The six open strings of a standard-tuned guitar (MIDI E2 A2 D3 G3 B3 E4). */
const OPEN_STRINGS: ReadonlyArray<{ midi: number; name: string }> = [
  { midi: 40, name: 'E2' },
  { midi: 45, name: 'A2' },
  { midi: 50, name: 'D3' },
  { midi: 55, name: 'G3' },
  { midi: 59, name: 'B3' },
  { midi: 64, name: 'E4' },
];

describe('detectPitch', () => {
  it('reads each open string of a standard-tuned guitar within a few cents', () => {
    for (const { midi, name } of OPEN_STRINGS) {
      const freq = midiToFreq(midi);
      const mag = magnitudesOf(sine(freq, SR, 1.0));
      const r = detectPitch(mag, SR, FFT_SIZE);
      expect(r, name).not.toBeNull();
      expect(r!.midi, name).toBe(midi);
      expect(r!.noteName, name).toBe(name);
      expect(Math.abs(r!.centsOff), name).toBeLessThan(5);
      expect(r!.freqHz, name).toBeCloseTo(freq, 0);
    }
  });

  it('reports a sharp note as a positive cents deviation and a flat note as negative', () => {
    const a2 = midiToFreq(45); // 110 Hz
    const sharp = detectPitch(magnitudesOf(sine(a2 * Math.pow(2, 20 / 1200), SR, 1.0)), SR, FFT_SIZE);
    expect(sharp).not.toBeNull();
    expect(sharp!.midi).toBe(45);
    expect(sharp!.centsOff).toBeGreaterThan(10);
    expect(sharp!.centsOff).toBeLessThan(30);

    const flat = detectPitch(magnitudesOf(sine(a2 * Math.pow(2, -20 / 1200), SR, 1.0)), SR, FFT_SIZE);
    expect(flat).not.toBeNull();
    expect(flat!.midi).toBe(45);
    expect(flat!.centsOff).toBeLessThan(-10);
    expect(flat!.centsOff).toBeGreaterThan(-30);
  });

  it('a note flat enough rounds to the note below, still with a small cents error', () => {
    // A2 (110 Hz) bent down 45 cents is much closer to A2 than to Ab2, but past the midpoint
    // would round to Ab2; 45 cents stays on A2's side (midpoint is 50).
    const bentDown = midiToFreq(45) * Math.pow(2, -45 / 1200);
    const r = detectPitch(magnitudesOf(sine(bentDown, SR, 1.0)), SR, FFT_SIZE);
    expect(r).not.toBeNull();
    expect(r!.midi).toBe(45);
    expect(Math.abs(r!.centsOff - -45)).toBeLessThan(1);
  });

  it('follows a chromatic scan across the guitar range and never returns a wildly wrong octave', () => {
    for (let midi = 40; midi <= 64; midi++) {
      const r = detectPitch(magnitudesOf(sine(midiToFreq(midi), SR, 1.0)), SR, FFT_SIZE);
      expect(r, `midi ${midi}`).not.toBeNull();
      expect(r!.midi, `midi ${midi}`).toBe(midi);
    }
  });

  it('returns null for silence', () => {
    const r = detectPitch(magnitudesOf(new Float32Array(FFT_SIZE)), SR, FFT_SIZE);
    expect(r).toBeNull();
  });

  it('picks the loudest peak when two notes sound at once (monophonic tuner behaviour)', () => {
    const e2 = midiToFreq(40);
    const b3 = midiToFreq(59);
    const n = SR;
    const mix = new Float32Array(n);
    const loud = sine(e2, SR, 1.0, 0.6);
    const quiet = sine(b3, SR, 1.0, 0.05);
    for (let i = 0; i < n; i++) mix[i] = loud[i] + quiet[i];
    const r = detectPitch(magnitudesOf(mix), SR, FFT_SIZE);
    expect(r).not.toBeNull();
    expect(r!.midi).toBe(40);
  });

  it('ignores a peak outside the searched range', () => {
    const highNote = midiToFreq(80); // ~830 Hz, above TUNER_DEFAULT_MAX_HZ
    const r = detectPitch(magnitudesOf(sine(highNote, SR, 1.0)), SR, FFT_SIZE, { maxHz: TUNER_DEFAULT_MAX_HZ });
    expect(r).toBeNull();
  });

  it('honours custom minHz/maxHz and a4', () => {
    const r = detectPitch(magnitudesOf(sine(880, SR, 1.0)), SR, FFT_SIZE, { minHz: 700, maxHz: 1000 });
    expect(r).not.toBeNull();
    expect(r!.noteName).toBe('A5');

    const at432 = detectPitch(magnitudesOf(sine(216, SR, 1.0)), SR, FFT_SIZE, { a4: 432 });
    expect(at432).not.toBeNull();
    expect(at432!.midi).toBe(57); // A3 at a4=432 Hz reference
    expect(Math.abs(at432!.centsOff)).toBeLessThan(5);
  });

  it('throws on an invalid sampleRate or fftSize', () => {
    expect(() => detectPitch(new Float32Array(10), 0, FFT_SIZE)).toThrow(RangeError);
    expect(() => detectPitch(new Float32Array(10), SR, 0)).toThrow(RangeError);
  });

  it('works at 48 kHz too', () => {
    const fft = new RealFFT(FFT_SIZE);
    const mag = new Float32Array((FFT_SIZE >> 1) + 1);
    const freq = midiToFreq(50); // D3
    fft.magnitudes(sine(freq, 48000, 1.0), mag);
    const r = detectPitch(mag, 48000, FFT_SIZE);
    expect(r).not.toBeNull();
    expect(r!.midi).toBe(50);
    expect(Math.abs(r!.centsOff)).toBeLessThan(5);
  });

  it('default range covers exactly the standard open strings with headroom on each side', () => {
    expect(TUNER_DEFAULT_MIN_HZ).toBeLessThan(midiToFreq(40));
    expect(TUNER_DEFAULT_MAX_HZ).toBeGreaterThan(midiToFreq(64));
  });
});
