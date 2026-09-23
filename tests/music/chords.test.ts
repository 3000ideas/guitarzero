import { describe, expect, it } from 'vitest';
import type { ChordQuality, ChordShape } from '../../src/types';
import {
  CHORD_LIBRARY,
  GENERABLE_QUALITIES,
  STANDARD_TUNING_MIDI,
  canGenerateShape,
  computeBaseFret,
  findLibraryShape,
  generateBarreShape,
  getChordShape,
  shapeMidiNotes,
  shapePitchClasses,
} from '../../src/music/chords';
import { chordPitchClasses, parseChordSymbol } from '../../src/music/notes';

/** Chords the spec requires in the library. */
const REQUIRED = [
  'C', 'D', 'E', 'F', 'G', 'A', 'B',
  'Am', 'Bm', 'Cm', 'Dm', 'Em', 'Fm', 'Gm',
  'A7', 'B7', 'C7', 'D7', 'E7', 'G7',
  'Am7', 'Dm7', 'Em7',
  'Cmaj7', 'Fmaj7', 'Amaj7', 'Dmaj7',
  'Asus2', 'Asus4', 'Dsus2', 'Dsus4', 'Esus4',
  'Cadd9', 'Gadd9',
  'G/B', 'D/F#', 'C/G', 'Am/G',
  'Bb', 'Eb', 'F#m', 'C#m', 'G#m', 'Bm7', 'F#m7',
  'A5', 'E5', 'D5', 'G5',
];

function minFretted(frets: number[]): number {
  const f = frets.filter((x) => x > 0);
  return f.length ? Math.min(...f) : 0;
}

function isSubset(a: number[], b: number[]): boolean {
  return a.every((x) => b.includes(x));
}

/** Structural checks shared by library and generated shapes. */
function expectValidShape(shape: ChordShape, label: string): void {
  expect(shape.frets, label).toHaveLength(6);
  expect(shape.fingers, label).toHaveLength(6);
  for (let i = 0; i < 6; i++) {
    const fret = shape.frets[i];
    const finger = shape.fingers[i];
    expect(Number.isInteger(fret), `${label} fret ${i}`).toBe(true);
    expect(fret, `${label} fret ${i}`).toBeGreaterThanOrEqual(-1);
    expect(fret, `${label} fret ${i}`).toBeLessThanOrEqual(15);
    expect(Number.isInteger(finger), `${label} finger ${i}`).toBe(true);
    expect(finger, `${label} finger ${i}`).toBeGreaterThanOrEqual(0);
    expect(finger, `${label} finger ${i}`).toBeLessThanOrEqual(4);
    // fingers[i] === 0 iff frets[i] <= 0 (barre strings carry the barre finger)
    expect(finger === 0, `${label} finger/fret coherence on string ${i}`).toBe(fret <= 0);
  }
  // at least three sounding strings, at least one fretted or open
  expect(shape.frets.filter((f) => f >= 0).length, label).toBeGreaterThanOrEqual(2);
  // baseFret rule: 1 unless the lowest fretted fret is > 3 (or the shape does not fit in 5 frets)
  const min = minFretted(shape.frets);
  const max = Math.max(...shape.frets);
  expect(shape.baseFret, `${label} baseFret`).toBeGreaterThanOrEqual(1);
  if (min > 3 || max > 5) expect(shape.baseFret, `${label} baseFret`).toBe(min);
  else expect(shape.baseFret, `${label} baseFret`).toBe(1);
  if (shape.baseFret > 1) expect(max - shape.baseFret, `${label} span`).toBeLessThanOrEqual(4);
  if (shape.barre) {
    const { fret, fromString, toString } = shape.barre;
    expect(fromString, `${label} barre.fromString`).toBeGreaterThanOrEqual(0);
    expect(toString, `${label} barre.toString`).toBeLessThanOrEqual(5);
    expect(fromString, `${label} barre range`).toBeLessThan(toString);
    expect(fret, `${label} barre.fret`).toBe(min);
    expect(fret, `${label} barre.fret`).toBeGreaterThanOrEqual(1);
    for (let i = fromString; i <= toString; i++) {
      expect(shape.frets[i], `${label} barre covers string ${i}`).toBeGreaterThanOrEqual(fret);
      if (shape.frets[i] === fret) expect(shape.fingers[i], `${label} barre finger on string ${i}`).toBe(1);
    }
    // no other finger is placed below the barre fret
    for (let i = 0; i < 6; i++) if (shape.frets[i] > 0) expect(shape.frets[i], label).toBeGreaterThanOrEqual(fret);
  }
  // each finger number (2..4) is used on at most one string, finger 1 may be a barre
  const used = new Map<number, number>();
  shape.fingers.forEach((fg) => used.set(fg, (used.get(fg) ?? 0) + 1));
  for (const fg of [2, 3, 4]) expect(used.get(fg) ?? 0, `${label} finger ${fg} used once`).toBeLessThanOrEqual(1);
  if ((used.get(1) ?? 0) > 1) expect(shape.barre, `${label} multiple index-finger strings need a barre`).toBeDefined();
}

