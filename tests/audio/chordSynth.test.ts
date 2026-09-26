import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { songDurationSec } from '../../src/song/tempo';
import { getChordShape, shapeMidiNotes } from '../../src/music/chords';
import { midiToFreq } from '../../src/music/notes';
import { CHORD_SYNTH_STRING_STAGGER_SEC, CHORD_SYNTH_TAIL_SEC, chordTrackDurationSec, planChordTrack } from '../../src/audio/chordSynth';

const src = (...lines: string[]): string => lines.join('\n');

/** The C shape's sounding strings (x32010), low to high: A3, D2, G0, B1, e0 -> midi 48,52,55,60,64. */
const C_NOTES = shapeMidiNotes(getChordShape('C')!);

describe('planChordTrack', () => {
  it('a down-strum plays every sounding string low-to-high, staggered', () => {
    const { song } = parseSong(src('tempo: 120', 'strum: DUDU', 'C . . . |'));
    const notes = planChordTrack(song).filter((v) => v.kind === 'note' && v.atSec < 0.25);
    expect(notes).toHaveLength(C_NOTES.length);
    notes.forEach((v, i) => {
      expect(v.atSec).toBeCloseTo(i * CHORD_SYNTH_STRING_STAGGER_SEC, 9);
      expect(v.kind === 'note' && v.freqHz).toBeCloseTo(midiToFreq(C_NOTES[i]), 6);
    });
  });

  it('an up-strum plays the same strings high-to-low in time, without reordering the frequencies', () => {
    // beat 1 at 120 bpm = 0.5 s; strum DUDU -> event 1 (beat 1) is the up-strum.
    const { song } = parseSong(src('tempo: 120', 'strum: DUDU', 'C . . . |'));
    const notes = planChordTrack(song).filter((v) => v.kind === 'note' && v.atSec >= 0.5 && v.atSec < 0.75);
    expect(notes).toHaveLength(C_NOTES.length);
    const n = C_NOTES.length;
    notes.forEach((v, i) => {
      // i-th planned note (low string i) sounds LAST for an upstroke: stagger (n-1-i).
      expect(v.atSec).toBeCloseTo(0.5 + (n - 1 - i) * CHORD_SYNTH_STRING_STAGGER_SEC, 9);
      expect(v.kind === 'note' && v.freqHz).toBeCloseTo(midiToFreq(C_NOTES[i]), 6);
    });
    // Sorted by time, the highest string sounds first and the lowest sounds last.
    const byTime = [...notes].sort((a, b) => a.atSec - b.atSec);
    expect(byTime[0]).toBe(notes[n - 1]);
    expect(byTime[n - 1]).toBe(notes[0]);
  });

  it('a muted strum becomes one percussive hit and no notes', () => {
    const { song } = parseSong(src('tempo: 100', 'strum: DxUx', 'C . . . |'));
    const voices = planChordTrack(song);
    const mutes = voices.filter((v) => v.kind === 'mute');
    expect(mutes).toHaveLength(2); // the two 'x' events in DxUx
    // The muted events (index 1 and 3 of the bar) carry no notes.
    const noteCount = voices.filter((v) => v.kind === 'note').length;
    expect(noteCount).toBe(2 * C_NOTES.length); // only the 2 real strums (D and U) produce notes
  });

  it('a rest (N.C.) is silent: no notes, no mute hit', () => {
    const { song } = parseSong(src('tempo: 100', 'strum: D---', 'N.C. . . . | C . . . |'));
    const voices = planChordTrack(song);
    expect(voices.filter((v) => v.kind === 'mute')).toHaveLength(0);
    expect(voices.filter((v) => v.kind === 'note')).toHaveLength(C_NOTES.length);
  });

  it('honours a custom A4 reference', () => {
    const { song } = parseSong(src('tempo: 120', 'strum: D---', 'C . . . |'));
    const at432 = planChordTrack(song, 432).filter((v) => v.kind === 'note');
    const at440 = planChordTrack(song, 440).filter((v) => v.kind === 'note');
    expect(at432[0].kind === 'note' && at432[0].freqHz).toBeLessThan(at440[0].kind === 'note' ? at440[0].freqHz : 0);
  });
});

describe('chordTrackDurationSec', () => {
  it('is the song duration plus the tail', () => {
    const { song } = parseSong(src('tempo: 120', 'C . . . | G . . . |'));
    expect(chordTrackDurationSec(song)).toBeCloseTo(songDurationSec(song) + CHORD_SYNTH_TAIL_SEC, 9);
  });
});
