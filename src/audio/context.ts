/**
 * Single shared AudioContext. Browsers require a user gesture before audio can start,
 * so screens call `ensureAudioContext()` from a click handler before using the mic or
 * the metronome.
 */

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Pin 48 kHz so the DSP (fftSize 8192, band limits) sees the same resolution on every device
    // (a 96 kHz interface would halve the frequency resolution). Fall back if the browser refuses.
    try {
      ctx = new Ctor({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      ctx = new Ctor({ latencyHint: 'interactive' });
    }
  }
  return ctx;
}

/** Create (if needed) and resume the context. Call from a user-gesture handler. */
export async function ensureAudioContext(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* resume can reject before a gesture; callers retry on the next gesture */
    }
  }
  return c;
}
