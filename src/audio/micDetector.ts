/**
 * MicDetectorSource: composes MicInput + ChordDetector into a DetectorSource. Every mic frame is
 * analysed once and the resulting DetectorFrame is fanned out to all subscribers (engine, HUD).
 */
import type { DetectorFrame, DetectorOpts, DetectorSource, Settings } from '../types';
import { ChordDetector } from '../dsp/detector';
import type { MicInput } from './mic';

/** The live-tunable detector options that come from the user's settings. */
export function detectorOptsFromSettings(s: Settings): DetectorOpts {
  return { a4: s.a4, gateDb: s.gateDb, onsetThreshold: s.onsetThreshold };
}

export type DetectorFrameCallback = (frame: DetectorFrame) => void;

export class MicDetectorSource implements DetectorSource {
  readonly detector: ChordDetector;

  private readonly subscribers = new Set<DetectorFrameCallback>();
  private unsubscribeMic: (() => void) | null;
  private lastFrame: DetectorFrame | null = null;

  constructor(mic: MicInput, opts: DetectorOpts = {}) {
    this.detector = new ChordDetector(mic.context.sampleRate, { ...opts, fftSize: mic.fftSize });
    this.unsubscribeMic = mic.onFrame((frame, timeSec) => this.handleFrame(frame, timeSec));
  }

  /** Subscribes to analysed frames; returns the unsubscribe function. */
  onFrame(cb: DetectorFrameCallback): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Live-updatable detector options (a4, gateDb, onsetThreshold). */
  setOptions(patch: Partial<Pick<DetectorOpts, 'a4' | 'gateDb' | 'onsetThreshold'>>): void {
    this.detector.setOptions(patch);
  }

  /** Semitones the guitar sounds above the written chords (song.capo + settings.tuningOffset). */
  setTranspose(semitones: number): void {
    this.detector.setTranspose(semitones);
  }

  /** Effective silence gate in dBFS (the engine reads it for the HUD when available). */
  getGateDb(): number {
    return this.detector.getGateDb();
  }

  getNoiseFloorDb(): number {
    return this.detector.getNoiseFloorDb();
  }

  /** The most recent analysed frame, or null before the first one. */
  getLastFrame(): DetectorFrame | null {
    return this.lastFrame;
  }

  /** Detaches from the mic. Subscribers stop receiving frames; the object is inert afterwards. */
  dispose(): void {
    this.unsubscribeMic?.();
    this.unsubscribeMic = null;
    this.subscribers.clear();
  }

  private handleFrame(frame: Float32Array, timeSec: number): void {
    let out: DetectorFrame;
    try {
      out = this.detector.process(frame, timeSec);
    } catch (err) {
      console.error('ChordDetector.process failed', err);
      return;
    }
    this.lastFrame = out;
    for (const cb of Array.from(this.subscribers)) {
      try {
        cb(out);
      } catch (err) {
        console.error('DetectorSource subscriber failed', err);
      }
    }
  }
}
