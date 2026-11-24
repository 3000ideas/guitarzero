import { describe, expect, it } from 'vitest';
import { BUNDLED_SONGS } from '../../src/song/bundled';
import { buildEasySource, easySongId, easyStrumPattern, oneChordPerBar, parseEasyId, sameBeatsRatio } from '../../src/song/easy';
import { parseSong } from '../../src/song/parser';

const SODOMA = BUNDLED_SONGS[0].source;

describe('oneChordPerBar', () => {
  it('fills each bar with the chord that sounds longest; a tie goes to the first', () => {
    const r = oneChordPerBar('tempo: 100\n[A]\nC . G . | C G . . | Am . . F | D . . . |\n');
    expect(r.source).toContain('C . . . | G . . . | Am . . . | D . . . |');
    expect(r.mergedBars).toBe(3);
    expect(r.totalBars).toBe(4);
  });

  it('counts a chord held over from the bar before, and writes the chord at the start of every bar', () => {
    const r = oneChordPerBar('tempo: 100\n[A]\nC . . . | . . . G | . . . . |\n');
    expect(r.source).toContain('C . . . | C . . . | G . . . |');
  });

  it('leaves silent bars alone and turns a pick-up bar into its chord', () => {
    const r = oneChordPerBar('tempo: 100\n[A]\n- . . . | - D . . | N.C. . . . |\n');
    expect(r.source).toContain('- . . . | D . . . | N.C. . . . |');
    expect(r.totalBars).toBe(1);
  });

  it('keeps headers, sections, comments, lyrics and repeats', () => {
    const src = 'title: X\ntempo: 90\n\n# nota\n[Estrofa] x2\nC . G . | Am . . . | x2\n> la letra\n';
    const r = oneChordPerBar(src);
    expect(r.source).toBe('title: X\ntempo: 90\n\n# nota\n[Estrofa] x2\nC . . . | Am . . . | x2\n> la letra\n');
  });
});

describe('easy version', () => {
  const full = parseSong(SODOMA).song;
  const easy = buildEasySource(SODOMA);
  const parsed = parseSong(easy.source);

  it('keeps the structure and timing of the song, with no errors', () => {
    expect(parsed.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(parsed.song.bars).toHaveLength(full.bars.length);
    expect(parsed.song.bars.map((b) => b.section)).toEqual(full.bars.map((b) => b.section));
    expect(parsed.song.tempoSegments).toEqual(full.tempoSegments);
    expect(parsed.song.title).toBe('Sodoma (acústica) (fácil)');
  });

  it('has at most 4 easy chords, one per bar, changing only on beat 1', () => {
    expect(easy.chords.length).toBeLessThanOrEqual(4);
    expect(easy.chords.length).toBeGreaterThan(1);
    for (const bar of parsed.song.bars) {
      expect(bar.chords.filter((c) => c.chord.quality !== 'nc').length).toBeLessThanOrEqual(1);
    }
  });

  it('proposes a capo that turns La mayor into open shapes (G C D Em)', () => {
    expect(easy.capo).toBe(2);
    expect([...easy.chords].sort()).toEqual(['C', 'D', 'Em', 'G']);
  });

  it('strums once per bar by default, on beat 1', () => {
    expect(easy.strum).toBe('D---');
    const perBar = new Map<number, number>();
    for (const e of parsed.song.events) perBar.set(e.barIndex, (perBar.get(e.barIndex) ?? 0) + 1);
    expect(Math.max(...perBar.values())).toBe(1);
  });

  it('says how much of the song still sounds the same', () => {
    expect(easy.sameBeatsRatio).toBeGreaterThan(0.6);
    expect(easy.sameBeatsRatio).toBeLessThan(1);
    expect(sameBeatsRatio(full, full)).toBe(1);
  });

  it('offers more strums per bar and fewer chords', () => {
    expect(buildEasySource(SODOMA, { strum: 'half' }).strum).toBe('D-D-');
    expect(buildEasySource(SODOMA, { strum: 'beat' }).strum).toBe('D-D-D-D-');
    expect(buildEasySource(SODOMA, { maxChords: 3 }).chords).toHaveLength(3);
    expect(easyStrumPattern('bar', 3)).toBe('D--');
  });

  it('a capo version counts as the same chords', () => {
    const r = buildEasySource('tempo: 100\n[A]\nBb . . . | Eb . . . | F . . . | Gm . . . |\n');
    expect(r.capo).toBe(3);
    expect(r.chords).toEqual(['G', 'C', 'D', 'Em']);
    expect(r.sameBeatsRatio).toBe(1);
    expect(r.mergedBars).toBe(0);
  });

  it('drops sevenths without counting them as a change, and survives a song without chords', () => {
    const r = buildEasySource('tempo: 100\n[A]\nCmaj7 . . . | G7 . . . | Am7 . . . | C . . . |\n');
    expect(r.chords).toEqual(['C', 'G', 'Am']);
    expect(r.sameBeatsRatio).toBe(1);
    const empty = buildEasySource('title: Vacía\ntempo: 100\n');
    expect(empty.chords).toEqual([]);
    expect(empty.sameBeatsRatio).toBe(1);
  });

  it('names its copy after the song', () => {
    expect(easySongId('abc')).toBe('abc-facil');
    expect(parseEasyId('abc-facil')).toBe('abc');
    expect(parseEasyId('abc')).toBeNull();
  });
});
