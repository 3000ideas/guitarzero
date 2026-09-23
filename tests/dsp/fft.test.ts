import { describe, expect, it } from 'vitest';
import { RealFFT } from '../../src/dsp/fft';
import { makeRng } from '../helpers/synth';

/** Naive O(N^2) DFT of a real input. */
function naiveDft(x: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += x[t] * Math.cos(a);
      si += x[t] * Math.sin(a);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

function randomSignal(n: number, seed: number): Float32Array {
  const rng = makeRng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 2 * rng() - 1;
  return x;
}

describe('RealFFT', () => {
  it('rejects sizes that are not powers of two', () => {
    expect(() => new RealFFT(0)).toThrow();
    expect(() => new RealFFT(3)).toThrow();
    expect(() => new RealFFT(12)).toThrow();
    expect(() => new RealFFT(1)).toThrow();
    expect(() => new RealFFT(2)).not.toThrow();
  });

  for (const n of [16, 64]) {
    it(`forward() matches a naive DFT for size ${n}`, () => {
      const fft = new RealFFT(n);
      const x = randomSignal(n, 11 + n);
      const outRe = new Float32Array(n);
      const outIm = new Float32Array(n);
      fft.forward(x, outRe, outIm);
      const ref = naiveDft(x);
      for (let k = 0; k < n; k++) {
        expect(outRe[k]).toBeCloseTo(ref.re[k], 3);
        expect(outIm[k]).toBeCloseTo(ref.im[k], 3);
      }
    });

    it(`magnitudes() (unwindowed) matches |naive DFT| for size ${n}`, () => {
      const fft = new RealFFT(n);
      const x = randomSignal(n, 99 + n);
      const mag = new Float32Array(n / 2 + 1);
      fft.magnitudes(x, mag, false);
      const ref = naiveDft(x);
      for (let k = 0; k <= n / 2; k++) {
        expect(mag[k]).toBeCloseTo(Math.hypot(ref.re[k], ref.im[k]), 3);
      }
    });

    it(`magnitudes() (windowed) matches |naive DFT| of the Hann-windowed input for size ${n}`, () => {
      const fft = new RealFFT(n);
      const x = randomSignal(n, 7 + n);
      const windowed = new Float64Array(n);
      for (let i = 0; i < n; i++) windowed[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      const mag = new Float32Array(n / 2 + 1);
      fft.magnitudes(x, mag);
      const ref = naiveDft(windowed);
      for (let k = 0; k <= n / 2; k++) {
        expect(mag[k]).toBeCloseTo(Math.hypot(ref.re[k], ref.im[k]), 3);
      }
    });
  }

  it('window() is a periodic Hann window (sum = size / 2)', () => {
    const fft = new RealFFT(256);
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += fft.window(i);
    expect(sum).toBeCloseTo(128, 6);
    expect(fft.window(0)).toBeCloseTo(0, 9);
    expect(fft.window(128)).toBeCloseTo(1, 9);
  });

  it('pure sine peaks in the right bin, unnormalised (A*N/2 raw, A*N/4 windowed)', () => {
    const n = 1024;
    const bin = 100;
    const amp = 0.5;
    const x = new Float32Array(n);
    for (let t = 0; t < n; t++) x[t] = amp * Math.sin((2 * Math.PI * bin * t) / n);
    const fft = new RealFFT(n);
    const raw = new Float32Array(n / 2 + 1);
    fft.magnitudes(x, raw, false);
    let argmax = 0;
    for (let k = 1; k <= n / 2; k++) if (raw[k] > raw[argmax]) argmax = k;
    expect(argmax).toBe(bin);
    expect(raw[bin]).toBeCloseTo((amp * n) / 2, 2);
    expect(raw[bin - 1]).toBeLessThan(1e-2);
    expect(raw[bin + 1]).toBeLessThan(1e-2);

    const win = new Float32Array(n / 2 + 1);
    fft.magnitudes(x, win, true);
    argmax = 0;
    for (let k = 1; k <= n / 2; k++) if (win[k] > win[argmax]) argmax = k;
    expect(argmax).toBe(bin);
    expect(win[bin]).toBeCloseTo((amp * n) / 4, 2);
    // Hann main lobe: neighbours at half the peak, beyond that nothing.
    expect(win[bin - 1]).toBeCloseTo((amp * n) / 8, 2);
    expect(win[bin + 1]).toBeCloseTo((amp * n) / 8, 2);
    expect(win[bin + 2]).toBeLessThan(1e-2);
    expect(win[bin + 40]).toBeLessThan(1e-2);
  });

  it('a non-integer-bin sine leaks into the neighbouring bins only (Hann sidelobes below -30 dB)', () => {
    const n = 8192;
    const sr = 48000;
    const f = 82.41;
    const x = new Float32Array(n);
    for (let t = 0; t < n; t++) x[t] = 0.3 * Math.sin((2 * Math.PI * f * t) / sr);
    const fft = new RealFFT(n);
    const mag = new Float32Array(n / 2 + 1);
    fft.magnitudes(x, mag);
    const expectedBin = Math.round((f * n) / sr);
    let argmax = 0;
    for (let k = 1; k <= n / 2; k++) if (mag[k] > mag[argmax]) argmax = k;
    expect(argmax).toBe(expectedBin);
    for (let k = expectedBin + 4; k < 400; k++) expect(mag[k]).toBeLessThan(mag[expectedBin] * 0.032);
  });

  it('DC input gives the window sum at bin 0', () => {
    const n = 512;
    const fft = new RealFFT(n);
    const x = new Float32Array(n).fill(1);
    const mag = new Float32Array(n / 2 + 1);
    fft.magnitudes(x, mag, true);
    expect(mag[0]).toBeCloseTo(n / 2, 3);
    fft.magnitudes(x, mag, false);
    expect(mag[0]).toBeCloseTo(n, 3);
    expect(mag[1]).toBeLessThan(1e-3);
  });

  it('shorter inputs are zero-padded and the instance can be reused', () => {
    const fft = new RealFFT(64);
    const mag = new Float32Array(33);
    fft.magnitudes(new Float32Array(16).fill(1), mag, false);
    expect(mag[0]).toBeCloseTo(16, 4);
    fft.magnitudes(new Float32Array(64).fill(1), mag, false);
    expect(mag[0]).toBeCloseTo(64, 4);
  });
});
