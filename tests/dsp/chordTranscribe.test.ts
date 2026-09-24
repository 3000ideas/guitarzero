import { describe, expect, it } from 'vitest';
import type { ChordTranscription } from '../../src/types';
import {
  buildVocabulary,
  diatonicChordKeys,
  estimateKey,
  keyNameEs,
  transcribeChords,
} from '../../src/dsp/chordTranscribe';
import { silence, synthProgression, tileSignal, whiteNoise, type Progression } from '../helpers/synth';

const SR = 44100;

/** Fraction of transcribed beats whose chord matches the synthesised chord at that time. */
function accuracy(t: ChordTranscription, p: Progression): number {
  if (t.beats.length === 0) return 0;
  let ok = 0;
  for (const b of t.beats) {
    const i = Math.round((b.timeSec - p.beatTimes[0]) / p.periodSec);
    const expected = i >= 0 && i < p.beatChords.length ? p.beatChords[i] : null;
    if (b.chord === expected) ok++;
  }
  return ok / t.beats.length;
}

function describeBeats(t: ChordTranscription): string {
  return t.beats.map((b) => `${b.timeSec.toFixed(2)}:${b.chord ?? 'N'}`).join(' ');
}

function barChords(t: ChordTranscription): Array<Array<[string | null, number]>> {
  return t.bars.map((bar) => bar.chords.map((c) => [c.chord, c.beats] as [string | null, number]));
}

