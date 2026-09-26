/**
 * MicDetectorSource: composes MicInput + ChordDetector into a DetectorSource. Every mic frame is
 * analysed once and the resulting DetectorFrame is fanned out to all subscribers (engine, HUD).
 *
 * The analysis (FFT, chroma, onset detection) runs in a dedicated Worker (detectorWorker.ts)
 * whenever `Worker` is available, so it can never compete with page rendering or with the
 * browser's own audio pipeline for main-thread time while a backing track plays. When `Worker`
 * is unavailable — Vitest's Node test environment, a browser that refuses module workers, or the
 * Worker constructor throwing — it falls back to running the same ChordDetector inline on the
 * main thread, exactly as before; the public API and the DetectorFrame each subscriber receives
 * are identical either way, so nothing else in the app needs to know which path is active.
 */
import type { DetectorFrame, DetectorOpts, DetectorSource, Settings } from '../types';
import { ChordDetector } from '../dsp/detector';
import type { DetectorWorkerInMessage, DetectorWorkerOutMessage } from './detectorWorker';
import type { MicInput } from './mic';

/** The live-tunable detector options that come from the user's settings. */
export function detectorOptsFromSettings(s: Settings): DetectorOpts {
  return { a4: s.a4, gateDb: s.gateDb, onsetThreshold: s.onsetThreshold };
}

export type DetectorFrameCallback = (frame: DetectorFrame) => void;

/** Sensible values shown before the first frame has been analysed. */
const INITIAL_GATE_DB = -50;
const INITIAL_NOISE_FLOOR_DB = -100;

export class MicDetectorSource implements DetectorSource {
  /** The in-thread detector when running the synchronous fallback; null while a worker is active. */
  readonly detector: ChordDetector | null;

  private readonly subscribers = new Set<DetectorFrameCallback>();
  private unsubscribeMic: (() => void) | null;
  private lastFrame: DetectorFrame | null = null;
  private worker: Worker | null = null;
  private workerGateDb = INITIAL_GATE_DB;
  private workerNoiseFloorDb = INITIAL_NOISE_FLOOR_DB;

  constructor(mic: MicInput, opts: DetectorOpts = {}) {
    const fullOpts: DetectorOpts = { ...opts, fftSize: mic.fftSize };
    this.detector = this.trySpawnWorker(mic.context.sampleRate, fullOpts) ? null : new ChordDetector(mic.context.sampleRate, fullOpts);
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
    if (this.worker) {
      const msg: DetectorWorkerInMessage = { type: 'setOptions', patch };
      this.worker.postMessage(msg);
      return;
    }
    this.detector?.setOptions(patch);
  }

  /** Semitones the guitar sounds above the written chords (song.capo + settings.tuningOffset). */
  setTranspose(semitones: number): void {
    if (this.worker) {
      const msg: DetectorWorkerInMessage = { type: 'setTranspose', semitones };
      this.worker.postMessage(msg);
      return;
    }
    this.detector?.setTranspose(semitones);
  }

  /** Effective silence gate in dBFS (the engine reads it for the HUD when available). */
  getGateDb(): number {
    return this.worker ? this.workerGateDb : (this.detector?.getGateDb() ?? INITIAL_GATE_DB);
  }

  getNoiseFloorDb(): number {
    return this.worker ? this.workerNoiseFloorDb : (this.detector?.getNoiseFloorDb() ?? INITIAL_NOISE_FLOOR_DB);
  }

  /** The most recent analysed frame, or null before the first one. */
  getLastFrame(): DetectorFrame | null {
    return this.lastFrame;
  }

  /** True while a worker is doing the analysis (diagnostics only). */
  usingWorker(): boolean {
    return this.worker !== null;
  }

  /** Detaches from the mic and terminates the worker (if any). Subscribers stop receiving frames. */
  dispose(): void {
    this.unsubscribeMic?.();
    this.unsubscribeMic = null;
    this.worker?.terminate();
    this.worker = null;
    this.subscribers.clear();
  }

  /** Spawns and wires the worker; returns false (falls back to the inline detector) on any failure. */
  private trySpawnWorker(sampleRate: number, opts: DetectorOpts): boolean {
    if (typeof Worker === 'undefined') return false;
    try {
      const worker = new Worker(new URL('./detectorWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<DetectorWorkerOutMessage>) => this.handleWorkerMessage(ev.data);
      worker.onerror = (ev) => console.error('El análisis de acordes en segundo plano falló', ev.message || ev);
      const init: DetectorWorkerInMessage = { type: 'init', sampleRate, opts };
      worker.postMessage(init);
      this.worker = worker;
      return true;
    } catch (err) {
      console.error('No se pudo iniciar el análisis de acordes en segundo plano; se ejecuta en el hilo principal', err);
      return false;
    }
  }

  private handleFrame(frame: Float32Array, timeSec: number): void {
    if (this.worker) {
      const msg: DetectorWorkerInMessage = { type: 'frame', frame, timeSec };
      // The frame's buffer is transferred (zero-copy): mic.ts allocates a fresh Float32Array per
      // frame anyway, so nothing on the main thread needs it again after this call.
      this.worker.postMessage(msg, [frame.buffer]);
      return; // the result arrives asynchronously via handleWorkerMessage
    }
    if (!this.detector) return; // worker failed to spawn AND the fallback wasn't built (unreachable)
    let out: DetectorFrame;
    try {
      out = this.detector.process(frame, timeSec);
    } catch (err) {
      console.error('ChordDetector.process failed', err);
      return;
    }
    this.emit(out);
  }

  private handleWorkerMessage(msg: DetectorWorkerOutMessage): void {
    if (msg.type === 'error') {
      console.error('Detector worker error', msg.message);
      return;
    }
    this.workerGateDb = msg.gateDb;
    this.workerNoiseFloorDb = msg.noiseFloorDb;
    this.emit(msg.frame);
  }

  private emit(out: DetectorFrame): void {
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
