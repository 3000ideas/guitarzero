/**
 * Real-input radix-2 FFT (iterative, decimation in time, precomputed twiddle and bit-reversal
 * tables). Pure TypeScript on typed arrays: no Web Audio, testable in Node.
 *
 * `magnitudes()` applies a periodic Hann window and returns RAW magnitudes (no 1/N
 * normalisation): a full-scale sine of amplitude A peaks at about A * size / 4 after windowing
 * (A * size / 2 without the window). Everything downstream (chroma, onset flux) is written for
 * this unnormalised scale.
 */
export class RealFFT {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly bitRev: Uint32Array;
  private readonly hann: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  /** @param size FFT length, a power of two >= 2. */
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`RealFFT size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    const half = size >> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const angle = (2 * Math.PI * k) / size;
      this.cosTable[k] = Math.cos(angle);
      this.sinTable[k] = Math.sin(angle);
    }
    let levels = 0;
    for (let s = size; s > 1; s >>= 1) levels++;
    this.bitRev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.bitRev[i] = r >>> 0;
    }
    this.hann = new Float64Array(size);
    for (let n = 0; n < size; n++) this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** Hann window coefficient for sample n (periodic Hann, sum = size / 2). */
  window(n: number): number {
    return this.hann[n];
  }

  /**
   * Forward complex FFT of a real input (no window). Writes all `size` bins of the spectrum
   * X[k] = sum x[n] * exp(-2*pi*i*k*n/size) into outRe / outIm (length >= size).
   */
  forward(input: Float32Array, outRe: Float32Array, outIm: Float32Array): void {
    this.transform(input, false);
    const n = this.size;
    for (let i = 0; i < n; i++) {
      outRe[i] = this.re[i];
      outIm[i] = this.im[i];
    }
  }

  /**
   * Magnitude spectrum |X[k]| for k = 0..size/2 (outMag length >= size/2 + 1), unnormalised.
   * With `windowed` (default) the input is multiplied by a Hann window first.
   */
  magnitudes(input: Float32Array, outMag: Float32Array, windowed = true): void {
    this.transform(input, windowed);
    const half = this.size >> 1;
    const re = this.re;
    const im = this.im;
    for (let k = 0; k <= half; k++) outMag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }

  private transform(input: Float32Array, windowed: boolean): void {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    const br = this.bitRev;
    const w = this.hann;
    const len = Math.min(n, input.length);
    if (windowed) {
      for (let i = 0; i < len; i++) re[br[i]] = input[i] * w[i];
    } else {
      for (let i = 0; i < len; i++) re[br[i]] = input[i];
    }
    for (let i = len; i < n; i++) re[br[i]] = 0;
    im.fill(0);
    const cos = this.cosTable;
    const sin = this.sinTable;
    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1;
      const step = n / span;
      for (let i = 0; i < n; i += span) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = -sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b];
          const xi = im[b];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}
