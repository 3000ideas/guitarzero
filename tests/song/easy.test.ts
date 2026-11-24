import { describe, expect, it } from 'vitest';
import { BUNDLED_SONGS } from '../../src/song/bundled';
import { buildEasySource, relativeMajorsForHardMinors, easySongId, easyStrumPattern, oneChordPerBar, parseEasyId, quietBeats, restQuietBeats, sameBeatsRatio } from '../../src/song/easy';
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

describe('oneChordPerBar with two changes per bar', () => {
  it('lets the chord change on beat 3 and nowhere else', () => {
    const r = oneChordPerBar('tempo: 100\n[A]\nC . G . | C G . . | Am . . F | D . . . | - D . . |\n', 2);
    expect(r.source).toContain('C . G . | C . G . | Am . . . | D . . . | D . . . |');
    expect(r.mergedBars).toBe(1);
  });

  it('does not split a 3/4 bar', () => {
    expect(oneChordPerBar('tempo: 100\ntime: 3/4\n[A]\nC . G | Am . . |\n', 2).source).toContain('C . . | Am . . |');
  });
});

describe('easy version', () => {
  const full = parseSong(SODOMA).song;
  const easy = buildEasySource(SODOMA, { changesPerBar: 1, strum: 'bar', maxChords: 4, capo: true });
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

  it('with one change per bar it can strum once per bar, on beat 1', () => {
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
    expect(buildEasySource(SODOMA).strum).toBe('D-D-D-D-');
    expect(buildEasySource(SODOMA, { maxChords: 3, capo: true }).chords).toHaveLength(3);
    expect(easyStrumPattern('bar', 3)).toBe('D--');
  });

  it('by default the chord may change on beats 1 and 3, with a strum on each, and it stays closer to the song', () => {
    const two = buildEasySource(SODOMA, { capo: true });
    expect(two.strum).toBe('D-D-D-D-');
    expect(buildEasySource(SODOMA, { strum: 'bar' }).strum).toBe('D-D-');
    expect(two.sameBeatsRatio).toBeGreaterThan(0.9);
    expect(two.sameBeatsRatio).toBeGreaterThan(easy.sameBeatsRatio);
    expect([...two.chords].sort()).toEqual(['Am', 'C', 'D', 'Em', 'G']); // Am is the Si menor of the song, with the capo on 2
    expect(two.capo).toBe(2);
    for (const bar of parseSong(two.source).song.bars) {
      for (const c of bar.chords) expect([0, 2]).toContain(Math.round(c.startBeat - bar.startBeat));
    }
  });

  it('a capo version counts as the same chords', () => {
    const r = buildEasySource('tempo: 100\n[A]\nBb . . . | Eb . . . | F . . . | Gm . . . |\n', { capo: true });
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

describe('rests where the recording goes quiet', () => {
  const src = 'tempo: 120\n[A]\nC . . . | G . . . | Am . . . |\n';
  const q = (...on: number[]): boolean[] => Array.from({ length: 12 }, (_, i) => on.includes(i));

  it('writes a rest on the quiet beats and the chord again when the music comes back', () => {
    const r = restQuietBeats(src, q(2, 3, 4, 9));
    expect(r.source).toContain('C . - . | . G . . | Am - Am . |');
    expect(r.rests).toBe(4);
    const { song, errors } = parseSong(r.source);
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(song.totalBeats).toBe(12);
  });

  it('leaves the text alone when nothing is quiet, or when the beats of the text are not the beats of the song', () => {
    expect(restQuietBeats(src, q()).source).toBe(src);
    expect(restQuietBeats('tempo: 120\n[A]\nC . . . | G . . . | x2\n', Array.from({ length: 16 }, () => true)).rests).toBe(0);
    expect(restQuietBeats(src, [true]).rests).toBe(0);
  });

  it('finds the quiet beats of a recording', () => {
    const song = parseSong(src).song; // 120 bpm: a beat lasts 0.5 s
    const sr = 8000;
    const samples = new Float32Array(sr * 6);
    for (let i = 0; i < samples.length; i++) {
      const beat = Math.floor(i / (sr / 2));
      samples[i] = (beat === 5 || beat === 6 ? 0.01 : 0.5) * Math.sin((2 * Math.PI * 220 * i) / sr);
    }
    expect(quietBeats(samples, sr, song, 0)).toEqual(q(5, 6));
    expect(quietBeats(new Float32Array(sr * 6), sr, song, 0)).toEqual(q());
  });

  it('two beats in a row where nothing is struck (the chord just rings on) are quiet, even if still loud; a single one is not', () => {
    const song = parseSong(src).song;
    const sr = 8000;
    const samples = new Float32Array(sr * 6);
    let seed = 7;
    const noise = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    // A slowly decaying tone struck (with a bright burst) on every beat except beats 3, 4 and 8: there it rings on.
    let struckAt = 0;
    for (let i = 0; i < samples.length; i++) {
      const beat = Math.floor(i / (sr / 2));
      if (i % (sr / 2) === 0 && beat !== 3 && beat !== 4 && beat !== 8) struckAt = i;
      const t = (i - struckAt) / sr;
      samples[i] = 0.5 * Math.exp(-0.8 * t) * Math.sin((2 * Math.PI * 220 * i) / sr) + (t < 0.02 ? 0.3 * noise() : 0);
    }
    expect(quietBeats(samples, sr, song, 0)).toEqual(q(3, 4));
  });

  it('the easy version does not strum on the quiet beats', () => {
    const r = buildEasySource(src, { quiet: q(2, 3) });
    expect(r.rests).toBe(2);
    expect(parseSong(r.source).song.events.map((e) => e.time)).toEqual([0, 1, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe('easy version without a capo (the default)', () => {
  it('never asks for a capo: barre minors become their relative major (F#m → A, Bm → D)', () => {
    const r = buildEasySource(SODOMA);
    expect(r.capo).toBe(0);
    expect([...r.chords].sort()).toEqual(['A', 'D', 'E']);
    expect(parseSong(r.source).errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(r.sameBeatsRatio).toBeGreaterThan(0.7);
  });

  it('a song written with a capo is rewritten as it sounds, with no capo', () => {
    const r = buildEasySource('tempo: 100\ncapo: 2\n[A]\nC . . . | G . . . | D . . . | Em . . . |\n');
    expect(r.capo).toBe(0);
    expect(r.chords).toEqual(['D', 'A', 'E']); // C G D Em with the capo on 2 sound D A E F#m; F#m → A
    expect(r.source).toContain('D . . . | A . . . | E . . . | A . . . |');
  });

  it('only swaps minors that need a barre and whose relative major is easy', () => {
    expect(relativeMajorsForHardMinors('tempo: 100\n[A]\nF#m . Bm . | Am . Em . | Cm . G#m . |\n')).toContain('A . D . | Am . Em . | Cm . G#m . |');
  });
});
