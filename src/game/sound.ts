/**
 * What makes noise during practice, as the small buttons of the practice screen see it: the song (the
 * recording), the synthesized chords and the metronome. The settings keep them as `backingTrack` (on / off),
 * `backingSource` ('audio' | 'chords') and `metronome`; the song and the chords share one track, so they are
 * exclusive. With all three off nothing sounds and the microphone listens without interference.
 */
import type { Settings } from '../types';

export interface SoundState {
  song: boolean;
  chords: boolean;
  metronome: boolean;
}

export type SoundSettings = Pick<Settings, 'backingTrack' | 'backingSource' | 'metronome'>;

export function soundOf(s: SoundSettings): SoundState {
  return { song: s.backingTrack && s.backingSource === 'audio', chords: s.backingTrack && s.backingSource === 'chords', metronome: s.metronome };
}

/** The settings for a sound state. If both the song and the chords are asked for, the song wins (one track). */
export function settingsOfSound(state: SoundState): SoundSettings {
  const source: Settings['backingSource'] = state.song ? 'audio' : state.chords ? 'chords' : 'audio';
  return { backingTrack: state.song || state.chords, backingSource: source, metronome: state.metronome };
}

export function isSilent(state: SoundState): boolean {
  return !state.song && !state.chords && !state.metronome;
}

/**
 * Pressing the song / chords button: selects that source, or turns the track off when it was the active one.
 * (`which` is exclusive with the other because they share one track.)
 */
export function toggleTrack(state: SoundState, which: 'song' | 'chords'): SoundState {
  const active = state[which];
  return { ...state, song: which === 'song' ? !active : false, chords: which === 'chords' ? !active : false };
}

/**
 * The speaker with the cross: if anything sounds, silence everything (and remember what was on); if nothing
 * does, bring back what was on (or `fallback` when nothing was remembered).
 */
export function toggleMaster(state: SoundState, remembered: SoundState | null, fallback: SoundState): { next: SoundState; remember: SoundState | null } {
  if (!isSilent(state)) return { next: { song: false, chords: false, metronome: false }, remember: state };
  const back = remembered && !isSilent(remembered) ? remembered : fallback;
  return { next: back, remember: null };
}
