import { describe, expect, it } from 'vitest';
import type { ChordTemplate } from '../../src/types';
import { CHORD_LIBRARY, shapeMidiNotes, shapePitchClasses } from '../../src/music/chords';
import { chordPitchClasses, parseChordSymbol, pitchClassOf } from '../../src/music/notes';
import {
  TEMPLATE_QUALITIES,
  buildTemplates,
  compressChroma,
  computeEnergyChroma,
  cosine,
  matchChord,
  mergeExpectedTemplate,
  octaveWeight,
  rollChroma,
  samePitchClasses,
  templateForPitchClasses,
} from '../../src/dsp/chroma';
import { magnitudesAt, mix, scaled, sine, synthChord } from '../helpers/synth';

const N = 8192;
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function libraryShape(name: string) {
  const shape = CHORD_LIBRARY.find((s) => s.name === name);
  if (!shape) throw new Error(`missing library shape ${name}`);
  return shape;
}

function chromaOf(signal: Float32Array, sampleRate: number, endSample = N): Float32Array {
  return compressChroma(computeEnergyChroma(magnitudesAt(signal, endSample, N), sampleRate, N));
}

function l2(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function topBins(v: Float32Array, n: number): number[] {
  return Array.from(v)
    .map((value, pc) => ({ value, pc }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((x) => x.pc)
    .sort((a, b) => a - b);
}

describe('computeEnergyChroma + compressChroma', () => {
  const sines: Array<[string, number, number]> = [
    ['E2', 82.41, PC.E],
    ['F2', 87.31, PC.F],
    ['A2', 110, PC.A],
  ];
  for (const sr of [44100, 48000, 96000]) {
    for (const [name, freq, pc] of sines) {
      it(`pure sine ${name} at ${sr} Hz -> chroma[${name[0]}] >= 0.95, others <= 0.1`, () => {
        const c = chromaOf(sine(freq, sr, 0.25, 0.3), sr);
        expect(c[pc]).toBeGreaterThanOrEqual(0.95);
        for (let i = 0; i < 12; i++) if (i !== pc) expect(c[i]).toBeLessThanOrEqual(0.1);
      });
    }
  }

  it('E2 + B2 -> E and B >= 0.5, F and C <= 0.1', () => {
    for (const sr of [44100, 48000]) {
      const sig = mix([{ signal: sine(82.41, sr, 0.25, 0.25), atSec: 0 }, { signal: sine(123.47, sr, 0.25, 0.25), atSec: 0 }], sr);
      const c = chromaOf(sig, sr);
      expect(c[PC.E]).toBeGreaterThanOrEqual(0.5);
      expect(c[PC.B]).toBeGreaterThanOrEqual(0.5);
      expect(c[PC.F]).toBeLessThanOrEqual(0.1);
      expect(c[PC.C]).toBeLessThanOrEqual(0.1);
    }
  });

  it('energy chroma is linear energy: silence -> zeros, scaling the signal by 0.1 scales energy by 0.01', () => {
    const sr = 48000;
    expect(Array.from(computeEnergyChroma(magnitudesAt(new Float32Array(N), N), sr, N))).toEqual(new Array(12).fill(0));
    const sig = synthChord(shapeMidiNotes(libraryShape('C')), sr, 0.25);
    const e1 = computeEnergyChroma(magnitudesAt(sig, N), sr, N);
    const e2 = computeEnergyChroma(magnitudesAt(scaled(sig, 0.1), N), sr, N);
    let max = 0;
    for (let i = 0; i < 12; i++) max = Math.max(max, e1[i]);
    expect(max).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) expect(e2[i]).toBeCloseTo(0.01 * e1[i], 3);
  });

  it('reuses the out array and honours a4', () => {
    const sr = 48000;
    const out = new Float32Array(12).fill(5);
    const res = computeEnergyChroma(magnitudesAt(sine(82.41, sr, 0.25, 0.3), N), sr, N, {}, out);
    expect(res).toBe(out);
    expect(topBins(out, 1)).toEqual([PC.E]);
    // With A4 = 415.3 Hz (one semitone flat), 82.41 Hz reads as F.
    const flat = computeEnergyChroma(magnitudesAt(sine(82.41, sr, 0.25, 0.3), N), sr, N, { a4: 415.3 });
    expect(topBins(flat, 1)).toEqual([PC.F]);
  });

  it('octaveWeight is linear 1.0 (MIDI 40) -> 0.6 (MIDI 88)', () => {
    expect(octaveWeight(40)).toBeCloseTo(1, 9);
    expect(octaveWeight(64)).toBeCloseTo(0.8, 9);
    expect(octaveWeight(88)).toBeCloseTo(0.6, 9);
  });

  it('compressChroma is scale invariant, L2-normalised, and zero for a null input', () => {
    const e = new Float32Array([1, 0.5, 0.01, 0, 0, 0, 0.2, 0, 0, 0, 0, 0]);
    const a = compressChroma(e);
    const b = compressChroma(scaled(e, 0.01));
    for (let i = 0; i < 12; i++) expect(a[i]).toBeCloseTo(b[i], 6);
    expect(l2(a)).toBeCloseTo(1, 5);
    expect(topBins(a, 1)).toEqual([0]);
    expect(a[3]).toBe(0);
    expect(Array.from(compressChroma(new Float32Array(12)))).toEqual(new Array(12).fill(0));
    // In place.
    const inPlace = compressChroma(e, 10, e);
    expect(inPlace).toBe(e);
    for (let i = 0; i < 12; i++) expect(e[i]).toBeCloseTo(a[i], 6);
  });

  it('the whole chain is scale invariant: chroma(x) == chroma(0.01 x)', () => {
    const sr = 48000;
    const sig = synthChord(shapeMidiNotes(libraryShape('G')), sr, 0.25);
    const a = chromaOf(sig, sr);
    const b = chromaOf(scaled(sig, 0.01), sr);
    for (let i = 0; i < 12; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-4);
  });

  it('log compression lifts weak chord tones without flattening: off-chord bins stay small', () => {
    const sr = 48000;
    const c = chromaOf(synthChord(shapeMidiNotes(libraryShape('Am')), sr, 0.25), sr);
    const pcs = shapePitchClasses(libraryShape('Am'));
    let maxOn = 0;
    for (const p of pcs) maxOn = Math.max(maxOn, c[p]);
    for (let i = 0; i < 12; i++) {
      if (pcs.includes(i)) continue;
      expect(c[i]).toBeLessThan(0.35 * maxOn);
    }
  });
});

describe('real library voicings -> matchChord', () => {
  const names = ['E', 'A', 'D', 'G', 'C', 'Em', 'Am', 'Dm'];
  const templates = buildTemplates();
  for (const sr of [44100, 48000]) {
    for (const dbfs of [-20, -44]) {
      it(`top-1 in >= 7/8 and always top-2 at ${sr} Hz, ${dbfs} dBFS`, () => {
        let top1 = 0;
        for (const name of names) {
          const sig = synthChord(shapeMidiNotes(libraryShape(name)), sr, 0.3, { dbfs });
          const c = chromaOf(sig, sr, Math.round(0.05 * sr) + N);
          const m = matchChord(c, templates);
          expect(m.best).not.toBeNull();
          const top2 = m.ranked.slice(0, 2).map((r) => r.name);
          expect(top2, `${name}: ${m.ranked.slice(0, 3).map((r) => `${r.name}=${r.score.toFixed(3)}`).join(' ')}`).toContain(name);
          if (m.best!.name === name) top1++;
        }
        expect(top1).toBeGreaterThanOrEqual(7);
      });
    }
  }
});

describe('rollChroma', () => {
  it('out[pc] = v[(pc + shift) % 12], shift normalised, in place allowed', () => {
    const v = new Float32Array(12);
    for (let i = 0; i < 12; i++) v[i] = i;
    const r = rollChroma(v, 3);
    for (let pc = 0; pc < 12; pc++) expect(r[pc]).toBe((pc + 3) % 12);
    expect(rollChroma(v, 0)).toEqual(v);
    expect(rollChroma(v, -1)).toEqual(rollChroma(v, 11));
    expect(rollChroma(v, 14)).toEqual(rollChroma(v, 2));
    const copy = v.slice();
    const same = rollChroma(copy, 5, copy);
    expect(same).toBe(copy);
    for (let pc = 0; pc < 12; pc++) expect(copy[pc]).toBe((pc + 5) % 12);
  });

  it('chroma of A major rolled by 2 has its maxima at G, B, D (capo 2, written G)', () => {
    const sr = 48000;
    const sig = synthChord(shapeMidiNotes(libraryShape('A')), sr, 0.3);
    const e = computeEnergyChroma(magnitudesAt(sig, Math.round(0.05 * sr) + N), sr, N);
    expect(topBins(e, 3)).toEqual([PC.C + 1, PC.E, PC.A].sort((a, b) => a - b)); // A, C#, E sound
    const written = rollChroma(e, 2);
    expect(topBins(written, 3)).toEqual([PC.D, PC.G, PC.B]);
    expect(matchChord(compressChroma(written), buildTemplates()).best?.name).toBe('G');
  });
});

describe('templates', () => {
  const templates = buildTemplates();

  it('buildTemplates: 84 unique sharp-named templates, L2 = 1, pcs from chordPitchClasses', () => {
    expect(templates).toHaveLength(84);
    expect(new Set(templates.map((t) => t.name)).size).toBe(84);
    for (const name of ['C', 'F#m', 'A#7', 'Dsus4', 'Gmaj7', 'Bm7', 'C#sus2']) {
      expect(templates.map((t) => t.name)).toContain(name);
    }
    expect(templates.map((t) => t.name)).not.toContain('Bb');
    for (const t of templates) {
      expect(l2(t.vector)).toBeCloseTo(1, 5);
      expect(TEMPLATE_QUALITIES).toContain(t.quality);
      expect(t.root).toBe(pitchClassOf(t.name.replace(/[^A-G#].*$/, '')));
      expect(t.pcs).toEqual(chordPitchClasses(parseChordSymbol(t.name)!));
      for (let i = 0; i < 12; i++) expect(t.vector[i]).toBeGreaterThanOrEqual(0);
    }
    const g7 = templates.find((t) => t.name === 'G7')!;
    expect(g7.pcs).toEqual([2, 5, 7, 11]);
    expect(g7.root).toBe(7);
    expect(g7.quality).toBe('7');
  });

  it('templateForPitchClasses: energy-domain harmonics 1..6 then the same compression path', () => {
    const t = templateForPitchClasses([0], 'C5?', 0, '5');
    // root: h1 + h2 + h4; fifth (pc 7): h3 + h6; major third (pc 4): h5; the rest 0.
    const energy = new Float32Array(12);
    energy[0] = 1 + 0.36 + Math.pow(0.6, 6);
    energy[7] = Math.pow(0.6, 4) + Math.pow(0.6, 10);
    energy[4] = Math.pow(0.6, 8);
    const expected = compressChroma(energy);
    for (let i = 0; i < 12; i++) expect(t.vector[i]).toBeCloseTo(expected[i], 6);
    expect(t.vector[0]).toBeGreaterThan(t.vector[7]);
    expect(t.vector[7]).toBeGreaterThan(t.vector[4]);
    expect(t.vector[1]).toBe(0);
    expect(t.name).toBe('C5?');
    expect(t.root).toBe(0);
    expect(t.quality).toBe('5');
  });

  it('templateForPitchClasses normalises pcs (unique, ascending, mod 12) and matches buildTemplates', () => {
    const t = templateForPitchClasses([7, 0, 4, 16, -5], 'C/G', 0, 'maj');
    expect(t.pcs).toEqual([0, 4, 7]);
    const c = templates.find((x) => x.name === 'C')!;
    for (let i = 0; i < 12; i++) expect(t.vector[i]).toBeCloseTo(c.vector[i], 6);
  });

  it('major and minor templates of the same root are distinguishable', () => {
    const a = templates.find((t) => t.name === 'A')!;
    const am = templates.find((t) => t.name === 'Am')!;
    expect(cosine(a.vector, am.vector)).toBeLessThan(0.9);
    expect(cosine(a.vector, a.vector)).toBeCloseTo(1, 6);
  });
});

describe('cosine / matchChord / mergeExpectedTemplate', () => {
  const templates = buildTemplates();

  it('cosine is never NaN and handles null vectors', () => {
    const z = new Float32Array(12);
    const v = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cosine(z, z)).toBe(0);
    expect(cosine(z, v)).toBe(0);
    expect(cosine(v, z)).toBe(0);
    expect(cosine(v, v)).toBeCloseTo(1, 9);
    const w = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cosine(v, w)).toBe(0);
    expect(cosine(v, scaled(v, 42))).toBeCloseTo(1, 6);
    expect(Number.isNaN(cosine(z, z))).toBe(false);
  });

  it('matchChord: null chroma -> best null, score 0, ranked []', () => {
    const m = matchChord(new Float32Array(12), templates);
    expect(m.best).toBeNull();
    expect(m.score).toBe(0);
    expect(m.ranked).toEqual([]);
    expect(matchChord(new Float32Array(12).fill(1), []).best).toBeNull();
  });

  it('matchChord: a template vector matches itself first, ranked is sorted descending', () => {
    const dm7 = templates.find((t) => t.name === 'Dm7')!;
    const m = matchChord(dm7.vector, templates);
    expect(m.best).toBe(dm7);
    expect(m.score).toBeCloseTo(1, 5);
    expect(m.ranked).toHaveLength(84);
    expect(m.ranked[0]).toEqual({ name: 'Dm7', score: m.score });
    for (let i = 1; i < m.ranked.length; i++) expect(m.ranked[i].score).toBeLessThanOrEqual(m.ranked[i - 1].score);
  });

  it('samePitchClasses compares sets', () => {
    expect(samePitchClasses([0, 4, 7], [0, 4, 7])).toBe(true);
    expect(samePitchClasses([0, 4, 7], [0, 4])).toBe(false);
    expect(samePitchClasses([0, 3, 7], [0, 4, 7])).toBe(false);
  });

  it('mergeExpectedTemplate replaces the entry with the same pcs set', () => {
    const cg = templateForPitchClasses(shapePitchClasses(libraryShape('C/G')), 'C/G', 0, 'maj');
    const merged = mergeExpectedTemplate(templates, cg);
    expect(merged).toHaveLength(84);
    expect(merged.filter((t) => samePitchClasses(t.pcs, [0, 4, 7]))).toHaveLength(1);
    expect(merged.map((t) => t.name)).not.toContain('C');
    expect(merged.indexOf(cg)).toBe(templates.findIndex((t) => t.name === 'C'));
    expect(templates.map((t) => t.name)).toContain('C'); // input untouched
  });

  it('mergeExpectedTemplate appends when no entry has the same pcs set', () => {
    const cadd9: ChordTemplate = templateForPitchClasses(shapePitchClasses(libraryShape('Cadd9')), 'Cadd9', 0, 'add9');
    expect(cadd9.pcs).toEqual([0, 2, 4, 7]);
    const merged = mergeExpectedTemplate(templates, cadd9);
    expect(merged).toHaveLength(85);
    expect(merged[84]).toBe(cadd9);
    expect(templates).toHaveLength(84);
  });

  it('mergeExpectedTemplate collapses every entry sharing the set (Csus2 and Gsus4) into the expected one', () => {
    const csus2 = templates.find((t) => t.name === 'Csus2')!;
    const gsus4 = templates.find((t) => t.name === 'Gsus4')!;
    expect(samePitchClasses(csus2.pcs, gsus4.pcs)).toBe(true);
    const expected = templateForPitchClasses(csus2.pcs, 'Csus2 (voicing)', 0, 'sus2');
    const merged = mergeExpectedTemplate(templates, expected);
    expect(merged).toHaveLength(83);
    expect(merged.filter((t) => samePitchClasses(t.pcs, expected.pcs))).toEqual([expected]);
  });
});
