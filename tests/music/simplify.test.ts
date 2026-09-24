import { describe, expect, it } from 'vitest';
import type { ChordSymbol } from '../../src/types';
import { parseChordSymbol } from '../../src/music/notes';
import { parseSong } from '../../src/song/parser';
import {
  DEFAULT_MAX_CAPO,
  DEFAULT_SIMPLIFY_OPTIONS,
  EASY_CHORDS,
  EASY_CHORDS_LEVEL1,
  EASY_CHORDS_LEVEL2,
  bestCapo,
  chordDifficulty,
  estimateKeyFromChords,
  keepTopChords,
  nearestEasyChord,
  reduceQuality,
  rewriteChordTokens,
  simplifyChart,
  transposeName,
  type SimplifyOptions,
  type WeightedChord,
} from '../../src/music/simplify';

function sym(name: string): ChordSymbol {
  const s = parseChordSymbol(name);
  if (!s) throw new Error(`invalid chord in test: ${name}`);
  return s;
}

function weighted(names: string[], beats = 1): WeightedChord[] {
  return names.map((name) => ({ name, beats }));
}

const C_MAJOR = { root: 0, mode: 'major' as const };
const G_MAJOR = { root: 7, mode: 'major' as const };

/** Every option off: the text must come back untouched. */
const NO_OPTS: SimplifyOptions = {
  removeExtensions: false,
  substituteHard: false,
  maxChords: null,
  suggestCapo: false,
  allowSevenths: false,
};

const hardErrors = (source: string) => parseSong(source).errors.filter((e) => e.severity === 'error');

// ---------------------------------------------------------------- EASY_CHORDS

describe('EASY_CHORDS', () => {
  it('lists level 1 first, then level 2, all valid chords', () => {
    expect(EASY_CHORDS).toEqual([...EASY_CHORDS_LEVEL1, ...EASY_CHORDS_LEVEL2]);
    expect(EASY_CHORDS_LEVEL1).toEqual(['C', 'D', 'E', 'G', 'A', 'Am', 'Em', 'Dm']);
    expect(EASY_CHORDS_LEVEL2).toContain('B7');
    expect(EASY_CHORDS_LEVEL2).toContain('Cadd9');
    for (const name of EASY_CHORDS) expect(parseChordSymbol(name), name).not.toBeNull();
    expect(new Set(EASY_CHORDS).size).toBe(EASY_CHORDS.length);
  });

  it('every easy chord has a level <= 2', () => {
    for (const name of EASY_CHORDS_LEVEL1) expect(chordDifficulty(name).level, name).toBe(1);
    for (const name of EASY_CHORDS_LEVEL2) expect(chordDifficulty(name).level, name).toBe(2);
  });
});

// ---------------------------------------------------------------- chordDifficulty

describe('chordDifficulty', () => {
  it('rates the spec examples', () => {
    expect(chordDifficulty('C')).toEqual({ level: 1, label: 'fácil', reason: expect.any(String) });
    expect(chordDifficulty('F').level).toBe(3);
    expect(chordDifficulty('F').label).toBe('difícil');
    expect(chordDifficulty('F').reason).toContain('cejilla');
    expect(chordDifficulty('Bm').level).toBe(3);
    expect(chordDifficulty('G7')).toMatchObject({ level: 2, label: 'medio' });
    expect(chordDifficulty('G7').reason).toContain('séptima');
    expect(chordDifficulty('F#m').level).toBe(3);
    expect(chordDifficulty('Bbm7').level).toBe(3);
    expect(chordDifficulty('Bbm7').reason).toContain('cejilla');
  });

  it('accepts parsed symbols and ignores the slash bass', () => {
    expect(chordDifficulty(sym('Am')).level).toBe(1);
    expect(chordDifficulty('G/B').level).toBe(1);
    expect(chordDifficulty('D/F#').level).toBe(1);
    expect(chordDifficulty('F/A').level).toBe(3);
  });

  it('is enharmonic and alias insensitive', () => {
    expect(chordDifficulty('CM7').level).toBe(2); // Cmaj7
    expect(chordDifficulty('A#').level).toBe(3); // Bb barre
    expect(chordDifficulty('Emin').level).toBe(1);
  });

  it('gives level 2 to barre-free library shapes with at most 4 fretted strings', () => {
    expect(chordDifficulty('Amaj7').level).toBe(2);
    expect(chordDifficulty('Gadd9').level).toBe(2);
    expect(chordDifficulty('A5').level).toBe(2);
  });

  it('gives level 3 to barre, generated and unknown shapes', () => {
    expect(chordDifficulty('Bb').reason).toBe('cejilla');
    expect(chordDifficulty('C#').reason).toContain('generada');
    expect(chordDifficulty('Cdim').reason).toContain('sin digitación');
    expect(chordDifficulty('Cdim').level).toBe(3);
  });

  it('handles N.C. and invalid symbols', () => {
    expect(chordDifficulty('N.C.').level).toBe(1);
    expect(chordDifficulty('xyz').level).toBe(3);
  });
});

