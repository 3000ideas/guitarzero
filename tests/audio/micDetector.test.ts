import { describe, expect, it } from 'vitest';
import { MicDetectorSource, detectorOptsFromSettings } from '../../src/audio/micDetector';
import { synthChord } from '../helpers/synth';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { DetectorFrame } from '../../src/types';
import type { MicInput } from '../../src/audio/mic';

const SR = 44100;
const FFT_SIZE = 8192;

/**
 * Minimal MicInput-shaped fake: a fixed sample rate/fftSize and a pushable onFrame stream. Cast
 * to `MicInput` at each construction site — `MicInput` is a concrete class with private fields,
 * so TS structural typing needs the cast even though MicDetectorSource only ever reads
 * `fftSize` / `context.sampleRate` / `onFrame` from it.
 */
class FakeMic {
  readonly fftSize = FFT_SIZE;
  readonly context = { sampleRate: SR } as AudioContext;
  private cbs = new Set<(frame: Float32Array, timeSec: number) => void>();

  onFrame(cb: (frame: Float32Array, timeSec: number) => void): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }

  push(frame: Float32Array, timeSec: number): void {
    for (const cb of Array.from(this.cbs)) cb(frame, timeSec);
  }

  asMicInput(): MicInput {
    return this as unknown as MicInput;
  }
}

/** Node has no global Worker, so MicDetectorSource always takes the synchronous fallback path here. */
describe('MicDetectorSource (synchronous fallback, no Worker in Node)', () => {
  it('is not using a worker in this environment', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput(), detectorOptsFromSettings(DEFAULT_SETTINGS));
    expect(source.usingWorker()).toBe(false);
    expect(source.detector).not.toBeNull();
    source.dispose();
  });

  it('delivers a DetectorFrame synchronously to subscribers on every mic frame', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput(), detectorOptsFromSettings(DEFAULT_SETTINGS));
    const received: DetectorFrame[] = [];
    const unsub = source.onFrame((f) => received.push(f));

    const silence = new Float32Array(FFT_SIZE);
    mic.push(silence, 1.0);
    expect(received).toHaveLength(1);
    expect(received[0].timeSec).toBe(1.0);
    expect(source.getLastFrame()).toBe(received[0]);

    unsub();
    mic.push(silence, 2.0);
    expect(received).toHaveLength(1); // unsubscribed: no more deliveries

    source.dispose();
  });

  it('detects a real chord (C major) synthesised through synthChord', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput(), detectorOptsFromSettings(DEFAULT_SETTINGS));
    const received: DetectorFrame[] = [];
    source.onFrame((f) => received.push(f));

    // C major voicing (E2 muted): C3 E3 G3 C4 E4 (MIDI 48 52 55 60 64), matches CHORD_LIBRARY 'C'.
    const signal = synthChord([48, 52, 55, 60, 64], SR, 1.0, { dbfs: -20, seed: 1 });
    const frame = signal.subarray(0, FFT_SIZE);
    mic.push(frame, 1.0);

    expect(received).toHaveLength(1);
    expect(received[0].bestChord?.name).toBe('C');
    source.dispose();
  });

  it('setOptions reaches the fallback detector (raises the effective gate)', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput(), { a4: 440, gateDb: -50, onsetThreshold: 1.5 });
    expect(source.getGateDb()).toBeLessThanOrEqual(-40);
    source.setOptions({ gateDb: -10 });
    expect(source.getGateDb()).toBeGreaterThanOrEqual(-10); // gate = max(gateDb, floor + 10)
    source.dispose();
  });

  it('setTranspose reaches the fallback detector and shifts the detected chord', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput(), { a4: 440, gateDb: -50, onsetThreshold: 1.5 });
    source.setTranspose(2);
    const received: DetectorFrame[] = [];
    source.onFrame((f) => received.push(f));
    // Sounding A major (57 61 64 69 73) read 2 semitones down -> written G major.
    const signal = synthChord([57, 61, 64, 69, 73], SR, 1.0, { dbfs: -20, seed: 2 });
    mic.push(signal.subarray(0, FFT_SIZE), 1.0);
    expect(received[0].bestChord?.name).toBe('G');
    source.dispose();
  });

  it('getGateDb/getNoiseFloorDb return sensible defaults before any frame arrives', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput());
    expect(Number.isFinite(source.getGateDb())).toBe(true);
    expect(Number.isFinite(source.getNoiseFloorDb())).toBe(true);
    source.dispose();
  });

  it('dispose() unsubscribes from the mic and stops delivering frames', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput());
    const received: DetectorFrame[] = [];
    source.onFrame((f) => received.push(f));
    source.dispose();
    mic.push(new Float32Array(FFT_SIZE), 5.0);
    expect(received).toHaveLength(0);
  });

  it('a subscriber that throws does not stop other subscribers or the source', () => {
    const mic = new FakeMic();
    const source = new MicDetectorSource(mic.asMicInput());
    const received: DetectorFrame[] = [];
    source.onFrame(() => {
      throw new Error('boom');
    });
    source.onFrame((f) => received.push(f));
    expect(() => mic.push(new Float32Array(FFT_SIZE), 1.0)).not.toThrow();
    expect(received).toHaveLength(1);
    source.dispose();
  });
});
