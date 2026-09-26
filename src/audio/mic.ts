/**
 * MicInput: getUserMedia + AnalyserNode + a ~40 ms capture loop that hands every subscriber a
 * NEW Float32Array of the last `fftSize` samples, stamped with the RAW AudioContext time of the
 * end of the frame (never latency-corrected here; only the practice engine applies latencySec).
 *
 * Capture runs on its OWN private AudioContext, never shared with playback (the backing track /
 * metronome use the separate shared context from audio/context.ts). A single AudioContext that
 * both pulls live microphone samples (via a MediaStreamAudioSourceNode) AND pushes buffered
 * playback samples (an AudioBufferSourceNode) has to service both within the same real-time
 * render callback; any jitter pulling the live capture can then delay or glitch the WHOLE
 * callback for that context, including the unrelated playback samples due at that same instant.
 * Giving capture its own context gives it its own independent Chrome-internal audio thread and
 * OS audio session, so a hiccup there can no longer stall the output context's rendering.
 *
 * Browser-only. Nothing here touches `window` at import time, so the module can be imported from
 * Node tests via type-only imports.
 */

export type MicErrorCode = 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'device';

/** Spanish, user-facing description of each failure. */
export const MIC_ERROR_MESSAGES: Record<MicErrorCode, string> = {
  insecure: 'Contexto no seguro: abre la app por https o en localhost',
  unsupported: 'Este navegador no permite capturar el micrófono',
  denied: 'Permiso de micrófono denegado',
  notfound: 'No se encontró ningún micrófono',
  device: 'No se pudo acceder al micrófono',
};

export class MicError extends Error {
  readonly code: MicErrorCode;

  constructor(code: MicErrorCode, message: string = MIC_ERROR_MESSAGES[code], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MicError';
    this.code = code;
  }
}

/** Maps a getUserMedia rejection to a MicError (denied / notfound / device). */
export function toMicError(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new MicError('denied', undefined, { cause: err });
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new MicError('notfound', undefined, { cause: err });
  }
  return new MicError('device', undefined, { cause: err });
}

/** Capture loop period. Frames overlap heavily (8192 samples ≈ 171 ms at 48 kHz vs a 40 ms hop). */
export const MIC_CAPTURE_INTERVAL_MS = 40;

export type MicFrameCallback = (frame: Float32Array, timeSec: number) => void;

export interface MicStartOptions {
  /**
   * Ask the browser for echo cancellation (default false: the raw signal is best for chord
   * detection). Useful when the backing track plays through speakers (settings.echoCancellation).
   */
  echoCancellation?: boolean;
}

/** AnalyserNode accepts powers of two in this range. */
const MIN_FFT_SIZE = 32;
const MAX_FFT_SIZE = 32768;

export class MicInput {
  readonly fftSize: number;

  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** This capture's own AudioContext (lazy; never shared with playback). See the class doc comment. */
  private captureCtx: AudioContext | null = null;
  private readonly subscribers = new Set<MicFrameCallback>();
  private starting: Promise<void> | null = null;
  /** Bumped by stop(): a start() that was awaiting getUserMedia when stop() ran discards its stream. */
  private generation = 0;
  /** echoCancellation the running stream was requested with (to restart when it changes). */
  private echoCancellation = false;
  private readonly onTrackEnded = (): void => this.stop();

  constructor(fftSize = 8192) {
    if (!Number.isInteger(fftSize) || fftSize < MIN_FFT_SIZE || fftSize > MAX_FFT_SIZE || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError(`fftSize must be a power of two between ${MIN_FFT_SIZE} and ${MAX_FFT_SIZE}, got ${fftSize}`);
    }
    this.fftSize = fftSize;
  }

  /**
   * This capture's private AudioContext (created lazily on first access; `start()` resumes it).
   * Deliberately NOT the shared playback context from audio/context.ts — see the class doc.
   */
  get context(): AudioContext {
    if (!this.captureCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.captureCtx = new Ctor({ latencyHint: 'playback' });
    }
    return this.captureCtx;
  }