// ---------------------------------------------------------------- transposeName

describe('transposeName', () => {
  it('matches the spec examples', () => {
    expect(transposeName('Bb', -1)).toBe('A');
    expect(transposeName('F#m', 2)).toBe('G#m');
  });

  it('spells with sharps except Eb/Ab/Bb, which use the flat unless the library spells them sharp', () => {
    expect(transposeName('C', 3)).toBe('Eb');
    expect(transposeName('C', 1)).toBe('C#');
    expect(transposeName('C', 6)).toBe('F#');
    expect(transposeName('C', 8)).toBe('Ab');
    expect(transposeName('C', 10)).toBe('Bb');
    expect(transposeName('Am', -1)).toBe('G#m'); // G#m is in the library
    expect(transposeName('Bm', -1)).toBe('Bbm'); // no A#m in the library
  });

  it('keeps the textual quality and transposes the bass', () => {
    expect(transposeName('Cmaj7', -2)).toBe('Bbmaj7');
    expect(transposeName('CM7', 1)).toBe('C#M7');
    expect(transposeName('G/B', 1)).toBe('Ab/C');
    expect(transposeName('D/F#', -2)).toBe('C/E');
    expect(transposeName('C/E', 3)).toBe('Eb/G');
    expect(transposeName('Am7/G', 2)).toBe('Bm7/A');
  });

  it('wraps around the octave and leaves non-chords alone', () => {
    expect(transposeName('A', 12)).toBe('A');
    expect(transposeName('D', -7)).toBe('G');
    expect(transposeName('N.C.', 2)).toBe('N.C.');
    expect(transposeName('-', 1)).toBe('-');
    expect(transposeName('hello', 1)).toBe('hello');
  });
});

// ---------------------------------------------------------------- reduceQuality

describe('reduceQuality', () => {
  it('reduces the spec examples', () => {
    expect(reduceQuality(sym('Cmaj7'))).toEqual({ name: 'C', root: 0, quality: 'maj', bass: null });
    expect(reduceQuality(sym('Am7'))).toEqual({ name: 'Am', root: 9, quality: 'min', bass: null });
    expect(reduceQuality(sym('G/B'))).toEqual({ name: 'G', root: 7, quality: 'maj', bass: null });
  });

  it('maps every extended quality to maj or min', () => {
    for (const q of ['Cmaj7', 'C7', 'Cadd9', 'C6', 'C9', 'Csus2', 'Csus4', 'C7sus4', 'Caug', 'C5']) {
      expect(reduceQuality(sym(q)), q).toMatchObject({ name: 'C', quality: 'maj' });
    }
    for (const q of ['Cm7', 'Cm6', 'Cdim', 'Cdim7', 'Cm7b5']) {
      expect(reduceQuality(sym(q)), q).toMatchObject({ name: 'Cm', quality: 'min' });
    }
  });

  it('keeps the root spelling and leaves N.C. alone', () => {
    expect(reduceQuality(sym('Bb7')).name).toBe('Bb');
    expect(reduceQuality(sym('F#m7/A')).name).toBe('F#m');
    expect(reduceQuality(sym('N.C.'))).toEqual(sym('N.C.'));
    expect(reduceQuality(sym('-'))).toEqual({ name: '-', root: -1, quality: 'nc', bass: null });
  });
});