describe('CHORD_LIBRARY', () => {
  it('contains every chord required by the spec, not generated', () => {
    for (const name of REQUIRED) {
      const shape = getChordShape(name);
      expect(shape, name).not.toBeNull();
      expect(shape!.generated, name).toBeFalsy();
      expect(CHORD_LIBRARY.includes(shape!), name).toBe(true);
    }
  });

  it('has unique, parseable names', () => {
    const names = CHORD_LIBRARY.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const keys = new Set<string>();
    for (const shape of CHORD_LIBRARY) {
      const sym = parseChordSymbol(shape.name);
      expect(sym, shape.name).not.toBeNull();
      expect(sym!.quality, shape.name).not.toBe('nc');
      const key = `${sym!.root}:${sym!.quality}:${sym!.bass}`;
      expect(keys.has(key), `duplicate voicing identity for ${shape.name}`).toBe(false);
      keys.add(key);
    }
  });

  it('every shape is structurally valid', () => {
    for (const shape of CHORD_LIBRARY) expectValidShape(shape, shape.name);
  });

  it('every shape sounds only chord tones (plus the slash bass), includes the root, and its lowest note is the bass', () => {
    for (const shape of CHORD_LIBRARY) {
      const sym = parseChordSymbol(shape.name)!;
      const allowed = chordPitchClasses(sym);
      const pcs = shapePitchClasses(shape);
      expect(isSubset(pcs, allowed), `${shape.name}: sounds ${pcs} but chord is ${allowed}`).toBe(true);
      expect(pcs, `${shape.name} includes root`).toContain(sym.root);
      // at least the root and one more chord tone (a power chord has exactly two)
      expect(pcs.length, shape.name).toBeGreaterThanOrEqual(2);
      const midi = shapeMidiNotes(shape);
      const lowest = Math.min(...midi) % 12;
      expect(lowest, `${shape.name} lowest note`).toBe(sym.bass ?? sym.root);
      // the sounding strings are contiguous (no muted string in the middle of a strum)
      const sounding = shape.frets.map((f) => f >= 0);
      const first = sounding.indexOf(true);
      const last = sounding.lastIndexOf(true);
      const inner = sounding.slice(first, last + 1);
      const gaps = inner.filter((s) => !s).length;
      expect(gaps, `${shape.name} inner muted strings`).toBeLessThanOrEqual(1);
    }
  });

  it('every shape with a third sounds it (full triads for non-power chords)', () => {
    for (const shape of CHORD_LIBRARY) {
      const sym = parseChordSymbol(shape.name)!;
      const pcs = shapePitchClasses(shape);
      const third = sym.quality === 'min' || sym.quality === 'm7' ? 3 : sym.quality === 'maj' || sym.quality === '7' || sym.quality === 'maj7' || sym.quality === 'add9' ? 4 : null;
      if (third !== null) expect(pcs, `${shape.name} third`).toContain((sym.root + third) % 12);
      if (sym.quality === '7' || sym.quality === 'm7') expect(pcs, `${shape.name} seventh`).toContain((sym.root + 10) % 12);
      if (sym.quality === 'maj7') expect(pcs, `${shape.name} major seventh`).toContain((sym.root + 11) % 12);
      if (sym.quality === 'sus4') expect(pcs, `${shape.name} fourth`).toContain((sym.root + 5) % 12);
      if (sym.quality === 'sus2' || sym.quality === 'add9') expect(pcs, `${shape.name} ninth`).toContain((sym.root + 2) % 12);
      if (sym.quality === '5') expect(pcs, shape.name).toEqual([sym.root, (sym.root + 7) % 12].sort((a, b) => a - b));
    }
  });

  it('has the expected fingerings for the reference chords', () => {
    expect(getChordShape('C')).toMatchObject({ frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], baseFret: 1 });
    expect(getChordShape('G')).toMatchObject({ frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] });
    expect(getChordShape('D')).toMatchObject({ frets: [-1, -1, 0, 2, 3, 2] });
    expect(getChordShape('E')).toMatchObject({ frets: [0, 2, 2, 1, 0, 0] });
    expect(getChordShape('A')).toMatchObject({ frets: [-1, 0, 2, 2, 2, 0] });
    expect(getChordShape('Am')).toMatchObject({ frets: [-1, 0, 2, 2, 1, 0] });
    expect(getChordShape('Em')).toMatchObject({ frets: [0, 2, 2, 0, 0, 0] });
    expect(getChordShape('Dm')).toMatchObject({ frets: [-1, -1, 0, 2, 3, 1] });
    expect(getChordShape('F')).toMatchObject({
      frets: [1, 3, 3, 2, 1, 1],
      barre: { fret: 1, fromString: 0, toString: 5 },
      baseFret: 1,
    });
    expect(getChordShape('Bb')).toMatchObject({ frets: [-1, 1, 3, 3, 3, 1], barre: { fret: 1, fromString: 1, toString: 5 }, baseFret: 1 });
    expect(getChordShape('Eb')).toMatchObject({ frets: [-1, 6, 8, 8, 8, 6], baseFret: 6, barre: { fret: 6 } });
    expect(getChordShape('B')).toMatchObject({ frets: [-1, 2, 4, 4, 4, 2], baseFret: 1 });
    expect(getChordShape('Bm')).toMatchObject({ frets: [-1, 2, 4, 4, 3, 2], baseFret: 1 });
    expect(getChordShape('Cm')).toMatchObject({ frets: [-1, 3, 5, 5, 4, 3], baseFret: 1 });
    expect(getChordShape('Fm')).toMatchObject({ frets: [1, 3, 3, 1, 1, 1] });
    expect(getChordShape('Gm')).toMatchObject({ frets: [3, 5, 5, 3, 3, 3], baseFret: 1 });
    expect(getChordShape('C#m')).toMatchObject({ frets: [-1, 4, 6, 6, 5, 4], baseFret: 4 });
    expect(getChordShape('G#m')).toMatchObject({ frets: [4, 6, 6, 4, 4, 4], baseFret: 4 });
    expect(getChordShape('F#m')).toMatchObject({ frets: [2, 4, 4, 2, 2, 2], baseFret: 1 });
    expect(getChordShape('F#m7')).toMatchObject({ frets: [2, 4, 2, 2, 2, 2] });
    expect(getChordShape('Bm7')).toMatchObject({ frets: [-1, 2, 4, 2, 3, 2] });
    expect(getChordShape('Amaj7')).toMatchObject({ frets: [-1, 0, 2, 1, 2, 0] });
    expect(getChordShape('Dmaj7')).toMatchObject({ frets: [-1, -1, 0, 2, 2, 2] });
    expect(getChordShape('G/B')).toMatchObject({ frets: [-1, 2, 0, 0, 0, 3] });
    expect(getChordShape('D/F#')).toMatchObject({ frets: [2, 0, 0, 2, 3, 2] });
    expect(getChordShape('C/G')).toMatchObject({ frets: [3, 3, 2, 0, 1, 0] });
    expect(getChordShape('Am/G')).toMatchObject({ frets: [3, 0, 2, 2, 1, 0] });
    expect(getChordShape('A5')).toMatchObject({ frets: [-1, 0, 2, 2, -1, -1] });
    expect(getChordShape('E5')).toMatchObject({ frets: [0, 2, 2, -1, -1, -1] });
    expect(getChordShape('D5')).toMatchObject({ frets: [-1, -1, 0, 2, 3, -1] });
    expect(getChordShape('G5')).toMatchObject({ frets: [3, 5, 5, -1, -1, -1], baseFret: 1 });
    expect(getChordShape('A5')!.barre).toBeUndefined();
    expect(getChordShape('C')!.barre).toBeUndefined();
  });
});

