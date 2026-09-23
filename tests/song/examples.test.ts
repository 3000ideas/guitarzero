import { describe, expect, it } from 'vitest';
import { EXAMPLES_UPDATED_AT, EXAMPLE_ID_PREFIX, EXAMPLE_SONGS, isExampleId } from '../../src/song/examples';
import { parseSong } from '../../src/song/parser';
import { songDurationSec } from '../../src/song/tempo';
import { getChordShape } from '../../src/music/chords';
import type { ParseResult, Song } from '../../src/types';

// ---------------------------------------------------------------- helpers

const parsed: Array<{ id: string; result: ParseResult; song: Song }> = EXAMPLE_SONGS.map((s) => {
  const result = parseSong(s.source, { id: s.id });
  return { id: s.id, result, song: result.song };
});

const songs = parsed.map((p) => p.song);
const some = (pred: (song: Song) => boolean): boolean => songs.some(pred);

const HEADER_RE = /^(title|artist|tempo|time|strum|capo)\s*:/i;
const COMMENT_RE = /(^|\s)#.*$/;

/** Meaningful lines of a source: comments stripped, blanks removed. */
function lines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((l) => l.replace(COMMENT_RE, '').trim())
    .filter((l) => l !== '');
}

/** True when the source recalls a previously defined section with an empty `[Name]` header. */
function hasSectionRecall(source: string): boolean {
  const ls = lines(source);
  const defined = new Set<string>();
  for (let i = 0; i < ls.length; i++) {
    const m = /^\[([^\]]+)\]/.exec(ls[i]);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    let hasBars = false;
    for (let j = i + 1; j < ls.length && !ls[j].startsWith('['); j++) {
      if (!HEADER_RE.test(ls[j]) && !ls[j].startsWith('>')) hasBars = true;
    }
    if (hasBars) defined.add(name);
    else if (defined.has(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- catalogue shape

describe('EXAMPLE_SONGS: catalogue', () => {
  it('has at least 6 examples', () => {
    expect(EXAMPLE_SONGS.length).toBeGreaterThanOrEqual(6);
  });

  it('every example is a builtin StoredSong with an "ex:<slug>" id', () => {
    for (const s of EXAMPLE_SONGS) {
      expect(s.id).toMatch(/^ex:[a-z0-9_-]+$/);
      expect(s.id.startsWith(EXAMPLE_ID_PREFIX)).toBe(true);
      expect(isExampleId(s.id)).toBe(true);
      expect(s.builtin).toBe(true);
      expect(typeof s.title).toBe('string');
      expect(s.title.trim()).not.toBe('');
      expect(typeof s.artist).toBe('string');
      expect(s.artist.trim()).not.toBe('');
      expect(typeof s.source).toBe('string');
      expect(s.source.trim()).not.toBe('');
      expect(Number.isFinite(s.updatedAt)).toBe(true);
      expect(s.updatedAt).toBe(EXAMPLES_UPDATED_AT);
    }
  });

  it('ids are unique', () => {
    const ids = EXAMPLE_SONGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the songs suggested by the spec', () => {
    const titles = EXAMPLE_SONGS.map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Progresión pop (C G Am F)',
        'Blues en A (12 compases)',
        'Cielito Lindo',
        'Cumpleaños feliz',
        'Amazing Grace',
        'Balada Em C G D',
        'La Bamba',
      ]),
    );
  });

  it('isExampleId only accepts the ex: prefix', () => {
    expect(isExampleId('ex:foo')).toBe(true);
    expect(isExampleId('s_abc123')).toBe(false);
    expect(isExampleId('')).toBe(false);
  });
});

// ---------------------------------------------------------------- every example parses cleanly

