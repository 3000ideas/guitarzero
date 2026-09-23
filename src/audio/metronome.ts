/**
 * Metronome: a ClickScheduler on the shared AudioContext. Each click is a short sine burst at
 * 4500 Hz (normal) or 5500 Hz (accent), spectrally separated from the analysis: the chroma only
 * looks at MIDI 40..88 (< ~1358 Hz) and the onset flux stops at 3500 Hz, so a click captured by
 * the mic cannot create onsets or chroma energy. There is deliberately NO temporal onset filter
 * around clicks (a perfect strum coincides with the click by construction).
 */
import type { ClickScheduler } from '../types';

export const CLICK_FREQ_HZ = 4500;
export const CLICK_ACCENT_FREQ_HZ = 5500;
export const CLICK_GAIN = 0.5;
/** Linear attack ramp length. */
export const CLICK_ATTACK_SEC = 0.003;
/** Exponential decay time constant after the attack. */
export const CLICK_DECAY_TAU_SEC = 0.008;
/** Oscillator stop time relative to its start. */
export const CLICK_LENGTH_SEC = 0.05;
/** Used when the context does not report outputLatency (Safari) or reports 0. */
export const DEFAULT_OUTPUT_LATENCY_SEC = 0.03;

interface PendingClick {
  osc: OscillatorNode;
  gain: GainNode;
  stopAt: number;
}

export class Metronome implements ClickScheduler {
  private readonly ctx: AudioContext;
  private enabled = true;
  private pending: PendingClick[] = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Seconds the oscillator is started ahead of the nominal time so the click is HEARD on time. */
  outputLatencySec(): number {
    const reported = (this.ctx as { outputLatency?: number }).outputLatency;
    return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : DEFAULT_OUTPUT_LATENCY_SEC;
  }

  /**
   * Schedules a click to be heard at `nominalSec` (AudioContext clock). No-op while disabled, and
   * never schedules in the past: a start time already behind ctx.currentTime is skipped.
   */
  scheduleClick(nominalSec: number, accent: boolean): void {
    if (!this.enabled || !Number.isFinite(nominalSec)) return;
    const ctx = this.ctx;
    const t = nominalSec - this.outputLatencySec();
    if (t < ctx.currentTime) return;
    this.prune(ctx.currentTime);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = accent ? CLICK_ACCENT_FREQ_HZ : CLICK_FREQ_HZ;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(CLICK_GAIN, t + CLICK_ATTACK_SEC);
    gain.gain.setTargetAtTime(0, t + CLICK_ATTACK_SEC, CLICK_DECAY_TAU_SEC);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + CLICK_LENGTH_SEC);

    const entry: PendingClick = { osc, gain, stopAt: t + CLICK_LENGTH_SEC };
    this.pending.push(entry);
    osc.onended = () => {
      this.forget(entry);
      disconnectQuietly(entry);
    };
  }

  /** Silences and releases every pending (not yet finished) click. */
  clear(): void {
    const list = this.pending;
    this.pending = [];
    const now = this.ctx.currentTime;
    for (const entry of list) {
      entry.osc.onended = null;
      try {
        entry.gain.gain.cancelScheduledValues(0);
        entry.gain.gain.setValueAtTime(0, now);
      } catch {
        /* ignore */
      }
      try {
        entry.osc.stop(now);
      } catch {
        /* already stopped */
      }
      disconnectQuietly(entry);
    }
  }

  /** Disabled: scheduleClick becomes a no-op (the engine keeps planning beats) and pending clicks are silenced. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Clicks scheduled and not yet finished (diagnostics). */
  getPendingCount(): number {
    return this.pending.length;
  }

  private forget(entry: PendingClick): void {
    const i = this.pending.indexOf(entry);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /** Drops entries whose oscillator has already stopped, in case `onended` never fired. */
  private prune(now: number): void {
    if (this.pending.length === 0) return;
    const keep: PendingClick[] = [];
    for (const entry of this.pending) {
      if (entry.stopAt + 0.5 < now) {
        entry.osc.onended = null;
        disconnectQuietly(entry);
      } else {
        keep.push(entry);
      }
    }
    this.pending = keep;
  }
}

function disconnectQuietly(entry: PendingClick): void {
  try {
    entry.osc.disconnect();
  } catch {
    /* ignore */
  }
  try {
    entry.gain.disconnect();
  } catch {
    /* ignore */
  }
}