// ---------------------------------------------------------------- nearestEasyChord

describe('nearestEasyChord', () => {
  it('F -> Fmaj7 with sevenths, Dm/Am (never C) without, in C major', () => {
    const withSevenths = nearestEasyChord('F', { key: C_MAJOR, allowSevenths: true });
    expect(withSevenths?.name).toBe('Fmaj7');
    expect(withSevenths?.shared).toBe(3);
    const noSevenths = nearestEasyChord('F', { key: C_MAJOR, allowSevenths: false });
    expect(['Dm', 'Am']).toContain(noSevenths?.name);
    expect(noSevenths?.name).not.toBe('C');
    expect(noSevenths?.shared).toBe(2);
  });

  it('Bm in G major -> D or G', () => {
    const r = nearestEasyChord('Bm', { key: G_MAJOR, allowSevenths: false });
    expect(['D', 'G']).toContain(r?.name);
  });

  it('B7 stays B7 when sevenths are allowed', () => {
    expect(nearestEasyChord('B7', { key: null, allowSevenths: true })?.name).toBe('B7');
    expect(nearestEasyChord(sym('B7'), { key: G_MAJOR, allowSevenths: true })?.name).toBe('B7');
  });

  it('returns the chord itself (lower level wins ties) when it is already easy', () => {
    expect(nearestEasyChord('C', { key: C_MAJOR, allowSevenths: true })?.name).toBe('C');
    expect(nearestEasyChord('Am', { key: null, allowSevenths: true })?.name).toBe('Am');
  });

  it('requires at least two shared notes by default', () => {
    expect(nearestEasyChord('C#', { key: null, allowSevenths: false })).toBeNull();
    const relaxed = nearestEasyChord('C#', { key: null, allowSevenths: false, minShared: 1 });
    expect(relaxed?.name).toBe('A'); // C# is the root of C#: weight 1.5
    expect(relaxed?.shared).toBe(1);
  });

  it('uses explicit candidates in the given order for ties', () => {
    const r = nearestEasyChord('F', { key: null, allowSevenths: false, candidates: ['G', 'Dm', 'Am'] });
    expect(r?.name).toBe('Dm');
    expect(nearestEasyChord('F', { key: null, allowSevenths: false, candidates: ['C'] })).toBeNull();
    expect(nearestEasyChord('F', { key: null, allowSevenths: false, candidates: ['C'], minShared: 1 })?.name).toBe('C');
  });

  it('rewards diatonic candidates and penalises a change of third', () => {
    const scoreIn = nearestEasyChord('F', { key: C_MAJOR, allowSevenths: false, candidates: ['Dm'] })?.score ?? 0;
    const scoreOut = nearestEasyChord('F', { key: null, allowSevenths: false, candidates: ['Dm'] })?.score ?? 0;
    expect(scoreIn - scoreOut).toBeCloseTo(0.5, 6);
    // F (F A C) vs Dm: F root 1.5 + A third 1.0 - 0.3 third change = 2.2
    expect(scoreOut).toBeCloseTo(2.2, 6);
  });

  it('returns null for N.C. and invalid names', () => {
    expect(nearestEasyChord('N.C.', { key: null, allowSevenths: true })).toBeNull();
    expect(nearestEasyChord('??', { key: null, allowSevenths: true })).toBeNull();
  });
});

// ---------------------------------------------------------------- estimateKeyFromChords