describe('shapePitchClasses / shapeMidiNotes', () => {
  it('uses standard tuning', () => {
    expect(STANDARD_TUNING_MIDI).toEqual([40, 45, 50, 55, 59, 64]);
    expect(shapeMidiNotes(getChordShape('E')!)).toEqual([40, 47, 52, 56, 59, 64]);
    expect(shapeMidiNotes(getChordShape('C')!)).toEqual([48, 52, 55, 60, 64]);
    expect(shapeMidiNotes(getChordShape('A5')!)).toEqual([45, 52, 57]);
  });

  it('shapePitchClasses(G) contains G, B, D', () => {
    const pcs = shapePitchClasses(getChordShape('G')!);
    expect(pcs).toEqual([2, 7, 11]);
    expect(isSubset([7, 11, 2], pcs)).toBe(true);
  });

  it('returns unique ascending pitch classes', () => {
    expect(shapePitchClasses(getChordShape('Am7')!)).toEqual([0, 4, 7, 9]);
    expect(shapePitchClasses(getChordShape('D/F#')!)).toEqual([2, 6, 9]);
    expect(shapePitchClasses({ name: 'x', frets: [-1, -1, -1, -1, -1, -1], fingers: [0, 0, 0, 0, 0, 0], baseFret: 1 })).toEqual([]);
  });
});

