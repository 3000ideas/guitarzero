/**
 * Runs ChordDetector.process() off the main thread: pure computation only (FFT, chroma, onset
 * detection), no DOM and no Web Audio access, so it can never contend with page rendering or —
 * more importantly — with the browser's own audio pipeline while a backing track plays. This is
 * what MicDetectorSource (micDetector.ts) spawns when Worker is available; it falls back to
 * running the same ChordDetector inline (main thread) when it is not (e.g. Vitest's Node
 * environment, or a browser that refuses module workers), so this file has no test of its own —
 * its only logic is the message plumbing around an already fully-tested ChordDetector.
 *
 * `self` is typed as `Worker` (not `DedicatedWorkerGlobalScope`) to avoid mixing the "dom" and
 * "webworker" TS lib sets in one project-wide tsconfig; the two postMessage/onmessage shapes are
 * compatible for what this file actually uses.
 */
import type { DetectorFrame, DetectorOpts } from '../types';
import { ChordDetector } from '../dsp/detector';

export type DetectorWorkerInMessage =
  | { type: 'init'; sampleRate: number; opts: DetectorOpts }
  | { type: 'frame'; frame: Float32Array; timeSec: number }
  | { type: 'setOptions'; patch: Partial<Pick<DetectorOpts, 'a4' | 'gateDb' | 'onsetThreshold'>> }
  | { type: 'setTranspose'; semitones: number };

export type DetectorWorkerOutMessage =
  | { type: 'result'; frame: DetectorFrame; gateDb: number; noiseFloorDb: number }
  | { type: 'error'; message: string };

const ctx = self as unknown as Worker;

let detector: ChordDetector | null = null;

ctx.onmessage = (ev: MessageEvent<DetectorWorkerInMessage>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        detector = new ChordDetector(msg.sampleRate, msg.opts);
        return;
      case 'frame': {
        if (!detector) return; // a stray frame before 'init' landed: drop it, the next one will work
        const frame = detector.process(msg.frame, msg.timeSec);
        const out: DetectorWorkerOutMessage = {
          type: 'result',
          frame,
          gateDb: detector.getGateDb(),
          noiseFloorDb: detector.getNoiseFloorDb(),
        };
        // frame.energyChroma/chroma are freshly allocated by process() every call (never reused
        // internally), so transferring their buffers away is safe and avoids copying them.
        ctx.postMessage(out, [frame.energyChroma.buffer, frame.chroma.buffer]);
        return;
      }
      case 'setOptions':
        detector?.setOptions(msg.patch);
        return;
      case 'setTranspose':
        detector?.setTranspose(msg.semitones);
        return;
    }
  } catch (err) {
    const out: DetectorWorkerOutMessage = { type: 'error', message: err instanceof Error ? err.message : String(err) };
    ctx.postMessage(out);
  }
};