describe('estimateKeyFromChords', () => {
  it('finds the major key of a pop progression', () => {
    expect(estimateKeyFromChords(weighted(['C', 'G', 'Am', 'F']))).toMatchObject({ root: 0, mode: 'major', name: 'Do mayor' });
    expect(estimateKeyFromChords(weighted(['G', 'D', 'Em', 'C']))).toMatchObject({ root: 7, mode: 'major' });
  });

  it('prefers the minor key when the tonic minor chord dominates', () => {
    expect(estimateKeyFromChords([{ name: 'Am', beats: 8 }, { name: 'Dm', beats: 4 }, { name: 'E7', beats: 4 }])).toMatchObject({
      root: 9,
      mode: 'minor',
      name: 'La menor',
    });
  });

  it('uses the first chord to break ties and ignores N.C.', () => {
    expect(estimateKeyFromChords(weighted(['Em', 'C', 'G', 'D']))).toMatchObject({ root: 4, mode: 'minor' });
    expect(estimateKeyFromChords(weighted(['N.C.', 'Eb', 'Bb', 'Cm', 'Ab']))).toMatchObject({ root: 3, mode: 'major', name: 'Mib mayor' });
  });

  it('returns null without chords', () => {
    expect(estimateKeyFromChords([])).toBeNull();
    expect(estimateKeyFromChords(weighted(['N.C.', '-']))).toBeNull();
    expect(estimateKeyFromChords([{ name: 'C', beats: 0 }])).toBeNull();
  });
});

// ---------------------------------------------------------------- bestCapo

describe('bestCapo', () => {
  /** Σ beats × level of the chords transposed for a capo (the spec's cost). */
  function cost(chords: WeightedChord[], capo: number, fromCapo = 0): number {
    return chords.reduce((sum, c) => sum + c.beats * chordDifficulty(transposeName(c.name, fromCapo - capo)).level, 0);
  }

  it('Eb Ab Bb Cm -> capo 1 (D G A Bm) or 3 (C F G Am), minimising the sum', () => {
    const chords = weighted(['Eb', 'Ab', 'Bb', 'Cm']);
    const r = bestCapo(chords);
    expect([1, 3]).toContain(r.capo);
    const best = Math.min(...Array.from({ length: DEFAULT_MAX_CAPO + 1 }, (_, capo) => cost(chords, capo)));
    expect(r.difficulty).toBe(best);
    expect(r.difficulty).toBe(cost(chords, r.capo));
    // ties go to the lowest capo
    expect(r.capo).toBe(1);
    expect(r.names).toEqual(['D', 'G', 'A', 'Bm']);
  });

  it('keeps capo 0 when nothing improves', () => {
    const r = bestCapo(weighted(['C', 'G', 'Am', 'Em']));
    expect(r.capo).toBe(0);
    expect(r.difficulty).toBe(4);
    expect(r.names).toEqual(['C', 'G', 'Am', 'Em']);
  });

  it('weights by beats and only proposes a capo that improves the sum by at least 15 %', () => {
    // capo 5 turns C F into G C (13 -> 2 per beat pair) but F is rare here: 23 -> 21 is < 15 %
    expect(bestCapo([{ name: 'C', beats: 20 }, { name: 'F', beats: 1 }]).capo).toBe(0);
    // with more F the capo pays off: capo 3 (A D) and capo 5 (G C) tie at 8, the lowest wins
    const r = bestCapo([{ name: 'C', beats: 4 }, { name: 'F', beats: 4 }]);
    expect(r.capo).toBe(3);
    expect(r.names).toEqual(['A', 'D']);
    expect(r.difficulty).toBe(8);
  });

  it('respects maxCapo and ignores N.C.', () => {
    const chords = weighted(['Eb', 'Ab', 'Bb', 'Cm', 'N.C.']);
    expect(bestCapo(chords, 0).capo).toBe(0);
    const r = bestCapo(chords, 7);
    expect(r.capo).toBe(1);
    expect(r.names[4]).toBe('N.C.');
    expect(r.difficulty).toBe(6);
  });

  it('starts from the current capo (the result is the total capo)', () => {
    // written for capo 5: Bb Eb F Gm sound as Eb Ab Bb Cm; capo 1 gives D G A Bm
    const chords = weighted(['Bb', 'Eb', 'F', 'Gm']);
    const r = bestCapo(chords, 7, 5);
    expect(r.capo).toBe(1);
    expect(r.names).toEqual(['D', 'G', 'A', 'Bm']);
    expect(r.difficulty).toBe(cost(chords, 1, 5));
    // a current capo above maxCapo is kept when nothing beats it
    expect(bestCapo(weighted(['C', 'G']), 7, 9).capo).toBe(9);
  });

  it('handles an empty list', () => {
    expect(bestCapo([])).toEqual({ capo: 0, difficulty: 0, names: [] });
  });
});

