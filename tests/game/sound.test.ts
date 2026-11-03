import { describe, expect, it } from 'vitest';
import { isSilent, settingsOfSound, soundOf, toggleMaster, toggleTrack } from '../../src/game/sound';

describe('practice sound buttons', () => {
  it('reads the settings as song / chords / metronome', () => {
    expect(soundOf({ backingTrack: true, backingSource: 'audio', metronome: true })).toEqual({ song: true, chords: false, metronome: true });
    expect(soundOf({ backingTrack: true, backingSource: 'chords', metronome: false })).toEqual({ song: false, chords: true, metronome: false });
    expect(soundOf({ backingTrack: false, backingSource: 'audio', metronome: false })).toEqual({ song: false, chords: false, metronome: false });
  });

  it('writes a state back as settings (song and chords share one track)', () => {
    expect(settingsOfSound({ song: false, chords: true, metronome: true })).toEqual({ backingTrack: true, backingSource: 'chords', metronome: true });
    expect(settingsOfSound({ song: true, chords: true, metronome: false })).toEqual({ backingTrack: true, backingSource: 'audio', metronome: false });
    expect(settingsOfSound({ song: false, chords: false, metronome: false }).backingTrack).toBe(false);
  });

  it('song and chords are exclusive; pressing the active one turns the track off', () => {
    const base = { song: true, chords: false, metronome: true };
    expect(toggleTrack(base, 'chords')).toEqual({ song: false, chords: true, metronome: true });
    expect(toggleTrack(base, 'song')).toEqual({ song: false, chords: false, metronome: true });
    expect(toggleTrack({ song: false, chords: false, metronome: false }, 'song')).toEqual({ song: true, chords: false, metronome: false });
  });

  it('the crossed speaker silences everything and brings it back', () => {
    const fallback = { song: true, chords: false, metronome: true };
    const on = { song: false, chords: true, metronome: true };
    const muted = toggleMaster(on, null, fallback);
    expect(isSilent(muted.next)).toBe(true);
    expect(muted.remember).toEqual(on);
    const back = toggleMaster(muted.next, muted.remember, fallback);
    expect(back.next).toEqual(on);
    // nothing remembered (it was already silent when the screen opened): the fallback comes back
    expect(toggleMaster({ song: false, chords: false, metronome: false }, null, fallback).next).toEqual(fallback);
  });
});
