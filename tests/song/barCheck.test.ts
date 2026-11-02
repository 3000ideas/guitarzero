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