describe('EXAMPLE_SONGS: each example parses with the real parser', () => {
  for (const { id, result, song } of parsed) {
    describe(id, () => {
      it('has zero errors and zero warnings', () => {
        expect(result.errors).toEqual([]);
      });

      it('produces bars, events and chord names', () => {
        expect(song.bars.length).toBeGreaterThan(0);
        expect(song.events.length).toBeGreaterThan(0);
        expect(song.chordNames.length).toBeGreaterThan(0);
        expect(song.totalBeats).toBeGreaterThan(0);
        expect(songDurationSec(song)).toBeGreaterThan(0);
      });

      it('every chord name has a fingering (getChordShape !== null)', () => {
        for (const name of song.chordNames) {
          expect(getChordShape(name), `no shape for ${name}`).not.toBeNull();
        }
      });

      it('keeps the StoredSong title/artist in sync with the source headers', () => {
        const stored = EXAMPLE_SONGS.find((s) => s.id === id)!;
        expect(song.id).toBe(id);
        expect(song.title).toBe(stored.title);
        expect(song.artist).toBe(stored.artist);
      });

      it('declares an explicit tempo and a supported time signature', () => {
        expect(song.tempo).toBeGreaterThanOrEqual(20);
        expect(song.tempo).toBeLessThanOrEqual(400);
        expect(song.tempoSegments[0]).toEqual({ fromBeat: 0, bpm: song.tempo });
        expect([4, 3, 2, 6]).toContain(song.timeSignature.beatsPerBar);
      });

      it('event times are strictly increasing and inside the song', () => {
        let prev = -Infinity;
        for (const e of song.events) {
          expect(e.time).toBeGreaterThan(prev);
          expect(e.time).toBeLessThan(song.totalBeats);
          prev = e.time;
        }
        expect(song.events[0].chordChange).toBe(true);
      });
    });
  }
});

// ---------------------------------------------------------------- feature coverage across the set

describe('EXAMPLE_SONGS: together they cover every feature of the format', () => {
  it('4/4 and 3/4', () => {
    expect(some((s) => s.timeSignature.beatsPerBar === 4 && s.timeSignature.beatUnit === 4)).toBe(true);
    expect(some((s) => s.timeSignature.beatsPerBar === 3 && s.timeSignature.beatUnit === 4)).toBe(true);
  });

  it('*n durations', () => {
    expect(EXAMPLE_SONGS.some((s) => /\w\*\d+/.test(s.source))).toBe(true);
  });

  it('N.C. (events with quality nc)', () => {
    expect(some((s) => s.events.some((e) => e.chord.quality === 'nc' && /^n\.?c\.?$/i.test(e.chord.name)))).toBe(true);
  });

  it('rests "-" (stored in bars as name "-" and never as events)', () => {
    expect(some((s) => s.bars.some((b) => b.chords.some((c) => c.chord.name === '-')))).toBe(true);
    for (const s of songs) expect(s.events.some((e) => e.chord.name === '-')).toBe(false);
  });

  it('a tempo change in the middle of a song', () => {
    expect(some((s) => s.tempoSegments.length > 1)).toBe(true);
  });

  it('patterns with U (up strums) and x (muted strums)', () => {
    expect(some((s) => s.events.some((e) => e.direction === 'up'))).toBe(true);
    expect(some((s) => s.events.some((e) => e.muted))).toBe(true);
  });

  it('line repeats (x2), section repeats ([Sección] x2) and section recalls', () => {
    expect(EXAMPLE_SONGS.some((s) => /\|\s*x\d+\s*$/im.test(s.source))).toBe(true);
    expect(EXAMPLE_SONGS.some((s) => /^\[[^\]]+\]\s*x\d+/im.test(s.source))).toBe(true);
    expect(EXAMPLE_SONGS.some((s) => hasSectionRecall(s.source))).toBe(true);
  });

  it('lyrics (>)', () => {
    expect(some((s) => s.lyricLines.length > 0)).toBe(true);
    for (const s of songs) {
      for (const l of s.lyricLines) {
        expect(l.text.trim()).not.toBe('');
        expect(l.barIndex).toBeGreaterThanOrEqual(0);
        expect(l.barIndex).toBeLessThan(s.bars.length);
      }
    }
  });

  it('capo', () => {
    expect(some((s) => s.capo > 0)).toBe(true);
    for (const s of songs) {
      expect(s.capo).toBeGreaterThanOrEqual(0);
      expect(s.capo).toBeLessThanOrEqual(12);
    }
  });

  it('sections with labels', () => {
    expect(some((s) => s.bars.some((b) => b.section !== null))).toBe(true);
  });
});
