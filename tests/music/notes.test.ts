import { describe, expect, it } from 'vitest';
import type { ChordQuality, ChordSymbol } from '../../src/types';
import {
  NOTE_NAMES_FLAT,
  NOTE_NAMES_SHARP,
  QUALITY_INTERVALS,
  bassNameOf,
  chordPitchClasses,
  chordSymbolName,
  freqToMidi,
  makeChordSymbol,
  midiToFreq,
  noteName,
  normalizeSymbolText,
  parseChordSymbol,
  pitchClassName,
  pitchClassOf,
  qualityThird,
  rootNameOf,
  swapThirdName,
} from '../../src/music/notes';

describe('note names and pitch classes', () => {
  it('has 12 sharp and 12 flat names', () => {
    expect(NOTE_NAMES_SHARP).toHaveLength(12);
    expect(NOTE_NAMES_FLAT).toHaveLength(12);
    expect(NOTE_NAMES_SHARP[0]).toBe('C');
    expect(NOTE_NAMES_SHARP[6]).toBe('F#');
    expect(NOTE_NAMES_FLAT[10]).toBe('Bb');
    expect(NOTE_NAMES_FLAT[6]).toBe('Gb');
    for (let i = 0; i < 12; i++) {
      expect(pitchClassOf(NOTE_NAMES_SHARP[i])).toBe(i);
      expect(pitchClassOf(NOTE_NAMES_FLAT[i])).toBe(i);
    }
  });

  it('pitchClassOf accepts #, b, ♯, ♭ and enharmonic edge cases', () => {
    expect(pitchClassOf('C')).toBe(0);
    expect(pitchClassOf('F#')).toBe(6);
    expect(pitchClassOf('Bb')).toBe(10);
    expect(pitchClassOf('F♯')).toBe(6);
    expect(pitchClassOf('B♭')).toBe(10);
    expect(pitchClassOf('Cb')).toBe(11);
    expect(pitchClassOf('B#')).toBe(0);
    expect(pitchClassOf('E#')).toBe(5);
    expect(pitchClassOf('Fb')).toBe(4);
    expect(pitchClassOf('C##')).toBe(2);
    expect(pitchClassOf('Dbb')).toBe(0);
    expect(pitchClassOf(' A ')).toBe(9);
    expect(pitchClassOf('a')).toBe(9);
  });

  it('pitchClassOf returns -1 for non-notes', () => {
    expect(pitchClassOf('')).toBe(-1);
    expect(pitchClassOf('H')).toBe(-1);
    expect(pitchClassOf('C#m')).toBe(-1);
    expect(pitchClassOf('#')).toBe(-1);
    expect(pitchClassOf('7')).toBe(-1);
  });

  it('pitchClassName wraps and honours flats', () => {
    expect(pitchClassName(10)).toBe('A#');
    expect(pitchClassName(10, true)).toBe('Bb');
    expect(pitchClassName(12)).toBe('C');
    expect(pitchClassName(-1)).toBe('B');
  });

  it('normalizeSymbolText maps unicode variants', () => {
    expect(normalizeSymbolText('F♯m7♭5')).toBe('F#m7b5');
    expect(normalizeSymbolText('C∆7')).toBe('CΔ7');
    expect(normalizeSymbolText('Cº')).toBe('C°');
    expect(normalizeSymbolText('CØ')).toBe('Cø');
  });
});

describe('midi <-> frequency', () => {
  it('converts A4 and octaves', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(81)).toBeCloseTo(880, 9);
    expect(midiToFreq(57)).toBeCloseTo(220, 9);
    expect(midiToFreq(40)).toBeCloseTo(82.4069, 3);
    expect(midiToFreq(69, 432)).toBe(432);
    expect(midiToFreq(57, 432)).toBeCloseTo(216, 9);
  });

  it('freqToMidi is fractional and inverts midiToFreq', () => {
    expect(freqToMidi(440)).toBeCloseTo(69, 9);
    expect(freqToMidi(880)).toBeCloseTo(81, 9);
    expect(freqToMidi(466.16)).toBeCloseTo(70, 2);
    expect(freqToMidi(440 * Math.pow(2, 1 / 24))).toBeCloseTo(69.5, 9);
    for (const m of [40, 52.3, 64, 69, 88]) expect(freqToMidi(midiToFreq(m))).toBeCloseTo(m, 9);
    for (const m of [40, 69, 88]) expect(freqToMidi(midiToFreq(m, 442), 442)).toBeCloseTo(m, 9);
  });

  it('noteName gives scientific pitch names', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(40)).toBe('E2');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(61, true)).toBe('Db4');
    expect(noteName(59)).toBe('B3');
    expect(noteName(64.4)).toBe('E4');
    expect(noteName(0)).toBe('C-1');
  });
});