describe('transcribeChords', () => {
  it('C G Am F at 100 BPM, 2 rounds -> 100 +-1 BPM, Do mayor, >= 90 % beats, 8 bars of one chord, downbeat ~0', () => {
    const p = synthProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, beatsPerChord: 4, rounds: 2, noiseDb: -40 });
    const t = transcribeChords(p.signal, SR);
    expect(Math.abs(t.bpm - 100)).toBeLessThanOrEqual(1);
    expect(t.key.name).toBe('Do mayor');
    expect(t.key).toMatchObject({ root: 0, mode: 'major' });
    expect(t.beatsPerBar).toBe(4);
    expect(Math.abs(t.firstDownbeatSec)).toBeLessThanOrEqual(0.1);
    expect(accuracy(t, p), describeBeats(t)).toBeGreaterThanOrEqual(0.9);
    expect(t.bars).toHaveLength(8);
    expect(barChords(t)).toEqual([
      [['C', 4]], [['G', 4]], [['Am', 4]], [['F', 4]],
      [['C', 4]], [['G', 4]], [['Am', 4]], [['F', 4]],
    ]);
    expect(t.bars.map((b) => b.startBeat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(t.beats).toHaveLength(32);
    for (const b of t.beats) {
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1);
    }
    expect(t.confidence).toBeGreaterThan(0);
    expect(t.confidence).toBeLessThanOrEqual(1);
  });

  it('1.5 s of leading silence, Em C G D -> firstDownbeatSec ~1.5 (+-0.1), >= 85 % beats', () => {
    const p = synthProgression(['Em', 'C', 'G', 'D'], SR, { bpm: 100, rounds: 2, leadSec: 1.5, seed: 3 });
    const t = transcribeChords(p.signal, SR);
    expect(Math.abs(t.bpm - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(t.firstDownbeatSec - 1.5)).toBeLessThanOrEqual(0.1);
    expect(accuracy(t, p), describeBeats(t)).toBeGreaterThanOrEqual(0.85);
    expect(t.bars).toHaveLength(8);
    expect(t.bars[0].chords[0].chord).toBe('Em');
    // Sharp spelling, never flats.
    for (const b of t.beats) if (b.chord !== null) expect(b.chord).not.toContain('b');
  });

  it('3/4 with Am F C -> bars of 3 beats, one chord each', () => {
    const p = synthProgression(['Am', 'F', 'C'], SR, { bpm: 100, beatsPerChord: 3, rounds: 2, seed: 5 });
    const t = transcribeChords(p.signal, SR, { beatsPerBar: 3 });
    expect(t.beatsPerBar).toBe(3);
    expect(Math.abs(t.bpm - 100)).toBeLessThanOrEqual(1);
    expect(accuracy(t, p), describeBeats(t)).toBeGreaterThanOrEqual(0.85);
    expect(t.bars).toHaveLength(6);
    for (const bar of t.bars) {
      let beats = 0;
      for (const c of bar.chords) beats += c.beats;
      expect(beats).toBe(3);
    }
    expect(barChords(t)).toEqual([[['Am', 3]], [['F', 3]], [['C', 3]], [['Am', 3]], [['F', 3]], [['C', 3]]]);
    expect(t.bars.map((b) => b.startBeat)).toEqual([0, 3, 6, 9, 12, 15]);
  });

  /** Beats of a transcription that fall on beats of the progression labelled `name`. */
  function beatsLabelled(t: ChordTranscription, p: Progression, name: string) {
    return t.beats.filter((b) => p.beatChords[Math.round((b.timeSec - p.beatTimes[0]) / p.periodSec)] === name);
  }

  it('extended vocabulary: a synthesised G7 (barre voicing) is G7 in at least half of its beats and never another root', () => {
    // 353433: the standard E-shape G7 barre chord (G2 D3 F3 B3 D4 G4), the seventh on a middle string.
    const p = synthProgression(['C', 'G7'], SR, { bpm: 100, rounds: 2, seed: 7, voicings: { G7: [43, 50, 53, 59, 62, 67] } });
    const t = transcribeChords(p.signal, SR, { vocabulary: 'extended' });
    expect(t.key.name).toBe('Do mayor');
    const g7Beats = beatsLabelled(t, p, 'G7');
    expect(g7Beats.length).toBeGreaterThanOrEqual(6);
    for (const b of g7Beats) expect(['G7', 'G'], describeBeats(t)).toContain(b.chord);
    const asG7 = g7Beats.filter((b) => b.chord === 'G7').length;
    expect(asG7, describeBeats(t)).toBeGreaterThanOrEqual(Math.ceil(g7Beats.length / 2));
    expect(barChords(t)).toEqual([[['C', 4]], [['G7', 4]], [['C', 4]], [['G7', 4]]]);
    // The basic vocabulary never names sevenths and hears the G7 as G.
    const basic = transcribeChords(p.signal, SR);
    for (const b of basic.beats) if (b.chord !== null) expect(b.chord).not.toMatch(/7/);
    expect(accuracy(basic, { ...p, beatChords: p.beatChords.map((c) => (c === 'G7' ? 'G' : c)) })).toBeGreaterThanOrEqual(0.85);
  });

  it('extended vocabulary: the open-position library G7 (seventh only on the high e string) is G7 or G, never another root', () => {
    const p = synthProgression(['C', 'G7'], SR, { bpm: 100, rounds: 2, seed: 7 });
    const t = transcribeChords(p.signal, SR, { vocabulary: 'extended' });
    const g7Beats = beatsLabelled(t, p, 'G7');
    expect(g7Beats.length).toBeGreaterThanOrEqual(6);
    for (const b of g7Beats) expect(['G7', 'G'], describeBeats(t)).toContain(b.chord);
    for (const b of beatsLabelled(t, p, 'C')) expect(b.chord, describeBeats(t)).toBe('C');
  });

  it('honours opts.bpm / firstBeatSec and skips the tempo estimation', () => {
    const p = synthProgression(['D', 'A', 'Bm', 'G'], SR, { bpm: 120, rounds: 1, leadSec: 0.8, seed: 9 });
    const t = transcribeChords(p.signal, SR, { bpm: 120, firstBeatSec: 0.8 });
    expect(t.bpm).toBe(120);
    expect(t.firstDownbeatSec).toBeCloseTo(0.8, 6);
    expect(t.beats[1].timeSec).toBeCloseTo(1.3, 6);
    expect(accuracy(t, p), describeBeats(t)).toBeGreaterThanOrEqual(0.9);
    expect(barChords(t)).toEqual([[['D', 4]], [['A', 4]], [['Bm', 4]], [['G', 4]]]);
  });

  it('a silent gap inside the song becomes N.C. beats / bars; trailing silence longer than 2 bars is cut', () => {
    const a = synthProgression(['C', 'G'], SR, { bpm: 100, rounds: 1, seed: 11 });
    const b = synthProgression(['Am', 'F'], SR, { bpm: 100, rounds: 1, seed: 13 });
    // C G | 2 bars of silence | Am F | 6 s of silence (10 beats > 2 bars).
    const gap = 8 * 0.6;
    const signal = new Float32Array(Math.round((a.signal.length / SR + gap + b.signal.length / SR + 6) * SR));
    signal.set(a.signal, 0);
    signal.set(b.signal, Math.round((a.signal.length / SR + gap) * SR));
    const t = transcribeChords(signal, SR, { bpm: 100, firstBeatSec: 0 });
    expect(t.beats, describeBeats(t)).toHaveLength(24);
    expect(t.bars).toHaveLength(6);
    // The 372 ms analysis window straddles the beat boundaries, so the beats right at the edges
    // of the gap may inherit the neighbouring chord; the six inner beats are N.C.
    for (const beat of t.beats.slice(9, 15)) expect(beat.chord, describeBeats(t)).toBeNull();
    expect(barChords(t).slice(0, 2)).toEqual([[['C', 4]], [['G', 4]]]);
    expect(barChords(t).slice(4)).toEqual([[['Am', 4]], [['F', 4]]]);
    expect(t.bars[2].chords.some((c) => c.chord === null && c.beats >= 3)).toBe(true);
    expect(t.bars[3].chords.some((c) => c.chord === null && c.beats >= 3)).toBe(true);
    // 2 bars of trailing silence are kept (they decode as N.C. or as the ringing last chord).
    const short = new Float32Array(Math.round((b.signal.length / SR + 4.8) * SR));
    short.set(b.signal, 0);
    const s = transcribeChords(short, SR, { bpm: 100, firstBeatSec: 0 });
    expect(s.beats).toHaveLength(16);
    expect(s.bars).toHaveLength(4);
  });

  it('silence and noise -> no beats, no bars, confidence 0, never throws', () => {
    const s = transcribeChords(silence(SR, 5), SR);
    expect(s.beats).toEqual([]);
    expect(s.bars).toEqual([]);
    expect(s.confidence).toBe(0);
    expect(s.key.name).toBe('Do mayor');
    expect(transcribeChords(new Float32Array(0), SR).bars).toEqual([]);
    const n = transcribeChords(whiteNoise(SR, 6, -40), SR, { bpm: 100, firstBeatSec: 0 });
    expect(n.bars).toEqual([]);
    expect(n.confidence).toBe(0);
  });

  it('invalid arguments throw RangeError', () => {
    expect(() => transcribeChords(silence(SR, 1), 0)).toThrow(RangeError);
    expect(() => transcribeChords(silence(SR, 1), Number.NaN)).toThrow(RangeError);
    expect(() => transcribeChords(silence(SR, 1), SR, { bpm: 0 })).toThrow(RangeError);
    expect(() => transcribeChords(silence(SR, 1), SR, { firstBeatSec: Number.NaN })).toThrow(RangeError);
  });

  it('onProgress is called with non-decreasing values in 0..1 ending at 1', () => {
    const p = synthProgression(['C', 'G'], SR, { bpm: 100, rounds: 1, seed: 15 });
    const values: number[] = [];
    transcribeChords(p.signal, SR, { onProgress: (v) => values.push(v) });
    expect(values.length).toBeGreaterThan(5);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('performance: 4 minutes at 44.1 kHz in under 3 s', () => {
    const p = synthProgression(['G', 'D', 'Em', 'C'], SR, { bpm: 100, rounds: 1, seed: 17 }); // 9.6 s
    const signal = tileSignal(p.signal, 25); // 240 s
    // About 1 s on an idle machine. Test files run in parallel workers, so a run slowed down by
    // other processes is retried (up to 3 attempts); every attempt is measured against the 3 s.
    const timings: number[] = [];
    let t: ChordTranscription | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      t = transcribeChords(signal, SR);
      timings.push(performance.now() - t0);
      if (timings[attempt] < 3000) break;
    }
    expect(Math.min(...timings), `timings ms: ${timings.map((ms) => ms.toFixed(0)).join(', ')}`).toBeLessThan(3000);
    expect(Math.abs(t!.bpm - 100)).toBeLessThanOrEqual(1);
    expect(t!.bars.length).toBeGreaterThanOrEqual(99);
    expect(t!.bars.length).toBeLessThanOrEqual(100);
    expect(t!.key.name).toMatch(/^(Sol mayor|Mi menor)$/);
  }, 60000);
});

describe('estimateKey / keyNameEs / vocabulary', () => {
  it('keyNameEs uses Spanish names with sharps', () => {
    expect(keyNameEs(0, 'major')).toBe('Do mayor');
    expect(keyNameEs(9, 'minor')).toBe('La menor');
    expect(keyNameEs(6, 'minor')).toBe('Fa# menor');
    expect(keyNameEs(10, 'major')).toBe('La# mayor');
    expect(keyNameEs(7, 'major')).toBe('Sol mayor');
    expect(keyNameEs(-1, 'major')).toBe('Si mayor');
  });

  it('estimateKey recovers the key of a Krumhansl profile in any rotation and mode', () => {
    const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    for (let r = 0; r < 12; r++) {
      const maj = new Float32Array(12);
      const min = new Float32Array(12);
      for (let pc = 0; pc < 12; pc++) {
        maj[pc] = major[(((pc - r) % 12) + 12) % 12];
        min[pc] = minor[(((pc - r) % 12) + 12) % 12];
      }
      expect(estimateKey(maj)).toEqual({ root: r, mode: 'major', name: keyNameEs(r, 'major') });
      expect(estimateKey(min)).toEqual({ root: r, mode: 'minor', name: keyNameEs(r, 'minor') });
    }
    expect(estimateKey(new Float32Array(12))).toEqual({ root: 0, mode: 'major', name: 'Do mayor' });
  });

  it('diatonicChordKeys: C major and A minor', () => {
    expect([...diatonicChordKeys({ root: 0, mode: 'major' })].sort()).toEqual(
      ['0:maj', '2:min', '4:min', '5:maj', '7:maj', '9:min', '7:7'].sort(),
    );
    expect([...diatonicChordKeys({ root: 9, mode: 'minor' })].sort()).toEqual(
      ['9:min', '0:maj', '2:min', '4:min', '4:maj', '5:maj', '7:maj', '4:7'].sort(),
    );
  });

  it('buildVocabulary: 24 basic / 60 extended templates with sharp names', () => {
    const basic = buildVocabulary('basic');
    expect(basic).toHaveLength(24);
    expect(new Set(basic.map((t) => t.name)).size).toBe(24);
    expect(basic.map((t) => t.name)).toContain('F#m');
    expect(basic.map((t) => t.name)).not.toContain('Gbm');
    const ext = buildVocabulary('extended');
    expect(ext).toHaveLength(60);
    expect(ext.map((t) => t.name)).toEqual(expect.arrayContaining(['G7', 'Am7', 'Cmaj7', 'A#7']));
    for (const t of ext) expect(t.vector).toHaveLength(12);
  });
});