// ---------------------------------------------------------------- keepTopChords

describe('keepTopChords', () => {
  it('keeps the 4 most frequent of 5 and maps the other one to a kept chord', () => {
    const chords: WeightedChord[] = [
      { name: 'C', beats: 8 },
      { name: 'G', beats: 6 },
      { name: 'Am', beats: 5 },
      { name: 'F', beats: 4 },
      { name: 'Dm', beats: 1 },
    ];
    const map = keepTopChords(chords, 4, C_MAJOR);
    expect(map.size).toBe(5);
    for (const name of ['C', 'G', 'Am', 'F']) expect(map.get(name)).toBe(name);
    expect(['C', 'G', 'Am', 'F']).toContain(map.get('Dm'));
    expect(map.get('Dm')).not.toBe('Dm');
    // Dm shares no note with C; F (F A) and G (D) do
    expect(['F', 'G', 'Am']).toContain(map.get('Dm'));
  });

  it('breaks beat ties by first appearance and falls back to the most frequent chord', () => {
    const chords: WeightedChord[] = [
      { name: 'E', beats: 4 },
      { name: 'G', beats: 8 },
      { name: 'Am', beats: 4 },
      { name: 'C', beats: 4 },
      { name: 'F#', beats: 2 }, // F# A# C#: shares nothing with the kept set
    ];
    const map = keepTopChords(chords, 3, null);
    expect(map.get('G')).toBe('G');
    expect(map.get('E')).toBe('E');
    expect(map.get('Am')).toBe('Am');
    expect(map.get('C')).not.toBe('C');
    expect(map.get('F#')).toBe('G');
  });

  it('aggregates repeated names and returns the identity when n is not limiting', () => {
    const map = keepTopChords([{ name: 'C', beats: 1 }, { name: 'G', beats: 3 }, { name: 'C', beats: 3 }], 1, null);
    expect(map.get('C')).toBe('C');
    expect(map.get('G')).toBe('C');
    const all = keepTopChords(weighted(['C', 'G', 'Am']), 4, null);
    expect([...all.entries()]).toEqual([['C', 'C'], ['G', 'G'], ['Am', 'Am']]);
    expect(keepTopChords(weighted(['C', 'G']), 0, null).get('G')).toBe('G');
    expect(keepTopChords([], 4, null).size).toBe(0);
  });
});

// ---------------------------------------------------------------- simplifyChart

const SONG = `title: Prueba
artist: Tests
tempo: 100
time: 4/4
strum: D-DUDUDU

[Intro]
C . . . | G/B . . . | Am7*2 F*2 | F . . . |   # intro con G/B y Am7

[Estrofa]
C G | Am F | x2
> Letra con F#m y Bm7 que no debe cambiar
Bm . . . | N.C. . . . | - - G . | Em7 . . . |

[Estribillo]
F . . . | G . . . | C . . . | Bbm7 . . . | x2
# comentario con Bbm7 y F

[Estrofa]

[Estribillo] x2
`;