  /**
   * Requests the microphone and starts the capture loop. `deviceId` is passed as an "ideal"
   * (bare) constraint, so an unknown id falls back to the default device instead of failing.
   * `opts.echoCancellation` (default false) is passed to getUserMedia as is. Rejects with a
   * MicError. Calling it while already running with the same device and options is a no-op;
   * with a different device or echoCancellation the input is restarted.
   */
  start(deviceId?: string, opts: MicStartOptions = {}): Promise<void> {
    const echoCancellation = opts.echoCancellation ?? false;
    if (this.starting) return this.starting;
    if (this.isRunning()) {
      const current = this.getTrackSettings()?.deviceId;
      const sameDevice = !deviceId || deviceId === current;
      if (sameDevice && echoCancellation === this.echoCancellation) return Promise.resolve();
      this.stop();
    }
    this.starting = this.doStart(deviceId, echoCancellation).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(deviceId: string | undefined, echoCancellation: boolean): Promise<void> {
    if (typeof window !== 'undefined' && !window.isSecureContext) throw new MicError('insecure');
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') throw new MicError('unsupported');

    const audio: MediaTrackConstraints = {
      echoCancellation,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (deviceId) audio.deviceId = deviceId; // bare value = ideal, never exact

    const generation = this.generation;
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio });
    } catch (err) {
      throw toMicError(err);
    }
    if (generation !== this.generation) {
      // stop() ran while we were waiting for permission: release what we just got.
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    let ctx: AudioContext;
    let sourceNode: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = this.context;
      if (ctx.state !== 'running') {
        try {
          // getUserMedia just resolved from a user-gesture-initiated call, which still counts as
          // user activation in every browser that matters here; if it doesn't, the next start()
          // (also gesture-initiated) resumes it.
          await ctx.resume();
        } catch {
          /* resumed on the next gesture */
        }
      }
      sourceNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = this.fftSize;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser); // the analyser is NOT connected to the destination (no monitoring)
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      throw new MicError('device', undefined, { cause: err });
    }

    this.stream = stream;
    this.sourceNode = sourceNode;
    this.analyser = analyser;
    this.echoCancellation = echoCancellation;
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', this.onTrackEnded);
    this.timer = setInterval(() => this.capture(), MIC_CAPTURE_INTERVAL_MS);
  }

  /** Stops the capture loop, disconnects the nodes and stops every track. Idempotent. */
  stop(): void {
    this.generation++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.sourceNode = null;
    }
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.removeEventListener('ended', this.onTrackEnded);
        track.stop();
      }
      this.stream = null;
    }
  }

  /** Subscribes to captured frames; returns the unsubscribe function. Frames only flow while running. */
  onFrame(cb: MicFrameCallback): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Audio input devices. Labels are only populated after a start() that was granted permission. */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return [];
    const devices = await mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /** Settings of the live audio track (deviceId, autoGainControl, ...), or null when not running. */
  getTrackSettings(): MediaTrackSettings | null {
    const track = this.stream?.getAudioTracks()[0];
    return track ? track.getSettings() : null;
  }

  /** True while the capture loop runs on a live track. */
  isRunning(): boolean {
    if (this.timer === null || this.stream === null) return false;
    return this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  private capture(): void {
    const analyser = this.analyser;
    if (!analyser || this.subscribers.size === 0) return;
    const frame = new Float32Array(this.fftSize); // a new buffer per frame: subscribers may keep it
    analyser.getFloatTimeDomainData(frame);
    const timeSec = this.context.currentTime; // RAW wall time of the end of the frame
    for (const cb of Array.from(this.subscribers)) {
      try {
        cb(frame, timeSec);
      } catch (err) {
        console.error('MicInput subscriber failed', err);
      }
    }
  }
}
