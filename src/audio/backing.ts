/**
 * BackingTrack: plays a song's audio file (decoded once into an AudioBuffer) on the shared
 * AudioContext, in sync with the practice clock (SPEC.md section 11, audio/backing.ts).
 *
 * The screen owns the track: on every count-in (start, resume, loop restart) it calls
 * `start(wallSec, audioOffsetSec, rate)` with the wall time of the count-in start beat, the
 * audio position that corresponds to that beat (`audio.offsetSec + beatToSec(...)`) and the
 * tempo scale; on pause / end it calls `stop()`. Each start creates a fresh
 * AudioBufferSourceNode → GainNode → destination (sources are single-use in Web Audio).
 *
 * Like the metronome, the source is started `outputLatency` early so the sound is HEARD at the
 * nominal wall time (the same instant the ball lands and the click sounds).
 */

/** Used when the context does not report outputLatency (Safari) or reports 0. */
const DEFAULT_OUTPUT_LATENCY_SEC = 0.03;
/** Time constant of the gain ramp on setGain (avoids zipper noise from the volume slider). */
const GAIN_RAMP_TAU_SEC = 0.01;

export interface BackingTrackInfo {
  durationSec: number;
  sampleRate: number;
  channels: number;
}

/** decodeAudioData through both the promise form and the legacy callback form (old Safari). */
function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let p: Promise<AudioBuffer> | undefined;
    try {
      p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    } catch (err) {
      reject(err);
      return;
    }
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

function disconnectQuietly(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

export class BackingTrack {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private decoded: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private mono: Float32Array | null = null;
  private gainValue = 1;
  private disposed = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.gainValue;
    this.gainNode.connect(ctx.destination);
  }

  /** The decoded audio, or null before load() (or after dispose()). */
  get buffer(): AudioBuffer | null {
    return this.decoded;
  }

  /**
   * Decodes `blob` (works while the context is suspended). Replaces the previous audio and stops
   * any playback. Rejects with a Spanish message when the file cannot be read or decoded.
   */
  async load(blob: Blob): Promise<BackingTrackInfo> {
    this.stop();
    let data: ArrayBuffer;
    try {
      data = await blob.arrayBuffer();
    } catch (err) {
      throw new Error('No se pudo leer el archivo de audio', { cause: err });
    }
    let buffer: AudioBuffer;
    try {
      buffer = await decode(this.ctx, data);
    } catch (err) {
      throw new Error('Formato de audio no compatible con este navegador (prueba con MP3, WAV u OGG)', { cause: err });
    }
    if (this.disposed) throw new Error('La pista de audio ya se ha liberado');
    this.decoded = buffer;
    this.mono = null;
    return { durationSec: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
  }

  /** Like load(), but for an already-decoded buffer (e.g. audio/chordSynth.ts's synthesized track). */
  loadBuffer(buffer: AudioBuffer): BackingTrackInfo {
    this.stop();
    if (this.disposed) throw new Error('La pista de audio ya se ha liberado');
    this.decoded = buffer;
    this.mono = null;
    return { durationSec: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
  }

  /** Seconds the source is started ahead of the nominal time so the audio is HEARD on time. */
  outputLatencySec(): number {
    const reported = (this.ctx as { outputLatency?: number }).outputLatency;
    return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : DEFAULT_OUTPUT_LATENCY_SEC;
  }

  /**
   * Plays the audio so that its position `audioOffsetSec` is heard at wall time `whenWall`
   * (AudioContext clock), at `rate` × speed (pitch follows the rate). Any previous playback is
   * stopped first.
   *  - `audioOffsetSec >= 0`: `source.start(max(whenWall, now), audioOffsetSec)`; when `whenWall`
   *    is already in the past the offset is advanced by the elapsed wall time × rate.
   *  - `audioOffsetSec < 0` (the chart starts before the audio): the source starts from 0 at
   *    `whenWall − audioOffsetSec / rate`.
   *  - `audioOffsetSec >= duration` (or no audio loaded): nothing plays.
   */
  start(whenWall: number, audioOffsetSec: number, rate: number): void {
    const buffer = this.decoded;
    this.stop();
    if (!buffer || this.disposed) return;
    if (!Number.isFinite(whenWall) || !Number.isFinite(audioOffsetSec)) return;
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const duration = buffer.duration;
    if (audioOffsetSec >= duration) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Nominal start of the source: `outputLatency` before the wall time at which it must be heard.
    let when = whenWall - this.outputLatencySec();
    let offset: number;
    if (audioOffsetSec >= 0) {
      offset = audioOffsetSec;
    } else {
      when -= audioOffsetSec / r;
      offset = 0;
    }
    if (when < now) {
      // Late start: skip what should already have played.
      offset += (now - when) * r;
      when = now;
      if (offset >= duration) return;
    }

    let source: AudioBufferSourceNode;
    try {
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = r;
      source.connect(this.gainNode);
      source.start(when, offset);
    } catch (err) {
      console.warn('No se pudo reproducir la pista de audio', err);
      return;
    }
    source.onended = () => {
      if (this.source === source) this.source = null;
      disconnectQuietly(source);
    };
    this.source = source;
  }

  /** Stops and releases the current source, if any. Idempotent. */
  stop(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* never started or already stopped */
    }
    disconnectQuietly(source);
  }

  /** Linear playback gain, clamped to 0..1, ramped briefly to avoid clicks. */
  setGain(g: number): void {
    const v = Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : this.gainValue;
    this.gainValue = v;
    const param = this.gainNode.gain;
    try {
      const now = this.ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(v, now, GAIN_RAMP_TAU_SEC);
    } catch {
      param.value = v;
    }
  }

  getGain(): number {
    return this.gainValue;
  }

  /** True from start() until stop() or the end of the audio. */
  isPlaying(): boolean {
    return this.source !== null;
  }

  /** The decoded audio mixed down to mono (mean of the channels), cached. Empty before load(). */
  monoSamples(): Float32Array {
    if (this.mono) return this.mono;
    const buffer = this.decoded;
    if (!buffer) return new Float32Array(0);
    const n = buffer.length;
    const channels = buffer.numberOfChannels;
    const out = new Float32Array(n);
    if (channels <= 1) {
      out.set(buffer.getChannelData(0).subarray(0, n));
    } else {
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += data[i];
      }
      const scale = 1 / channels;
      for (let i = 0; i < n; i++) out[i] *= scale;
    }
    this.mono = out;
    return out;
  }

  /** Stops playback and releases the audio and the nodes. The object is inert afterwards. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.decoded = null;
    this.mono = null;
    disconnectQuietly(this.gainNode);
  }
}
