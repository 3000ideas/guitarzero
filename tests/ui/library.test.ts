import { describe, expect, it } from 'vitest';
import {
  UNTITLED,
  barCountText,
  chordCountText,
  displayTitle,
  formatTimeSignature,
  formatUpdatedAt,
  libraryScreen,
  songMeta,
} from '../../src/ui/screens/library';
import { EXAMPLE_SONGS } from '../../src/song/examples';
import { parseSong } from '../../src/song/parser';
import { songDurationSec } from '../../src/song/tempo';
import type { StoredSong } from '../../src/types';

function stored(source: string, extra: Partial<StoredSong> = {}): StoredSong {
  return { id: 's_test', title: 'Guardada', artist: 'Alguien', source, updatedAt: 1000, ...extra };
}

function example(id: string): StoredSong {
  const ex = EXAMPLE_SONGS.find((s) => s.id === id);
  if (!ex) throw new Error(`missing example ${id}`);
  return ex;
}

describe('songMeta', () => {
  it('reports tempo, time signature, chords, bars and duration of an example', () => {
    const pop = example('ex:pop-c-g-am-f');
    const meta = songMeta(pop);
    const { song } = parseSong(pop.source, { id: pop.id });
    expect(meta.id).toBe('ex:pop-c-g-am-f');
    expect(meta.builtin).toBe(true);
    expect(meta.title).toBe(song.title);
    expect(meta.tempo).toBe(100);
    expect(meta.timeSignature).toBe('4/4');
    expect(meta.chordNames).toEqual(['C', 'G', 'Am', 'F']);
    expect(meta.chordCount).toBe(4);
    expect(meta.bars).toBe(song.bars.length);
    expect(meta.durationSec).toBeCloseTo(songDurationSec(song), 6);
    expect(Math.round(meta.durationSec)).toBe(106);
    expect(meta.errors).toBe(0);
    expect(meta.warnings).toBe(0);
  });

  it('excludes N.C. and rests from the chord count', () => {
    const meta = songMeta(example('ex:blues-en-a'));
    expect(meta.chordNames).toEqual(['A7', 'E7', 'D7']);
    expect(meta.chordCount).toBe(3);
  });

  it('uses the initial time signature of a 3/4 song', () => {
    const meta = songMeta(example('ex:cielito-lindo'));
    expect(meta.timeSignature).toBe('3/4');
    expect(meta.tempo).toBe(140);
  });

  it('counts errors and warnings separately', () => {
    const meta = songMeta(stored('title: Rota\ntempo: 999\n\nC G Am | G . . . |'));
    // tempo out of range -> error; the bar "C G Am" cannot be split evenly -> error
    expect(meta.errors).toBe(2);
    expect(meta.bars).toBe(1);
    const warned = songMeta(stored('C . . . |'));
    expect(warned.warnings).toBe(1); // tempo not given -> 80 with a warning
    expect(warned.errors).toBe(0);
    expect(warned.tempo).toBe(80);
  });

  it('falls back to the stored title and artist and reports zero duration without bars', () => {
    const meta = songMeta(stored('tempo: 90\n# nada más'));
    expect(meta.title).toBe('Guardada');
    expect(meta.artist).toBe('Alguien');
    expect(meta.bars).toBe(0);
    expect(meta.durationSec).toBe(0);
    expect(meta.chordCount).toBe(0);
    expect(meta.builtin).toBe(false);
    expect(meta.updatedAt).toBe(1000);
  });

  it('prefers the parsed title over the stored one', () => {
    const meta = songMeta(stored('title: Del texto\ntempo: 80\nC . . . |'));
    expect(meta.title).toBe('Del texto');
  });

  it('never throws on garbage', () => {
    expect(() => songMeta(stored('|||| ??? *** [ x0'))).not.toThrow();
    expect(() => songMeta(stored(''))).not.toThrow();
  });

  it('handles every bundled example', () => {
    for (const ex of EXAMPLE_SONGS) {
      const meta = songMeta(ex);
      expect(meta.builtin).toBe(true);
      expect(meta.errors).toBe(0);
      expect(meta.warnings).toBe(0);
      expect(meta.bars).toBeGreaterThan(0);
      expect(meta.durationSec).toBeGreaterThan(0);
      expect(meta.chordCount).toBeGreaterThan(0);
    }
  });
});

describe('formatting helpers', () => {
  it('formatTimeSignature', () => {
    expect(formatTimeSignature({ beatsPerBar: 4, beatUnit: 4 })).toBe('4/4');
    expect(formatTimeSignature({ beatsPerBar: 6, beatUnit: 8 })).toBe('6/8');
  });

  it('displayTitle falls back to "Sin título"', () => {
    expect(displayTitle('  Hola ')).toBe('Hola');
    expect(displayTitle('')).toBe(UNTITLED);
    expect(displayTitle('   ')).toBe('Sin título');
  });

  it('pluralises counters in Spanish', () => {
    expect(chordCountText(1)).toBe('1 acorde');
    expect(chordCountText(0)).toBe('0 acordes');
    expect(chordCountText(5)).toBe('5 acordes');
    expect(barCountText(1)).toBe('1 compás');
    expect(barCountText(12)).toBe('12 compases');
  });

  it('formatUpdatedAt gives relative Spanish text and falls back to a date', () => {
    const now = Date.UTC(2025, 5, 15, 12, 0, 0);
    expect(formatUpdatedAt(0, now)).toBe('');
    expect(formatUpdatedAt(NaN, now)).toBe('');
    expect(formatUpdatedAt(now - 10_000, now)).toBe('hace un momento');
    expect(formatUpdatedAt(now - 5 * 60_000, now)).toBe('hace 5 min');
    expect(formatUpdatedAt(now - 3600_000, now)).toBe('hace 1 hora');
    expect(formatUpdatedAt(now - 5 * 3600_000, now)).toBe('hace 5 horas');
    expect(formatUpdatedAt(now - 86400_000, now)).toBe('ayer');
    expect(formatUpdatedAt(now - 3 * 86400_000, now)).toBe('hace 3 días');
    expect(formatUpdatedAt(now - 30 * 86400_000, now)).toMatch(/2025/);
  });
});

describe('libraryScreen', () => {
  it('is a Screen object', () => {
    expect(typeof libraryScreen.mount).toBe('function');
  });
});