describe('simplifyChart', () => {
  it('with every option off the text is returned untouched', () => {
    const r = simplifyChart(SONG, NO_OPTS);
    expect(r.source).toBe(SONG);
    expect(r.capo).toBe(0);
    expect(r.substitutions).toEqual([]);
    expect(r.chordsAfter).toEqual(r.chordsBefore);
    expect(r.unchangedBeatsRatio).toBe(1);
  });

  it('reports the chords before as the parser sees them', () => {
    const r = simplifyChart(SONG, NO_OPTS);
    expect(r.chordsBefore).toEqual(parseSong(SONG).song.chordNames);
    expect(r.chordsBefore).toEqual(['C', 'G/B', 'Am7', 'F', 'G', 'Am', 'Bm', 'Em7', 'Bbm7']);
  });

  it('keeps the structure: same bars and events, no errors, at most maxChords chords', () => {
    const before = parseSong(SONG);
    const r = simplifyChart(SONG, { ...DEFAULT_SIMPLIFY_OPTIONS, suggestCapo: false });
    const after = parseSong(r.source);
    expect(hardErrors(r.source)).toEqual([]);
    expect(after.song.bars.length).toBe(before.song.bars.length);
    expect(after.song.events.length).toBe(before.song.events.length);
    expect(after.song.totalBeats).toBe(before.song.totalBeats);
    expect(after.song.lyricLines).toEqual(before.song.lyricLines);
    expect(r.chordsAfter.length).toBeLessThanOrEqual(4);
    expect(after.song.chordNames.sort()).toEqual(r.chordsAfter.slice().sort());
    expect(r.capo).toBe(0);
  });

  it('preserves headers, sections, comments, lyrics, x<n>, N.C., rests and *n', () => {
    const r = simplifyChart(SONG, { ...DEFAULT_SIMPLIFY_OPTIONS, suggestCapo: false });
    expect(r.source).toContain('title: Prueba\n');
    expect(r.source).toContain('strum: D-DUDUDU\n');
    expect(r.source).toContain('[Intro]\n');
    expect(r.source).toContain('[Estribillo] x2\n');
    expect(r.source).toContain('\n[Estrofa]\n\n');
    expect(r.source).toContain('| x2\n');
    expect(r.source).toContain('# intro con G/B y Am7');
    expect(r.source).toContain('# comentario con Bbm7 y F\n');
    expect(r.source).toContain('> Letra con F#m y Bm7 que no debe cambiar\n');
    expect(r.source).toContain('N.C. . . . | - - G . |');
    expect(r.source).toMatch(/\| [A-G][#b]?m?\*2 [A-G][#b]?m?\*2 \|/);
    expect(r.source.split('\n').length).toBe(SONG.split('\n').length);
  });

  it('removes extensions and slash basses, keeping *n durations', () => {
    const r = simplifyChart(SONG, { ...NO_OPTS, removeExtensions: true });
    expect(r.source).toContain('C . . . | G . . . | Am*2 F*2 | F . . . |   # intro con G/B y Am7');
    expect(r.source).toContain('| Em . . . |');
    expect(r.source).toContain('| Bbm . . . | x2');
    expect(r.source).not.toContain('G/B .');
    expect(r.substitutions.map((s) => `${s.from}>${s.to}`)).toEqual(['G/B>G', 'Am7>Am', 'Em7>Em', 'Bbm7>Bbm']);
    const gb = r.substitutions.find((s) => s.from === 'G/B');
    expect(gb?.reason).toContain('bajo');
    expect(gb?.beats).toBe(4);
    const am7 = r.substitutions.find((s) => s.from === 'Am7');
    expect(am7?.reason).toContain('séptima');
    expect(am7?.beats).toBe(2);
    expect(hardErrors(r.source)).toEqual([]);
  });

  it('drops the slash bass only when the chord changes', () => {
    const src = 'tempo: 100\nC . . . | G/B . . . | F/A . . . | G . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, substituteHard: true });
    expect(r.source).toContain('G/B . . .');
    expect(r.source).not.toContain('F/A');
    expect(r.source).toContain('| Dm . . . |');
    expect(r.substitutions).toHaveLength(1);
    expect(r.substitutions[0]).toMatchObject({ from: 'F/A', to: 'Dm', beats: 4 });
    expect(r.substitutions[0].reason).toContain('cejilla');
    expect(r.unchangedBeatsRatio).toBe(0.75);
  });

  it('substitutes hard chords by the nearest easy chord in the estimated key', () => {
    const src = 'tempo: 100\nC . . . | F . . . | G . . . | Bm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, substituteHard: true });
    expect(r.chordsAfter).toEqual(['C', 'Dm', 'G']);
    expect(r.source).toBe('tempo: 100\nC . . . | Dm . . . | G . . . | G . . . |\n');
    expect(r.unchangedBeatsRatio).toBe(0.5);
    for (const name of r.chordsAfter) expect(chordDifficulty(name).level).toBeLessThanOrEqual(2);
    const withSevenths = simplifyChart(src, { ...NO_OPTS, substituteHard: true, allowSevenths: true });
    expect(withSevenths.source).toContain('| Fmaj7 . . . |');
  });

  it('keeps hard chords that share fewer than two notes with every easy chord', () => {
    const src = 'tempo: 100\nC . . . | Fm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, substituteHard: true });
    expect(r.source).toBe(src);
    expect(r.substitutions).toEqual([]);
  });

  it('limits the number of chords, mapping the rest to the kept ones', () => {
    const src = 'tempo: 100\nC . . . | G . . . | Am . . . | Em . . . | C . . . | G . . . | Dm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, maxChords: 3 });
    expect(r.chordsAfter).toHaveLength(3);
    expect(r.chordsAfter).toEqual(['C', 'G', 'Am']);
    expect(hardErrors(r.source)).toEqual([]);
    expect(r.substitutions.map((s) => s.from).sort()).toEqual(['Dm', 'Em']);
    for (const s of r.substitutions) {
      expect(['C', 'G', 'Am']).toContain(s.to);
      expect(s.reason).toContain('3 acordes');
    }
    expect(r.unchangedBeatsRatio).toBeCloseTo(5 / 7, 9);
    // a generous limit changes nothing
    expect(simplifyChart(src, { ...NO_OPTS, maxChords: 10 }).source).toBe(src);
  });

  it('proposes a capo, adds the header after the last header line and transposes every chord', () => {
    const src = 'title: Capo\ntempo: 100\n\n[A]\nEb . . . | Ab . . . | Bb . . . | Cm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, suggestCapo: true });
    expect(r.capo).toBe(1);
    expect(r.source).toBe('title: Capo\ntempo: 100\ncapo: 1\n\n[A]\nD . . . | G . . . | A . . . | Bm . . . |\n');
    const parsed = parseSong(r.source);
    expect(hardErrors(r.source)).toEqual([]);
    expect(parsed.song.capo).toBe(1);
    expect(parsed.song.chordNames).toEqual(['D', 'G', 'A', 'Bm']);
    // a transposition alone is not a harmonic change
    expect(r.unchangedBeatsRatio).toBe(1);
    expect(r.substitutions).toHaveLength(4);
    expect(r.substitutions[0]).toMatchObject({ from: 'Eb', to: 'D', beats: 4 });
    expect(r.substitutions[0].reason).toContain('cejilla en el traste 1');
    expect(r.chordsAfter).toEqual(['D', 'G', 'A', 'Bm']);
  });

  it('adds the capo header at the top when the text has no headers', () => {
    const src = 'Eb . . . | Ab . . . | Bb . . . | Cm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, suggestCapo: true });
    expect(r.source).toBe('capo: 1\nD . . . | G . . . | A . . . | Bm . . . |\n');
    expect(parseSong(r.source).song.capo).toBe(1);
  });

  it('updates an existing capo header with the total capo (keeping its comment)', () => {
    // written for capo 2 (they sound as F Bb C Dm): capo 3 gives D G A Bm
    const src = 'tempo: 100\ncapo: 2   # ya tenía cejilla\nEb . . . | Ab . . . | Bb . . . | Cm . . . |\n';
    const r = simplifyChart(src, { ...NO_OPTS, suggestCapo: true });
    expect(r.capo).toBe(3);
    expect(r.source).toBe('tempo: 100\ncapo: 3   # ya tenía cejilla\nD . . . | G . . . | A . . . | Bm . . . |\n');
    expect(r.source.match(/^capo:/gm)).toHaveLength(1);
    expect(parseSong(r.source).song.capo).toBe(3);
  });

  it('can lower an existing capo (transposing up) and never proposes a capo that barely helps', () => {
    const lowered = simplifyChart('capo: 5\nBb . . . | Eb . . . | F . . . | Gm . . . |\n', { ...NO_OPTS, suggestCapo: true });
    expect(lowered.capo).toBe(1);
    expect(lowered.source).toBe('capo: 1\nD . . . | G . . . | A . . . | Bm . . . |\n');
    const kept = simplifyChart('C . . . | G . . . | Am . . . | Em . . . |\n', { ...NO_OPTS, suggestCapo: true });
    expect(kept.capo).toBe(0);
    expect(kept.source).not.toContain('capo:');
  });

  it('runs the full pipeline with the defaults on the example song', () => {
    const before = parseSong(SONG);
    const r = simplifyChart(SONG);
    const after = parseSong(r.source);
    expect(hardErrors(r.source)).toEqual([]);
    expect(after.song.bars.length).toBe(before.song.bars.length);
    expect(after.song.events.length).toBe(before.song.events.length);
    expect(r.chordsAfter.length).toBeLessThanOrEqual(4);
    expect(after.song.capo).toBe(r.capo);
    expect(r.unchangedBeatsRatio).toBeGreaterThan(0);
    expect(r.unchangedBeatsRatio).toBeLessThanOrEqual(1);
    for (const s of r.substitutions) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(s.beats).toBeGreaterThan(0);
      expect(r.chordsBefore).toContain(s.from);
      expect(r.chordsAfter).toContain(s.to);
    }
    // the untouched lines are still there
    expect(r.source).toContain('> Letra con F#m y Bm7 que no debe cambiar\n');
    expect(r.source).toContain('[Estribillo] x2\n');
    expect(r.source).toContain('N.C. . . . | - - ');
  });

  it('accepts partial options (defaults fill the rest) and is idempotent', () => {
    const once = simplifyChart(SONG, { suggestCapo: false });
    const twice = simplifyChart(once.source, { suggestCapo: false });
    expect(twice.source).toBe(once.source);
    expect(twice.substitutions).toEqual([]);
    expect(twice.unchangedBeatsRatio).toBe(1);
  });

  it('preserves CRLF line endings', () => {
    const src = 'tempo: 100\r\nC . . . | F . . . |\r\n';
    const r = simplifyChart(src, { ...NO_OPTS, substituteHard: true });
    expect(r.source).toBe('tempo: 100\r\nC . . . | Dm . . . |\r\n');
  });

  it('handles a text without chords', () => {
    const r = simplifyChart('tempo: 100\nN.C. . . . | - - - - |\n');
    expect(r.source).toBe('tempo: 100\nN.C. . . . | - - - - |\n');
    expect(r.chordsBefore).toEqual([]);
    expect(r.chordsAfter).toEqual([]);
    expect(r.unchangedBeatsRatio).toBe(1);
    expect(r.capo).toBe(0);
  });
});

// ---------------------------------------------------------------- rewriteChordTokens

describe('rewriteChordTokens', () => {
  it('rewrites only chord tokens of bar lines', () => {
    const src = 'title: F\n# F comment\n[F] x2\n> F lyric\nF . . . | G/B*2 F*2 | N.C. . - F#m | x2   # F\nF: not a header\n';
    const out = rewriteChordTokens(src, (name) => (name === 'F' ? 'Dm' : name === 'G/B' ? 'G' : name));
    expect(out).toBe('title: F\n# F comment\n[F] x2\n> F lyric\nDm . . . | G*2 Dm*2 | N.C. . - F#m | x2   # F\nF: not a header\n');
  });

  it('can set the capo header', () => {
    expect(rewriteChordTokens('capo: 2\nC |\n', (n) => n, 4)).toBe('capo: 4\nC |\n');
    expect(rewriteChordTokens('title: x\nC |\n', (n) => n, 2)).toBe('title: x\ncapo: 2\nC |\n');
    expect(rewriteChordTokens('C |', (n) => n, 2)).toBe('capo: 2\nC |');
    expect(rewriteChordTokens('title: x', (n) => n, 2)).toBe('title: x\ncapo: 2');
    expect(rewriteChordTokens('C |\n', (n) => n, 0)).toBe('C |\n');
  });
});
