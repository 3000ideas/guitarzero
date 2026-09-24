import { describe, expect, it } from 'vitest';
import type { ChordTranscription, TranscribedSection } from '../../src/types';
import { buildVocabulary, segmentStructure, transcribeChords } from '../../src/dsp/chordTranscribe';
import { makeRng, synthStructuredSong, type SongSectionSpec } from '../helpers/synth';

const SR = 44100;

// ---------------------------------------------------------------- synthetic bar features

const TEMPLATES = new Map(buildVocabulary('basic').map((t) => [t.name, t.vector]));

interface FeatureSection {
  /** One chord per bar. */
  chords: string[];
  rounds?: number;
  /** Energy of the bars in dB relative to the loudest bar. */
  db: number;
}

interface Features {
  barChroma: Float32Array[];
  barEnergy: number[];
  barChords: (string | null)[][];
  /** Bar index where every section starts. */
  starts: number[];
}

/** Bar features of a structure: chord template chroma + seeded noise, energy per section (+-0.5 dB), one chord per bar. */
function features(sections: FeatureSection[], seed = 1, noise = 0.06): Features {
  const rng = makeRng(seed);
  const barChroma: Float32Array[] = [];
  const barEnergy: number[] = [];
  const barChords: (string | null)[][] = [];
  const starts: number[] = [];
  for (const s of sections) {
    starts.push(barChroma.length);
    for (let r = 0; r < (s.rounds ?? 1); r++) {
      for (const name of s.chords) {
        const tpl = TEMPLATES.get(name);
        if (!tpl) throw new Error(`no template for ${name}`);
        const c = new Float32Array(12);
        let norm = 0;
        for (let i = 0; i < 12; i++) {
          c[i] = Math.max(0, tpl[i] + noise * (2 * rng() - 1));
          norm += c[i] * c[i];
        }
        norm = Math.sqrt(norm);
        for (let i = 0; i < 12; i++) c[i] /= norm;
        barChroma.push(c);
        barEnergy.push(s.db + 0.5 * (2 * rng() - 1));
        barChords.push([name, name, name, name]);
      }
    }
  }
  return { barChroma, barEnergy, barChords, starts };
}

const INTRO = ['C', 'C', 'G', 'G'];
const VERSE = ['C', 'G', 'Am', 'F'];
const CHORUS = ['F', 'G', 'C', 'C'];
const OUTRO = ['Em', 'Em', 'Am', 'Am'];

const SONG: FeatureSection[] = [
  { chords: INTRO, db: -12 },
  { chords: VERSE, rounds: 2, db: -6 },
  { chords: CHORUS, rounds: 2, db: 0 },
  { chords: VERSE, rounds: 2, db: -6 },
  { chords: CHORUS, rounds: 2, db: 0 },
  { chords: OUTRO, db: -8 },
];

function describeSections(sections: TranscribedSection[] | undefined): string {
  return sections ? sections.map((s) => `${s.startBar}-${s.endBar} ${s.label} (${s.letter})`).join(' | ') : 'undefined';
}

function expectWellFormed(sections: TranscribedSection[], bars: number): void {
  expect(sections.length).toBeGreaterThanOrEqual(2);
  expect(sections[0].startBar).toBe(0);
  expect(sections[sections.length - 1].endBar).toBe(bars - 1);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    expect(s.endBar).toBeGreaterThanOrEqual(s.startBar);
    if (i > 0) expect(s.startBar).toBe(sections[i - 1].endBar + 1);
    expect(s.letter).toMatch(/^[A-Z]/);
    expect(s.label).not.toBe('');
  }
  const labels = sections.map((s) => s.label);
  expect(new Set(labels.filter((l) => l === 'Intro')).size).toBeLessThanOrEqual(1);
  expect(labels.filter((l) => l === 'Final').length).toBeLessThanOrEqual(1);
}

