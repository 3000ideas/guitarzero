/**
 * Synthesizes a "chords only" backing track for a song: no drums, bass or vocals, just the
 * chord shapes being strummed in the exact rhythm of song.events (the same data that drives the
 * visual highway). Built for players who find a real recording too busy to follow while learning
 * a song — this renders only what they need to hear: which chord, and when to strum it.
 *
 * Split in two layers on purpose:
 *  - planChordTrack(): pure, no Web Audio, fully unit-testable — decides WHAT sounds and WHEN.
 *  - renderChordTrack(): writes samples directly into an AudioBuffer (plain per-sample math, no
 *    Web Audio node graph). An earlier version scheduled one OscillatorNode + GainNode pair per
 *    note through an OfflineAudioContext; that rendered fine for a short song but took roughly
 *    7 ms of wall time PER NOTE once a full song's worth of notes were scheduled (a few thousand
 *    for a several-minute song, i.e. 15-45+ seconds of "Cargando pista…" — reported by the user
 *    as the song "not starting" at all, since practice.ts awaits this before starting the
 *    session). Direct sample synthesis has no per-node overhead: even a large song renders in
 *    well under a second. Still verified by hand in a real browser (the AudioBuffer constructor
 *    is a browser-only Web Audio API; Node/Vitest has no implementation of it).
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
 *
 * `song.capo` is added to every note: `getChordShape`/`shapeMidiNotes` give the fret positions
 * of the WRITTEN shape on an un-capoed neck (the same "written space" the chord detector judges
 * in, see dsp/detector.ts setTranspose), but a capo raises what that shape actually SOUNDS like
 * by `capo` semitones — without this the synth would ring a capo's worth flat of the real song.
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
      voices.push({ kind: 'note', atSec: atSec + stringOrder * CHORD_SYNTH_STRING_STAGGER_SEC, freqHz: midiToFreq(midiNotes[i] + song.capo, a4) });
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
/** Samples beyond this are close enough to 0 (4 time constants, ~-35 dB) that computing them is pointless. */
const NOTE_STOP_AFTER_SEC = NOTE_ATTACK_SEC + NOTE_DECAY_TAU_SEC * 4;
const MUTE_ATTACK_SEC = 0.002;
const MUTE_DECAY_TAU_SEC = 0.02;
const MUTE_STOP_AFTER_SEC = MUTE_ATTACK_SEC + MUTE_DECAY_TAU_SEC * 6;
const MUTE_GAIN = 0.5;
const MASTER_LOWPASS_HZ = 3500;

/** Triangle wave, range -1..1, from a 0..1 phase (0 = rising through 0). */
function triangle(phase: number): number {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

/**
 * Adds one plucked-string-ish note (triangle wave, fast linear attack then exponential decay)
 * directly into `data`, starting at `atSec`. Mixes (+=) rather than overwrites, so overlapping
 * notes and the strum stagger sum naturally, exactly like real strings ringing together.
 */
function addNote(data: Float32Array, sampleRate: number, freqHz: number, atSec: number): void {
  const startSample = Math.round(atSec * sampleRate);
  const attackSamples = Math.max(1, Math.round(NOTE_ATTACK_SEC * sampleRate));
  const totalSamples = Math.round(NOTE_STOP_AFTER_SEC * sampleRate);
  const decayPerSample = Math.exp(-1 / (NOTE_DECAY_TAU_SEC * sampleRate));
  const phaseInc = freqHz / sampleRate;
  let phase = 0;
  let env = 0;
  for (let i = 0; i < totalSamples; i++) {
    const idx = startSample + i;
    if (idx >= data.length) break;
    env = i < attackSamples ? (NOTE_PEAK_GAIN * (i + 1)) / attackSamples : env * decayPerSample;
    if (idx >= 0) data[idx] += triangle(phase) * env;
    phase += phaseInc;
  }
}

/** Adds one filtered white-noise percussive hit (a palm-muted "chunk" strum) into `data`. */
function addMuteHit(data: Float32Array, sampleRate: number, atSec: number): void {
  const startSample = Math.round(atSec * sampleRate);
  const attackSamples = Math.max(1, Math.round(MUTE_ATTACK_SEC * sampleRate));
  const totalSamples = Math.round(MUTE_STOP_AFTER_SEC * sampleRate);
  const decayPerSample = Math.exp(-1 / (MUTE_DECAY_TAU_SEC * sampleRate));
  // Cheap one-pole low-pass then one-pole high-pass on white noise: rough approximation of a
  // bandpass, enough to turn raw hiss into a dull percussive "chunk" without a full filter node.
  const lowpassA = 0.35;
  const highpassA = 0.95;
  let lp = 0;
  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let env = 0;
  for (let i = 0; i < totalSamples; i++) {
    const idx = startSample + i;
    if (idx >= data.length) break;
    env = i < attackSamples ? (MUTE_GAIN * (i + 1)) / attackSamples : env * decayPerSample;
    const noise = Math.random() * 2 - 1;
    lp += lowpassA * (noise - lp);
    const hp = highpassA * (hpPrevOut + lp - hpPrevIn);
    hpPrevIn = lp;
    hpPrevOut = hp;
    if (idx >= 0) data[idx] += hp * env;
  }
}

/** Single-pass one-pole low-pass over the whole mix, for a warmer timbre with negligible cost. */
function applyMasterLowpass(data: Float32Array, sampleRate: number, cutoffHz: number): void {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    prev += a * (data[i] - prev);
    data[i] = prev;
  }
}

/**
 * Renders the synthesized chord track to an AudioBuffer, ready to feed into
 * BackingTrack.loadBuffer(). Requires a browser: the AudioBuffer constructor does not exist in
 * Node. Synchronous (plain array math, no audio graph to render) — kept `async` only so callers
 * that already `await`/`.then()` it do not need to change if this ever needs to yield in future.
 */
export async function renderChordTrack(song: Song, sampleRate = 44100, a4 = 440): Promise<AudioBuffer> {
  const durationSec = Math.max(0.1, chordTrackDurationSec(song));
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
  const data = buffer.getChannelData(0);

  const voices = planChordTrack(song, a4);
  for (const voice of voices) {
    if (voice.kind === 'mute') addMuteHit(data, sampleRate, voice.atSec);
    else addNote(data, sampleRate, voice.freqHz, voice.atSec);
  }
  applyMasterLowpass(data, sampleRate, MASTER_LOWPASS_HZ);
  return buffer;
}
