/**
 * Single shared AudioContext. Browsers require a user gesture before audio can start,
 * so screens call `ensureAudioContext()` from a click handler before using the mic or
 * the metronome.
 */

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Every DSP module (fft.ts, chroma.ts, onset.ts, detector.ts) takes sampleRate as a parameter
    // and is tested at 44100/48000/96000, so nothing needs a specific rate. Forcing one here would
    // make the browser resample in real time whenever it differs from the device's own shared-mode
    // format, which is exactly the extra work that turns into audible dropouts on cheap sound
    // chips the moment they also have to run the microphone (full-duplex) at the same time — the
    // context now simply takes the device's native rate. Likewise 'latencyHint: interactive' asks
    // for the smallest possible hardware buffer (lowest latency, least safety margin); 'playback'
    // asks for a larger, steadier buffer instead, trading a bit of fixed latency — already absorbed
    // by the latency calibration in Ajustes — for headroom against exactly this kind of underrun.
    ctx = new Ctor({ latencyHint: 'playback' });
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