describe('segmentStructure', () => {
  it('Intro(4) A(8) B(8) A(8) B(8) Final(4) -> 6 sections at 4/12/20/28/36 with Intro, Estrofa, Estribillo, Estrofa, Estribillo, Final', () => {
    const f = features(SONG);
    const sections = segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4);
    expect(sections, describeSections(sections)).toBeDefined();
    const s = sections as TranscribedSection[];
    expectWellFormed(s, 40);
    expect(s, describeSections(s)).toHaveLength(6);
    const starts = s.map((x) => x.startBar);
    expect(starts[0]).toBe(0);
    [4, 12, 20, 28, 36].forEach((b, i) => expect(Math.abs(starts[i + 1] - b), describeSections(s)).toBeLessThanOrEqual(1));
    expect(s.map((x) => x.label)).toEqual(['Intro', 'Estrofa', 'Estribillo', 'Estrofa', 'Estribillo', 'Final']);
    expect(s.map((x) => x.letter)).toEqual(['A', 'B', 'C', 'B', 'C', 'D']);
  });

  it('the boundaries are found for several noise seeds', () => {
    for (const seed of [2, 3, 5, 8, 13]) {
      const f = features(SONG, seed, 0.1);
      const s = segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4);
      expect(s, `seed ${seed}: ${describeSections(s)}`).toBeDefined();
      expect(s, `seed ${seed}: ${describeSections(s)}`).toHaveLength(6);
      expect((s as TranscribedSection[]).map((x) => x.label), `seed ${seed}`).toEqual([
        'Intro', 'Estrofa', 'Estribillo', 'Estrofa', 'Estribillo', 'Final',
      ]);
    }
  });

  it('a constant progression (C G Am F x 10) has a single section -> undefined', () => {
    const f = features([{ chords: VERSE, rounds: 10, db: 0 }]);
    expect(segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4)).toBeUndefined();
    // Also with a loud / quiet alternation that follows no phrase structure.
    const g = features([{ chords: VERSE, rounds: 10, db: 0 }], 4, 0.15);
    expect(segmentStructure(g.barChroma, g.barEnergy, g.barChords, 4)).toBeUndefined();
  });

  it('the loudest repeated part is the chorus even when the verse repeats more often; a unique middle part is Puente', () => {
    const f = features([
      { chords: VERSE, rounds: 2, db: -6 },
      { chords: VERSE, rounds: 2, db: -6 },
      { chords: CHORUS, rounds: 2, db: 0 },
      { chords: VERSE, rounds: 2, db: -6 },
      { chords: OUTRO, rounds: 2, db: -3 },
      { chords: CHORUS, rounds: 2, db: 0 },
    ]);
    const s = segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4);
    expect(s, describeSections(s)).toBeDefined();
    const sections = s as TranscribedSection[];
    expectWellFormed(sections, 48);
    // The two consecutive verses merge (nothing changes at bar 8): Estrofa Estribillo Estrofa Puente Estribillo.
    expect(sections.map((x) => x.label), describeSections(sections)).toEqual(['Estrofa', 'Estribillo', 'Estrofa', 'Puente', 'Estribillo']);
    expect(sections.map((x) => x.startBar)).toEqual([0, 16, 24, 32, 40]);
  });

  it('a single repeated letter is Estrofa; a unique opening part is Intro and a closing one Final', () => {
    const f = features([
      { chords: INTRO, db: -10 },
      { chords: VERSE, rounds: 2, db: 0 },
      { chords: OUTRO, rounds: 2, db: -4 },
      { chords: VERSE, rounds: 2, db: 0 },
      { chords: CHORUS, db: -6 },
    ]);
    const s = segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4);
    expect(s, describeSections(s)).toBeDefined();
    const sections = s as TranscribedSection[];
    expectWellFormed(sections, 32);
    expect(sections.map((x) => x.label), describeSections(sections)).toEqual(['Intro', 'Estrofa', 'Puente', 'Estrofa', 'Final']);
    expect(sections.map((x) => x.letter)).toEqual(['A', 'B', 'C', 'B', 'D']);
  });

  it('a short intro of 2 bars before a repeated progression is kept as its own section', () => {
    const f = features([
      { chords: ['C', 'C'], db: -10 },
      { chords: VERSE, rounds: 2, db: -6 },
      { chords: CHORUS, rounds: 2, db: 0 },
      { chords: VERSE, rounds: 2, db: -6 },
      { chords: CHORUS, rounds: 2, db: 0 },
    ]);
    const s = segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4);
    expect(s, describeSections(s)).toBeDefined();
    const sections = s as TranscribedSection[];
    expectWellFormed(sections, 34);
    expect(sections[0]).toMatchObject({ startBar: 0, endBar: 1, label: 'Intro' });
    expect(sections.map((x) => x.label)).toEqual(['Intro', 'Estrofa', 'Estribillo', 'Estrofa', 'Estribillo']);
  });

  it('degenerate input: fewer than 2 bars -> undefined; mismatched lengths -> RangeError', () => {
    expect(segmentStructure([], [], [], 4)).toBeUndefined();
    const f = features([{ chords: ['C'], db: 0 }]);
    expect(segmentStructure(f.barChroma, f.barEnergy, f.barChords, 4)).toBeUndefined();
    const g = features([{ chords: VERSE, db: 0 }]);
    expect(segmentStructure(g.barChroma, g.barEnergy, g.barChords, 4)).toBeUndefined();
    expect(() => segmentStructure(g.barChroma, g.barEnergy.slice(1), g.barChords, 4)).toThrow(RangeError);
    // Empty chord sequences (N.C. bars) and odd beatsPerBar are tolerated.
    const h = features(SONG);
    expect(segmentStructure(h.barChroma, h.barEnergy, h.barChords.map(() => []), 3)).toBeDefined();
  });
});

