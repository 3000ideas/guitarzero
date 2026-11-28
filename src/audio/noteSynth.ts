/**
 * A plucked guitar string (Karplus–Strong) for the tablature screen. The samples are computed in plain math (testable
 * in Node) and wrapped in an AudioBuffer only in the browser; every (string, fret) buffer is made once and reused.
 */

/** MIDI note of each open string, top tab line first: e B G D A E (standard tuning). */
export const OPEN_STRING_MIDI = [64, 59, 55, 50, 45, 40] as const;

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note played by `fret` on the tab line `row` (0 = top = thinnest string). */
export function tabNoteMidi(row: number, fret: number): number {
  return OPEN_STRING_MIDI[Math.max(0, Math.min(5, row))] + fret;
}

/** Deterministic noise so a note always sounds the same. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** `seconds` of a plucked string at `freqHz`, peak 0.5, ending in a short fade so it never clicks. */
export function pluckSamples(freqHz: number, sampleRate: number, seconds = 2.4): Float32Array {
  const total = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(total);
  const period = Math.max(2, Math.round(sampleRate / freqHz));
  const rnd = noise(Math.round(freqHz * 100));
  const line = new Float32Array(period);
  for (let i = 0; i < period; i++) line[i] = rnd();
  // Two passes of smoothing take the harshness off the first instant (a softer, rounder pick).
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < period; i++) line[i] = (line[i] + line[(i + 1) % period]) * 0.5;
  const decay = 0.9965;
  let idx = 0;
  for (let i = 0; i < total; i++) {
    const cur = line[idx];
    out[i] = cur;
    line[idx] = (cur + line[(idx + 1) % period]) * 0.5 * decay;
    idx = (idx + 1) % period;
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 0 ? 0.5 / peak : 1;
  const fade = Math.min(total, Math.round(0.1 * sampleRate));
  for (let i = 0; i < total; i++) out[i] *= scale * (i > total - fade ? (total - i) / fade : 1);
  return out;
}

const cache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/** The pluck of a MIDI note as an AudioBuffer of `ctx` (cached). */
export function pluckBuffer(ctx: BaseAudioContext, midi: number): AudioBuffer {
  let perCtx = cache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    cache.set(ctx, perCtx);
  }
  let buf = perCtx.get(midi);
  if (!buf) {
    const data = pluckSamples(midiToHz(midi), ctx.sampleRate);
    buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    perCtx.set(midi, buf);
  }
  return buf;
}
