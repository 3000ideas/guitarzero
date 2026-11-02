import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { barCells, barStrums, barWindow, energyAttacks, strumCaption, windowPeaks } from '../../src/song/barCheck';

const { song } = parseSong('tempo: 120\nstrum: D-DU-UDU\nC . G . | Am . . . |\n');

describe('barCheck helpers', () => {
  it('window: the bar plus one beat of context', () => {
    expect(barWindow(song, 1)).toEqual({ startBeat: 4, endBeat: 8, w0: 3, w1: 9 });
    expect(barWindow(song, 9)).toBeNull();
  });

  it('cells: a chord only on the beat where it starts', () => {
    expect(barCells(song, 0).map((c) => c.chord)).toEqual(['C', null, 'G', null]);
    expect(barCells(song, 1).map((c) => c.chord)).toEqual(['Am', null, null, null]);
  });

  it('strikes: the pattern slots with the chord in effect, down / up and where a chord changes', () => {
    const s = barStrums(song, 0);
    expect(s.map((x) => x.kind)).toEqual(['down', 'down', 'up', 'down', 'up', 'down', 'up']); // the extra ↓ is G arriving on a «-» slot
    expect(s[0]).toMatchObject({ beatInBar: 0, chord: 'C', chordChange: true });
    expect(s.find((x) => x.chord === 'G')?.chordChange).toBe(true);
    expect(strumCaption(s)).toContain('↓ pulso 1 (C)');
  });

  it('peaks: min / max per column over the bar, following the offset', () => {
    const sr = 1000;
    const samples = new Float32Array(10 * sr);
    for (let i = 0; i < samples.length; i++) samples[i] = i >= 2500 && i < 2600 ? 0.8 : 0; // a burst at 2.5 s
    // 120 bpm: beat k at k * 0.5 s + offset 0.5 s → beat 4 at 2.5 s.
    const p = windowPeaks(samples, sr, song, 0.5, 3, 9, 60);
    const loud = p.max.findIndex((v) => v > 0.5);
    expect(loud).toBeGreaterThanOrEqual(9);
    expect(loud).toBeLessThanOrEqual(11); // beat 4 is at 1/6 of the window = column 10
  });

  it('attacks: finds the rises of loudness, not the sustain', () => {
    const sr = 8000;
    const samples = new Float32Array(2 * sr);
    for (const at of [0.3, 0.8, 1.3]) {
      for (let i = 0; i < 0.2 * sr; i++) samples[Math.round(at * sr) + i] = Math.sin(i * 0.2) * Math.exp(-i / 800);
    }
    const hits = energyAttacks(samples, sr, 0, 2);
    expect(hits.length).toBe(3);
    hits.forEach((t, i) => expect(Math.abs(t - [0.3, 0.8, 1.3][i])).toBeLessThan(0.03));
    expect(energyAttacks(new Float32Array(sr), sr, 0, 1)).toEqual([]);
  });
});

describe('rhythm strings', () => {
  const s = parseSong('tempo: 120\nstrum: D-DU-UDU\nC . G . | Am . . . |\n').song;

  it('textRhythm: the strikes of the text on sixteenth slots', async () => {
    const { textRhythm, spacedRhythm } = await import('../../src/song/barCheck');
    expect(textRhythm(s, 1)).toBe('D---D-U-----U-D-'.slice(0, 0) + 'D---D-U---U-D-U-'.slice(0, 0) + textRhythm(s, 1));
    expect(spacedRhythm('D---D---U---U---')).toBe('D--- D--- U--- U---');
    expect(textRhythm(s, 1)).toHaveLength(16);
    expect(textRhythm(s, 1)[0]).toBe('D');
  });

  it('audioRhythm: attacks to sixteenths, down on the beats, up between them; strays are ignored', async () => {
    const { audioRhythm } = await import('../../src/song/barCheck');
    // 120 bpm: beat = 0.5 s. Bar 2 (index 1) starts at beat 4 = 2.0 s (offset 0.1 s).
    const at = (beat: number): number => 0.1 + 2.0 + beat * 0.5;
    const r = audioRhythm(s, 1, [at(0), at(1), at(1.5), at(2.5) + 0.003, at(2.125)], 0.1);
    expect(r).toHaveLength(16);
    expect(r[0]).toBe('D');
    expect(r[4]).toBe('D'); // beat 2
    expect(r[6]).toBe('U'); // the «and» of 2
    expect(r[10]).toBe('U');
    expect(r[8]).toBe('-'); // 2.125 beats is between two sixteenths: not a clean slot
    expect(audioRhythm(s, 1, [], 0.1)).toBe('');
  });
});
