/**
 * Synthesizes a "chords only" backing track for a song: no drums, bass or vocals, just the
 * chord shapes being strummed in the exact rhythm of song.events (the same data that drives the
 * visual highway). Built for players who find a real recording too busy to follow while learning
 * a song — this renders only what they need to hear: which chord, and when to strum it.
 *
 * Split in two layers on purpose:
 *  - planChordTrack(): pure, no Web Audio, fully unit-testable — decides WHAT sounds and WHEN.
 *  - renderChordTrack(): thin OfflineAudioContext wiring, like audio/metronome.ts and
 *    audio/backing.ts, verified by hand in a real browser (OfflineAudioContext does not exist in
 *    the Node/Vitest environment).
 */
import type { Song } from '../types';
import { getChordShape, shapeMidiNotes } from '../music/chords';
import { midiToFreq } from '../music/notes';
import { beatToSec, songDurationSec } from '../song/tempo';

/** Delay between successive strings of a strummed chord, seconds (mimics a real strum's sweep). */
export const CHORD_SYNTH_STRING_STAGGER_SEC = 0.01;
/** Extra silence appended after the last event so its ring is not cut off. */
export const CHORD_SYNTH_TAIL_SEC = 1.2;

export interface PlannedNote {
  kind: 'note';
  atSec: number;
  freqHz: number;
}

export interface PlannedMute {
  kind: 'mute';
  atSec: number;
}

export type PlannedVoice = PlannedNote | PlannedMute;

/**
 * The list of individual notes (and percussive mutes) to render, in the order song.events
 * describes: a rest ('nc') is silent, a muted ('x') strum becomes one percussive hit, and a real
 * strum becomes one note per sounding string of the chord's fingering — low string first for a
 * downstrum, high string first for an upstrum — each slightly delayed so the strum "sweeps"
 * across the strings instead of all of them starting at the exact same instant.
 */
export function planChordTrack(song: Song, a4 = 440): PlannedVoice[] {
  const voices: PlannedVoice[] = [];
  for (const event of song.events) {
    if (event.chord.quality === 'nc') continue;
    const atSec = beatToSec(song.tempoSegments, event.time);
    if (event.muted) {
      voices.push({ kind: 'mute', atSec });
      continue;
    }
    const shape = getChordShape(event.chord);
    if (!shape) continue;
    const midiNotes = shapeMidiNotes(shape); // string order: low (index 0) to high
    const n = midiNotes.length;
    for (let i = 0; i < n; i++) {
      const stringOrder = event.direction === 'down' ? i : n - 1 - i;
      voices.push({ kind: 'note', atSec: atSec + stringOrder * CHORD_SYNTH_STRING_STAGGER_SEC, freqHz: midiToFreq(midiNotes[i], a4) });
    }
  }
  return voices;
}

/** Total length of the rendered buffer: the song's duration plus a tail for the last chord to ring out. */
export function chordTrackDurationSec(song: Song): number {
  return songDurationSec(song) + CHORD_SYNTH_TAIL_SEC;
}

const NOTE_ATTACK_SEC = 0.004;
const NOTE_DECAY_TAU_SEC = 0.35;
const NOTE_PEAK_GAIN = 0.14;
const NOTE_STOP_AFTER_SEC = NOTE_ATTACK_SEC + NOTE_DECAY_TAU_SEC * 6;
const MUTE_LENGTH_SEC = 0.09;
const MUTE_GAIN = 0.5;
const MASTER_LOWPASS_HZ = 3500;

function scheduleNote(ctx: OfflineAudioContext, master: GainNode, freqHz: number, atSec: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freqHz, atSec);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, atSec);
  gain.gain.linearRampToValueAtTime(NOTE_PEAK_GAIN, atSec + NOTE_ATTACK_SEC);
  gain.gain.setTargetAtTime(0, atSec + NOTE_ATTACK_SEC, NOTE_DECAY_TAU_SEC);
  osc.connect(gain).connect(master);
  osc.start(atSec);
  osc.stop(atSec + NOTE_STOP_AFTER_SEC);
}

function createMuteNoiseBuffer(ctx: OfflineAudioContext, sampleRate: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(MUTE_LENGTH_SEC * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function scheduleMute(ctx: OfflineAudioContext, master: GainNode, noiseBuffer: AudioBuffer, atSec: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 2200;
  bandpass.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, atSec);
  gain.gain.linearRampToValueAtTime(MUTE_GAIN, atSec + 0.002);
  gain.gain.setTargetAtTime(0, atSec + 0.002, 0.02);
  src.connect(bandpass).connect(gain).connect(master);
  src.start(atSec);
  src.stop(atSec + MUTE_LENGTH_SEC + 0.05);
}

/**
 * Renders the synthesized chord track to an AudioBuffer via OfflineAudioContext, ready to feed
 * into BackingTrack.loadBuffer(). Requires a browser: OfflineAudioContext does not exist in Node.
 */
export async function renderChordTrack(song: Song, sampleRate = 44100, a4 = 440): Promise<AudioBuffer> {
  const durationSec = Math.max(0.1, chordTrackDurationSec(song));
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  const Ctor = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctor(1, length, sampleRate);

  const master = ctx.createGain();
  master.gain.value = 1;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = MASTER_LOWPASS_HZ;
  master.connect(lowpass);
  lowpass.connect(ctx.destination);

  const voices = planChordTrack(song, a4);
  const noiseBuffer = voices.some((v) => v.kind === 'mute') ? createMuteNoiseBuffer(ctx, sampleRate) : null;
  for (const voice of voices) {
    if (voice.kind === 'mute') {
      if (noiseBuffer) scheduleMute(ctx, master, noiseBuffer, voice.atSec);
    } else {
      scheduleNote(ctx, master, voice.freqHz, voice.atSec);
    }
  }
  return ctx.startRendering();
}