describe('parseChordSymbol', () => {
  const sym = (name: string, root: number, quality: ChordQuality, bass: number | null = null): ChordSymbol => ({
    name,
    root,
    quality,
    bass,
  });

  it('parses the symbols from the spec', () => {
    expect(parseChordSymbol('C')).toEqual(sym('C', 0, 'maj'));
    expect(parseChordSymbol('Bb')).toEqual(sym('Bb', 10, 'maj'));
    expect(parseChordSymbol('F#m7')).toEqual(sym('F#m7', 6, 'm7'));
    expect(parseChordSymbol('G/B')).toEqual(sym('G/B', 7, 'maj', 11));
    expect(parseChordSymbol('N.C.')).toEqual(sym('N.C.', -1, 'nc'));
    expect(parseChordSymbol('NC')).toEqual(sym('NC', -1, 'nc'));
    expect(parseChordSymbol('-')).toEqual(sym('-', -1, 'nc'));
    expect(parseChordSymbol('CM7')).toEqual(sym('CM7', 0, 'maj7'));
    expect(parseChordSymbol('C-7')).toEqual(sym('C-7', 0, 'm7'));
    expect(parseChordSymbol('Am')).toEqual(sym('Am', 9, 'min'));
    expect(parseChordSymbol('Dsus4')).toEqual(sym('Dsus4', 2, 'sus4'));
    expect(parseChordSymbol('Cadd9')).toEqual(sym('Cadd9', 0, 'add9'));
  });

  it('accepts every quality alias', () => {
    const cases: Array<[string, ChordQuality]> = [
      ['C', 'maj'], ['Cmaj', 'maj'], ['CM', 'maj'], ['Cmajor', 'maj'],
      ['Cm', 'min'], ['Cmin', 'min'], ['C-', 'min'], ['Cminor', 'min'], ['Cmi', 'min'],
      ['C7', '7'], ['Cdom7', '7'],
      ['Cmaj7', 'maj7'], ['CM7', 'maj7'], ['CΔ7', 'maj7'], ['CΔ', 'maj7'], ['C∆7', 'maj7'], ['CMaj7', 'maj7'],
      ['Cm7', 'm7'], ['Cmin7', 'm7'], ['C-7', 'm7'], ['Cmi7', 'm7'],
      ['Cdim', 'dim'], ['C°', 'dim'], ['Co', 'dim'], ['Cº', 'dim'], ['CDIM', 'dim'],
      ['Cdim7', 'dim7'], ['C°7', 'dim7'], ['Co7', 'dim7'],
      ['Cm7b5', 'm7b5'], ['Cø', 'm7b5'], ['Cø7', 'm7b5'], ['Cm7♭5', 'm7b5'], ['Cmin7b5', 'm7b5'], ['CØ', 'm7b5'], ['C-7b5', 'm7b5'],
      ['Caug', 'aug'], ['C+', 'aug'], ['CAug', 'aug'],
      ['Csus2', 'sus2'], ['CSUS2', 'sus2'],
      ['Csus4', 'sus4'], ['Csus', 'sus4'],
      ['C7sus4', '7sus4'], ['C7sus', '7sus4'],
      ['Cadd9', 'add9'], ['CAdd9', 'add9'],
      ['C6', '6'], ['Cmaj6', '6'], ['CM6', '6'],
      ['Cm6', 'm6'], ['Cmin6', 'm6'], ['C-6', 'm6'],
      ['C9', '9'],
      ['C5', '5'],
    ];
    for (const [text, quality] of cases) {
      const parsed = parseChordSymbol(text);
      expect(parsed, text).not.toBeNull();
      expect(parsed!.quality, text).toBe(quality);
      expect(parsed!.root, text).toBe(0);
      expect(parsed!.bass, text).toBeNull();
      expect(parsed!.name, text).toBe(text);
    }
  });

  it('keeps M (major) and m (minor) case-sensitive', () => {
    expect(parseChordSymbol('CM')!.quality).toBe('maj');
    expect(parseChordSymbol('Cm')!.quality).toBe('min');
    expect(parseChordSymbol('CM7')!.quality).toBe('maj7');
    expect(parseChordSymbol('Cm7')!.quality).toBe('m7');
    expect(parseChordSymbol('CM6')!.quality).toBe('6');
    expect(parseChordSymbol('Cm6')!.quality).toBe('m6');
  });

  it('parses roots with sharps, flats and unicode accidentals', () => {
    expect(parseChordSymbol('F#')!.root).toBe(6);
    expect(parseChordSymbol('Gb')!.root).toBe(6);
    expect(parseChordSymbol('F♯m')).toEqual(sym('F♯m', 6, 'min'));
    expect(parseChordSymbol('B♭7')).toEqual(sym('B♭7', 10, '7'));
    expect(parseChordSymbol('Ebm7b5')).toEqual(sym('Ebm7b5', 3, 'm7b5'));
    expect(parseChordSymbol('Abm7')).toEqual(sym('Abm7', 8, 'm7'));
    expect(parseChordSymbol('Bb5')).toEqual(sym('Bb5', 10, '5'));
    expect(parseChordSymbol('Cb')).toEqual(sym('Cb', 11, 'maj'));
    expect(parseChordSymbol('E#m')).toEqual(sym('E#m', 5, 'min'));
  });

  it('parses slash basses', () => {
    expect(parseChordSymbol('D/F#')).toEqual(sym('D/F#', 2, 'maj', 6));
    expect(parseChordSymbol('D/F♯')).toEqual(sym('D/F♯', 2, 'maj', 6));
    expect(parseChordSymbol('Am/G')).toEqual(sym('Am/G', 9, 'min', 7));
    expect(parseChordSymbol('C/G')).toEqual(sym('C/G', 0, 'maj', 7));
    expect(parseChordSymbol('Am7/Bb')).toEqual(sym('Am7/Bb', 9, 'm7', 10));
    expect(parseChordSymbol('Fmaj7/C')).toEqual(sym('Fmaj7/C', 5, 'maj7', 0));
    // a bass equal to the root is not an alternate bass
    expect(parseChordSymbol('C/C')).toEqual(sym('C/C', 0, 'maj', null));
  });

  it('accepts N.C. spellings case-insensitively and keeps the text', () => {
    for (const t of ['N.C.', 'NC', 'N.C', 'n.c.', 'nc', '-']) {
      const p = parseChordSymbol(t);
      expect(p).toEqual({ name: t, root: -1, quality: 'nc', bass: null });
    }
  });

  it('trims surrounding whitespace but keeps the spelling', () => {
    expect(parseChordSymbol('  F#m7 ')!.name).toBe('F#m7');
    expect(parseChordSymbol('B♭')!.name).toBe('B♭');
  });

  it('returns null for invalid syntax', () => {
    const invalid = [
      '', ' ', 'H', 'Cx', 'C/', 'C/H', 'C maj', 'x2', 'C#m7b', 'Cmaj7/', 'am', 'e', '.', 'C.', '/G',
      'C/E/G', 'C7#9', 'Cm/', 'CmM7', '#', 'b', 'N.C.x', '--', 'C--', 'C2', 'Cb9b', '7', 'Cbbb',
    ];
    for (const t of invalid) expect(parseChordSymbol(t), JSON.stringify(t)).toBeNull();
  });
});