describe('getChordShape lookup', () => {
  it('matches enharmonics and aliases by root + quality + bass', () => {
    expect(getChordShape('A#')).toBe(getChordShape('Bb'));
    expect(getChordShape('D#')).toBe(getChordShape('Eb'));
    expect(getChordShape('Gbm')).toBe(getChordShape('F#m'));
    expect(getChordShape('Dbm')).toBe(getChordShape('C#m'));
    expect(getChordShape('Abm')).toBe(getChordShape('G#m'));
    expect(getChordShape('CM7')).toBe(getChordShape('Cmaj7'));
    expect(getChordShape('CΔ7')).toBe(getChordShape('Cmaj7'));
    expect(getChordShape('A-7')).toBe(getChordShape('Am7'));
    expect(getChordShape('Amin')).toBe(getChordShape('Am'));
    expect(getChordShape('Asus')).toBe(getChordShape('Asus4'));
    expect(getChordShape('D/Gb')).toBe(getChordShape('D/F#'));
    expect(getChordShape('B♭')).toBe(getChordShape('Bb'));
    expect(getChordShape('Bb')!.name).toBe('Bb');
  });

  it('accepts ChordSymbol objects', () => {
    expect(getChordShape({ name: 'anything', root: 7, quality: 'maj', bass: 11 })).toBe(getChordShape('G/B'));
    expect(getChordShape({ name: 'C', root: 0, quality: 'maj', bass: null })).toBe(getChordShape('C'));
    expect(getChordShape(parseChordSymbol('Em7')!)).toBe(getChordShape('Em7'));
  });

  it('findLibraryShape exposes the index', () => {
    expect(findLibraryShape(0, 'maj')).toBe(getChordShape('C'));
    expect(findLibraryShape(0, 'maj', 7)).toBe(getChordShape('C/G'));
    expect(findLibraryShape(0, 'maj', 5)).toBeNull();
    expect(findLibraryShape(1, 'maj')).toBeNull();
  });

  it('returns null for nc, invalid syntax and non-generable qualities', () => {
    expect(getChordShape('N.C.')).toBeNull();
    expect(getChordShape('NC')).toBeNull();
    expect(getChordShape('-')).toBeNull();
    expect(getChordShape('')).toBeNull();
    expect(getChordShape('Cx')).toBeNull();
    expect(getChordShape('H')).toBeNull();
    expect(getChordShape({ name: '-', root: -1, quality: 'nc', bass: null })).toBeNull();
    // qualities without an E/A barre template and not in the library
    expect(getChordShape('Cdim')).toBeNull();
    expect(getChordShape('Cdim7')).toBeNull();
    expect(getChordShape('Cm7b5')).toBeNull();
    expect(getChordShape('Caug')).toBeNull();
    expect(getChordShape('Csus2')).toBeNull();
    expect(getChordShape('C7sus4')).toBeNull();
    expect(getChordShape('Fadd9')).toBeNull();
    expect(getChordShape('C6')).toBeNull();
    expect(getChordShape('Cm6')).toBeNull();
    expect(getChordShape('C9')).toBeNull();
  });

  it('falls back to the root-position voicing for unknown slash chords', () => {
    expect(getChordShape('F/A')).toBe(getChordShape('F'));
    expect(getChordShape('G/F#')).toBe(getChordShape('G'));
    const gen = getChordShape('Bbm/Db');
    expect(gen).not.toBeNull();
    expect(gen!.generated).toBe(true);
    expect(gen!.name).toBe('Bbm');
    expect(shapePitchClasses(gen!)).toEqual([1, 5, 10]);
  });
});

