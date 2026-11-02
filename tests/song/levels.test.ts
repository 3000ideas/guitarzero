import { describe, expect, it } from 'vitest';
import { BUNDLED_SONGS } from '../../src/song/bundled';
import { LEVELS, buildLevelSource, levelSongId } from '../../src/song/levels';
import { parseSong } from '../../src/song/parser';

const SODOMA = BUNDLED_SONGS[0].source;

describe('learning levels', () => {
  const original = parseSong(SODOMA).song;

  it.each(LEVELS.map((l) => [l.n, l]))('level %i keeps the structure and timing of the song, with no errors', (_n, level) => {
    const { source, chords } = buildLevelSource(SODOMA, level, `Sodoma · Nivel ${level.n}`);
    const { song, errors } = parseSong(source);
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(song.bars).toHaveLength(original.bars.length);
    expect(song.bars.map((b) => b.section)).toEqual(original.bars.map((b) => b.section));
    expect(song.tempoSegments).toEqual(original.tempoSegments);
    expect(song.title).toBe(`Sodoma · Nivel ${level.n}`);
    if (level.maxChords !== null) expect(song.chordNames.length).toBeLessThanOrEqual(level.maxChords);
    expect(chords.length).toBeGreaterThan(0);
  });

  it('each level asks for fewer chords and a simpler strum than the next', () => {
    const counts = LEVELS.map((l) => parseSong(buildLevelSource(SODOMA, l, 'x').source).song.chordNames.length);
    expect(counts.slice(1)).toEqual([...counts.slice(1)].sort((a, b) => a - b));
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(3);
    expect(counts[3]).toBe(4);
    const events = LEVELS.map((l) => parseSong(buildLevelSource(SODOMA, l, 'x').source).song.events.length);
    expect(events[1]).toBeLessThan(events[2]);
    expect(events[2]).toBeLessThan(events[3]);
  });

  it('level 1 is only muted strikes on the beat (timing, not chords)', () => {
    const { song } = parseSong(buildLevelSource(SODOMA, LEVELS[0], 'x').source);
    expect(song.events.every((e) => e.muted)).toBe(true);
    expect(song.events.length).toBe(original.bars.length * 4 - 1); // the rest on beat 1 of the pick-up bar makes no strike
  });

  it('works in 3/4 and drops strum changes in the middle of the song', () => {
    const src = 'title: Vals\ntempo: 90\ntime: 3/4\nstrum: D-DU-U\nC . . | G . . |\nstrum: D--\nAm . . | F . . | C . . | G . . |\n';
    for (const level of LEVELS) {
      const { source } = buildLevelSource(src, level, 'Vals');
      const { song, errors } = parseSong(source);
      expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
      expect(song.bars).toHaveLength(6);
      expect(source.match(/^strum:/gm)).toHaveLength(1);
    }
  });

  it('copy ids are valid and predictable', () => {
    expect(levelSongId('sodoma-acustica', 2)).toBe('sodoma-acustica-n2');
  });
});

describe('parseLevelId', () => {
  it('tells a level copy from a normal song', async () => {
    const { parseLevelId } = await import('../../src/song/levels');
    expect(parseLevelId('sodoma-acustica-n2')).toEqual({ baseId: 'sodoma-acustica', n: 2 });
    expect(parseLevelId('s_abc12xyz-n4')).toEqual({ baseId: 's_abc12xyz', n: 4 });
    expect(parseLevelId('sodoma-acustica')).toBeNull();
    expect(parseLevelId('algo-n9')).toBeNull(); // no such level
    expect(parseLevelId('algo-n')).toBeNull();
  });
});

describe('explaining the operation of a level', () => {
  it('strumBeats / strumRuleText say exactly where the strikes are', async () => {
    const { strumBeats, strumRuleText } = await import('../../src/song/levels');
    expect(strumBeats(LEVELS[0], 4).map((b) => b.symbol).join('')).toBe('✕✕✕✕');
    expect(strumBeats(LEVELS[1], 4).map((b) => b.symbol).join('')).toBe('↓···');
    expect(strumBeats(LEVELS[2], 4).map((b) => b.symbol).join('')).toBe('↓·↓·');
    expect(strumBeats(LEVELS[3], 4).map((b) => b.symbol).join('')).toBe('↓↓↓↓');
    expect(strumRuleText(LEVELS[1], 4)).toBe('Todos los golpes de la canción son un golpe hacia abajo (↓) en el tiempo 1 de cada compás. El resto del compás, el acorde sigue sonando.');
    expect(strumRuleText(LEVELS[2], 4)).toContain('en los tiempos 1 y 3');
    expect(strumRuleText(LEVELS[3], 4)).toContain('en cada tiempo (1, 2, 3 y 4)');
    expect(strumRuleText(LEVELS[0], 3)).toContain('un golpe apagado (✕) en cada tiempo (1, 2 y 3)');
  });

  it('levelPreview lists the chords that change for a given song', async () => {
    const { levelPreview } = await import('../../src/song/levels');
    const p2 = levelPreview(SODOMA, LEVELS[1]);
    expect(p2.before).toEqual(expect.arrayContaining(['D', 'E', 'A', 'F#m', 'Bm']));
    expect(p2.after).toEqual(['D', 'A']);
    expect(p2.changes).toEqual(expect.arrayContaining([{ from: 'E', to: 'A' }, { from: 'F#m', to: 'D' }, { from: 'Bm', to: 'D' }]));
    expect(levelPreview(SODOMA, LEVELS[0]).changes).toEqual([]);
  });
});

describe('what each level demands in practice', () => {
  it('level 1 judges only the timing (no chord) and its strikes are muted, so the judge never asks for a chord', async () => {
    const { levelDemandOf } = await import('../../src/song/levels');
    const l1 = levelDemandOf('sodoma-acustica-n1');
    expect(l1?.demand.chord).toBe(false);
    const { song } = parseSong(buildLevelSource(SODOMA, LEVELS[0], 'x').source);
    expect(song.events.every((e) => e.muted)).toBe(true);
  });

  it('levels 2 to 4 judge chord and timing, with a forgiving chord check while the chords are being learnt', async () => {
    const { levelDemandOf, chordToleranceFor } = await import('../../src/song/levels');
    for (const n of [2, 3, 4]) expect(levelDemandOf(`s-n${n}`)?.demand.chord).toBe(true);
    expect(chordToleranceFor(levelDemandOf('s-n2')!.demand, 'normal')).toBe('lenient');
    expect(chordToleranceFor(levelDemandOf('s-n3')!.demand, 'normal')).toBe('lenient');
    expect(chordToleranceFor(levelDemandOf('s-n4')!.demand, 'normal')).toBe('normal');
    // never stricter than the user asked for
    expect(chordToleranceFor(levelDemandOf('s-n4')!.demand, 'lenient')).toBe('lenient');
    expect(chordToleranceFor(null, 'normal')).toBe('normal');
    expect(levelDemandOf('sodoma-acustica')).toBeNull();
  });

  it('every level says in words what a hit and a mistake are', () => {
    for (const l of LEVELS) {
      expect(l.demand.hit.length).toBeGreaterThan(20);
      expect(l.demand.miss.length).toBeGreaterThan(10);
    }
  });
});