describe('QUALITY_INTERVALS and chordPitchClasses', () => {
  it('matches the spec intervals', () => {
    const expected: Record<ChordQuality, number[]> = {
      maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
      dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8], sus2: [0, 2, 7],
      sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 2], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
      '9': [0, 4, 7, 10, 2], '5': [0, 7], nc: [],
    };
    expect(QUALITY_INTERVALS).toEqual(expected);
  });

  it('returns unique ascending pitch classes including the bass', () => {
    expect(chordPitchClasses(parseChordSymbol('C')!)).toEqual([0, 4, 7]);
    expect(chordPitchClasses(parseChordSymbol('G/B')!)).toEqual([2, 7, 11]);
    expect(chordPitchClasses(parseChordSymbol('Am7')!)).toEqual([0, 4, 7, 9]);
    expect(chordPitchClasses(parseChordSymbol('Cadd9')!)).toEqual([0, 2, 4, 7]);
    expect(chordPitchClasses(parseChordSymbol('C9')!)).toEqual([0, 2, 4, 7, 10]);
    expect(chordPitchClasses(parseChordSymbol('A5')!)).toEqual([4, 9]);
    expect(chordPitchClasses(parseChordSymbol('D/F#')!)).toEqual([2, 6, 9]);
    expect(chordPitchClasses(parseChordSymbol('Cmaj7')!)).toEqual([0, 4, 7, 11]);
    expect(chordPitchClasses(parseChordSymbol('Bdim')!)).toEqual([2, 5, 11]);
    expect(chordPitchClasses(parseChordSymbol('F#m')!)).toEqual([1, 6, 9]);
    // alternate bass that is not a chord tone is added
    expect(chordPitchClasses(parseChordSymbol('C/D')!)).toEqual([0, 2, 4, 7]);
  });

  it('is empty for nc / rests', () => {
    expect(chordPitchClasses(parseChordSymbol('N.C.')!)).toEqual([]);
    expect(chordPitchClasses(parseChordSymbol('-')!)).toEqual([]);
    expect(chordPitchClasses({ name: '-', root: -1, quality: 'nc', bass: null })).toEqual([]);
  });
});