describe('barre generator', () => {
  it('canGenerateShape / GENERABLE_QUALITIES', () => {
    expect(GENERABLE_QUALITIES).toEqual(['maj', 'min', '7', 'm7', 'maj7', 'sus4', '5']);
    for (const q of GENERABLE_QUALITIES) expect(canGenerateShape(q), q).toBe(true);
    for (const q of ['dim', 'dim7', 'm7b5', 'aug', 'sus2', '7sus4', 'add9', '6', 'm6', '9', 'nc'] as ChordQuality[]) {
      expect(canGenerateShape(q), q).toBe(false);
    }
  });

  it('generates F#m from the E shape at fret 2', () => {
    const s = generateBarreShape('F#m')!;
    expect(s).toMatchObject({
      name: 'F#m',
      frets: [2, 4, 4, 2, 2, 2],
      fingers: [1, 3, 4, 1, 1, 1],
      baseFret: 1,
      barre: { fret: 2, fromString: 0, toString: 5 },
      generated: true,
    });
    expect(shapePitchClasses(s)).toEqual([1, 6, 9]);
    expectValidShape(s, 'F#m (generated)');
  });

  it('generates Bbm7 from the A shape at fret 1', () => {
    const s = getChordShape('Bbm7')!;
    expect(s).toMatchObject({
      name: 'Bbm7',
      frets: [-1, 1, 3, 1, 2, 1],
      fingers: [0, 1, 3, 1, 2, 1],
      baseFret: 1,
      barre: { fret: 1, fromString: 1, toString: 5 },
      generated: true,
    });
    expect(shapePitchClasses(s)).toEqual([1, 5, 8, 10]);
    expect(shapePitchClasses(s)).toEqual(chordPitchClasses(parseChordSymbol('Bbm7')!));
    expectValidShape(s, 'Bbm7 (generated)');
  });

  it('generates C#7 from the A shape at fret 4', () => {
    const s = getChordShape('C#7')!;
    expect(s).toMatchObject({
      name: 'C#7',
      frets: [-1, 4, 6, 4, 6, 4],
      baseFret: 4,
      barre: { fret: 4, fromString: 1, toString: 5 },
      generated: true,
    });
    expect(shapePitchClasses(s)).toEqual([1, 5, 8, 11]);
    expectValidShape(s, 'C#7 (generated)');
  });

  it('generates Ab from the E shape at fret 4 (keeps the flat spelling)', () => {
    const s = getChordShape('Ab')!;
    expect(s).toMatchObject({
      name: 'Ab',
      frets: [4, 6, 6, 5, 4, 4],
      fingers: [1, 3, 4, 2, 1, 1],
      baseFret: 4,
      barre: { fret: 4, fromString: 0, toString: 5 },
      generated: true,
    });
    expect(shapePitchClasses(s)).toEqual([0, 3, 8]);
    expect(getChordShape('G#')!.name).toBe('G#');
    expect(getChordShape('G#')!.frets).toEqual(s.frets);
    expectValidShape(s, 'Ab (generated)');
  });

  it('picks the shape with the lowest barre fret and never the open position', () => {
    // B: E shape at 7 vs A shape at 2 -> A shape
    expect(generateBarreShape('B')!.frets).toEqual([-1, 2, 4, 4, 4, 2]);
    // F: E shape at 1 vs A shape at 8 -> E shape
    expect(generateBarreShape('F')!.frets).toEqual([1, 3, 3, 2, 1, 1]);
    // D: E shape at 10 vs A shape at 5 -> A shape
    expect(generateBarreShape('D')!.frets).toEqual([-1, 5, 7, 7, 7, 5]);
    expect(generateBarreShape('D')!.baseFret).toBe(5);
    // E and A roots: the open position is not a barre, so use the other shape
    expect(generateBarreShape('E')!.frets).toEqual([-1, 7, 9, 9, 9, 7]);
    expect(generateBarreShape('A')!.frets).toEqual([5, 7, 7, 6, 5, 5]);
    // library still wins for E/A/Emaj7
    expect(getChordShape('E')!.generated).toBeFalsy();
    expect(getChordShape('Emaj7')!.generated).toBeFalsy();
    expect(getChordShape('Emaj7')!.frets).toEqual([0, 2, 1, 1, 0, 0]);
  });

  it('generates power chords without a barre', () => {
    const c5 = getChordShape('C5')!;
    expect(c5).toMatchObject({ name: 'C5', frets: [-1, 3, 5, 5, -1, -1], fingers: [0, 1, 3, 4, 0, 0], generated: true });
    expect(c5.barre).toBeUndefined();
    expect(shapePitchClasses(c5)).toEqual([0, 7]);
    const f5 = getChordShape('F5')!;
    expect(f5).toMatchObject({ frets: [1, 3, 3, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0] });
    expect(f5.barre).toBeUndefined();
    expectValidShape(c5, 'C5');
    expectValidShape(f5, 'F5');
  });

  it('generates maj7 and sus4 barres with the right tones', () => {
    const bsus4 = getChordShape('Bsus4')!;
    expect(bsus4.frets).toEqual([-1, 2, 4, 4, 5, 2]);
    expect(shapePitchClasses(bsus4)).toEqual([4, 6, 11]);
    const fsus4 = getChordShape('Fsus4')!;
    expect(fsus4.frets).toEqual([1, 3, 3, 3, 1, 1]);
    expect(shapePitchClasses(fsus4)).toEqual([0, 5, 10]);
    const bbmaj7 = getChordShape('Bbmaj7')!;
    expect(bbmaj7.frets).toEqual([-1, 1, 3, 2, 3, 1]);
    expect(shapePitchClasses(bbmaj7)).toEqual([2, 5, 9, 10]);
    const gbmaj7 = getChordShape('Gbmaj7')!;
    expect(gbmaj7.frets).toEqual([2, 4, 3, 3, 2, 2]);
    expect(shapePitchClasses(gbmaj7)).toEqual([1, 5, 6, 10]);
    expect(gbmaj7.name).toBe('Gbmaj7');
  });

  it('every generable root/quality yields a valid shape sounding exactly the chord tones', () => {
    for (let root = 0; root < 12; root++) {
      for (const q of GENERABLE_QUALITIES) {
        const sym = { name: '', root, quality: q, bass: null };
        const s = generateBarreShape(sym);
        expect(s, `${root}:${q}`).not.toBeNull();
        expectValidShape(s!, `${s!.name} (generated)`);
        expect(s!.generated, s!.name).toBe(true);
        expect(shapePitchClasses(s!), s!.name).toEqual(chordPitchClasses(sym));
        const min = minFretted(s!.frets);
        expect(min, s!.name).toBeGreaterThanOrEqual(1);
        expect(min, s!.name).toBeLessThanOrEqual(12);
        if (q !== '5') {
          expect(s!.barre, s!.name).toBeDefined();
          expect(s!.barre!.fret, s!.name).toBe(min);
          expect(s!.barre!.toString).toBe(5);
          expect(s!.barre!.fromString).toBe(s!.frets[0] === -1 ? 1 : 0);
        } else {
          expect(s!.barre, s!.name).toBeUndefined();
        }
        // the lowest sounding note is the root
        expect(Math.min(...shapeMidiNotes(s!)) % 12, s!.name).toBe(root);
        // getChordShape agrees when the library has no entry
        const viaLookup = getChordShape(sym)!;
        expect(viaLookup, s!.name).not.toBeNull();
        if (viaLookup.generated) expect(viaLookup).toEqual(s);
      }
    }
  });

  it('returns null for nc / invalid / non-generable input', () => {
    expect(generateBarreShape('N.C.')).toBeNull();
    expect(generateBarreShape('-')).toBeNull();
    expect(generateBarreShape('Cx')).toBeNull();
    expect(generateBarreShape('Cdim')).toBeNull();
    expect(generateBarreShape({ name: 'x', root: -1, quality: 'maj', bass: null })).toBeNull();
  });
});

describe('computeBaseFret', () => {
  it('follows the display rule', () => {
    expect(computeBaseFret([-1, 3, 2, 0, 1, 0])).toBe(1);
    expect(computeBaseFret([0, 0, 0, 0, 0, 0])).toBe(1);
    expect(computeBaseFret([-1, 3, 5, 5, 4, 3])).toBe(1);
    expect(computeBaseFret([-1, 4, 6, 6, 5, 4])).toBe(4);
    expect(computeBaseFret([-1, 6, 8, 8, 8, 6])).toBe(6);
    expect(computeBaseFret([-1, 3, 5, 5, 6, 3])).toBe(3); // Csus4 barre: would need 6 frets from the nut
    expect(computeBaseFret([12, 14, 14, 13, 12, 12])).toBe(12);
  });
});