// ---------------------------------------------------------------- from audio

const AUDIO_SONG: SongSectionSpec[] = [
  { chords: INTRO, dbfs: -26 },
  { chords: VERSE, rounds: 2, dbfs: -20 },
  { chords: CHORUS, rounds: 2, dbfs: -14 },
  { chords: VERSE, rounds: 2, dbfs: -20 },
  { chords: CHORUS, rounds: 2, dbfs: -14 },
  { chords: OUTRO, dbfs: -22 },
];

/** The 40-bar song is synthesised once for the file (about 96 s of audio). */
let cachedSong: ReturnType<typeof synthStructuredSong> | null = null;
function structuredSong(): ReturnType<typeof synthStructuredSong> {
  if (!cachedSong) cachedSong = synthStructuredSong(AUDIO_SONG, SR, { bpm: 100, seed: 3 });
  return cachedSong;
}

describe('transcribeChords structure and bar tempos', () => {
  it('synthesised Intro(4) A(8) B(8) A(8) B(8) Final(4) at 100 BPM -> 6 sections, boundaries 4/12/20/28/36 +-1, Spanish labels', () => {
    const song = structuredSong();
    expect(song.sectionStarts).toEqual([0, 4, 12, 20, 28, 36]);
    const t: ChordTranscription = transcribeChords(song.signal, SR);
    expect(t.bars, describeSections(t.sections)).toHaveLength(40);
    expect(Math.abs(t.bpm - 100)).toBeLessThanOrEqual(1);
    expect(t.barTempos).toBeDefined();
    expect(t.barTempos).toHaveLength(40);
    for (const v of t.barTempos as number[]) expect(Math.abs(v - 100)).toBeLessThanOrEqual(2);
    expect(t.sections, describeSections(t.sections)).toBeDefined();
    const s = t.sections as TranscribedSection[];
    expectWellFormed(s, 40);
    expect(s, describeSections(s)).toHaveLength(6);
    const starts = s.map((x) => x.startBar);
    [4, 12, 20, 28, 36].forEach((b, i) => expect(Math.abs(starts[i + 1] - b), describeSections(s)).toBeLessThanOrEqual(1));
    expect(s.map((x) => x.label), describeSections(s)).toEqual(['Intro', 'Estrofa', 'Estribillo', 'Estrofa', 'Estribillo', 'Final']);
    expect(s[1].letter).toBe(s[3].letter);
    expect(s[2].letter).toBe(s[4].letter);
    expect(new Set(s.map((x) => x.letter)).size).toBe(4);
  }, 60000);

  it('a constant progression from audio -> sections undefined; detectSections: false never segments', () => {
    const song = synthStructuredSong([{ chords: VERSE, rounds: 6 }], SR, { bpm: 100, seed: 5 });
    const t = transcribeChords(song.signal, SR);
    expect(t.bars).toHaveLength(24);
    expect(t.sections, describeSections(t.sections)).toBeUndefined();
    const off = transcribeChords(structuredSong().signal, SR, { detectSections: false });
    expect(off.sections).toBeUndefined();
    expect(off.barTempos).toBeDefined();
  }, 60000);
});