describe('qualityThird', () => {
  it('follows the spec table', () => {
    for (const q of ['maj', '7', 'maj7', 'add9', '6', '9'] as ChordQuality[]) expect(qualityThird(q), q).toBe(4);
    for (const q of ['min', 'm7', 'm6', 'dim', 'dim7', 'm7b5'] as ChordQuality[]) expect(qualityThird(q), q).toBe(3);
    for (const q of ['sus2', 'sus4', '7sus4', '5', 'aug', 'nc'] as ChordQuality[]) expect(qualityThird(q), q).toBeNull();
  });
});

describe('swapThirdName', () => {
  const swap = (t: string): string => swapThirdName(parseChordSymbol(t)!);

  it('swaps natural pairs', () => {
    expect(swap('A')).toBe('Am');
    expect(swap('Am')).toBe('A');
    expect(swap('C7')).toBe('Cm7');
    expect(swap('Am7')).toBe('A7');
    expect(swap('C6')).toBe('Cm6');
    expect(swap('Cm6')).toBe('C6');
    expect(swap('F#m')).toBe('F#');
    expect(swap('F#')).toBe('F#m');
  });

  it('falls back to <root>m / <root> for qualities without a pair', () => {
    expect(swap('Cmaj7')).toBe('Cm');
    expect(swap('Cadd9')).toBe('Cm');
    expect(swap('C9')).toBe('Cm');
    expect(swap('Cdim')).toBe('C');
    expect(swap('Cdim7')).toBe('C');
    expect(swap('Cm7b5')).toBe('C');
    expect(swap('Csus4')).toBe('C');
    expect(swap('Caug')).toBe('C');
    expect(swap('C5')).toBe('C');
  });

  it('keeps the user spelling of root and bass', () => {
    expect(swap('Bb')).toBe('Bbm');
    expect(swap('Gbm')).toBe('Gb');
    expect(swap('B♭7')).toBe('Bbm7');
    expect(swap('Am/G')).toBe('A/G');
    expect(swap('D/F#')).toBe('Dm/F#');
    expect(swap('CM7')).toBe('Cm');
  });

  it('uses sharps when the name does not spell the root', () => {
    expect(swapThirdName({ name: 'weird', root: 10, quality: 'maj', bass: null })).toBe('A#m');
    expect(swapThirdName({ name: 'x', root: 6, quality: 'min', bass: 11 })).toBe('F#/B');
  });

  it('leaves nc alone', () => {
    expect(swap('N.C.')).toBe('N.C.');
    expect(swap('-')).toBe('-');
  });
});

describe('name helpers', () => {
  it('rootNameOf / bassNameOf keep spelling and fall back to sharps', () => {
    expect(rootNameOf(parseChordSymbol('Bbm7')!)).toBe('Bb');
    expect(rootNameOf(parseChordSymbol('A#m7')!)).toBe('A#');
    expect(rootNameOf(parseChordSymbol('F♯')!)).toBe('F#');
    expect(rootNameOf({ name: '?', root: 3, quality: 'maj', bass: null })).toBe('D#');
    expect(rootNameOf(parseChordSymbol('N.C.')!)).toBe('');
    expect(bassNameOf(parseChordSymbol('C/G')!)).toBe('G');
    expect(bassNameOf(parseChordSymbol('D/F♯')!)).toBe('F#');
    expect(bassNameOf(parseChordSymbol('C')!)).toBeNull();
    expect(bassNameOf({ name: '?', root: 0, quality: 'maj', bass: 10 })).toBe('A#');
  });

  it('chordSymbolName / makeChordSymbol build canonical names', () => {
    expect(chordSymbolName(6, 'min')).toBe('F#m');
    expect(chordSymbolName(6, 'min', null, true)).toBe('Gbm');
    expect(chordSymbolName(7, 'maj', 11)).toBe('G/B');
    expect(chordSymbolName(0, 'maj7')).toBe('Cmaj7');
    expect(chordSymbolName(0, '5')).toBe('C5');
    expect(chordSymbolName(-1, 'nc')).toBe('N.C.');
    expect(makeChordSymbol(6, 'min')).toEqual({ name: 'F#m', root: 6, quality: 'min', bass: null });
    expect(makeChordSymbol(7, 'maj', 11)).toEqual({ name: 'G/B', root: 7, quality: 'maj', bass: 11 });
    expect(makeChordSymbol(0, 'maj', 12)).toEqual({ name: 'C', root: 0, quality: 'maj', bass: null });
    expect(makeChordSymbol(0, 'nc')).toEqual({ name: 'N.C.', root: -1, quality: 'nc', bass: null });
    // round trip with the parser
    for (let root = 0; root < 12; root++) {
      for (const q of Object.keys(QUALITY_INTERVALS) as ChordQuality[]) {
        if (q === 'nc') continue;
        const made = makeChordSymbol(root, q);
        expect(parseChordSymbol(made.name)).toEqual(made);
      }
    }
  });
});
