import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_DELAY_MS,
  FORMAT_EXAMPLE,
  FORMAT_HELP_ROWS,
  MINI_DIAGRAM_H,
  MINI_DIAGRAM_W,
  SAVED_FLASH_MS,
  analyzeSource,
  editorScreen,
  issuesSummary,
  lineOfOffset,
  lineRange,
} from '../../src/ui/screens/editor';
import { parseSong } from '../../src/song/parser';
import { songDurationSec } from '../../src/song/tempo';
import { getChordShape } from '../../src/music/chords';

const SONG = `title: Prueba
tempo: 120
time: 4/4
strum: D-DU-UDU

[Intro]
C . . . | G . . . | Bdim7 . . . | x2
[Estrofa]
Am F | N.C. | - - G . |
> Letra`;

describe('analyzeSource', () => {
  it('parses the song and resolves a fingering per chord name', () => {
    const a = analyzeSource(SONG, 'abc');
    const { song } = parseSong(SONG, { id: 'abc' });
    expect(a.song.id).toBe('abc');
    expect(a.song.title).toBe('Prueba');
    expect(a.errorCount).toBe(0);
    expect(a.warningCount).toBe(0);
    expect(a.issues).toEqual([]);
    expect(a.bars).toBe(song.bars.length);
    expect(a.bars).toBe(9);
    expect(a.durationSec).toBeCloseTo(songDurationSec(song), 6);
    expect(a.chords.map((c) => c.name)).toEqual(song.chordNames);
    expect(a.chords.map((c) => c.name)).toEqual(['C', 'G', 'Bdim7', 'Am', 'F']);
    const byName = Object.fromEntries(a.chords.map((c) => [c.name, c.shape]));
    expect(byName.C).not.toBeNull();
    expect(byName.C?.name).toBe(getChordShape('C')?.name);
    expect(byName.Am).not.toBeNull();
    // dim7 has no library voicing and the barre generator cannot build it -> "sin digitación"
    expect(getChordShape('Bdim7')).toBeNull();
    expect(byName.Bdim7).toBeNull();
  });

  it('counts errors and warnings and keeps the issue list ordered by line', () => {
    const src = 'title: X\n\nC G Am |\nG . . . |\nA*9 |\nstrum: DDD\n';
    const a = analyzeSource(src);
    expect(a.warningCount).toBeGreaterThanOrEqual(1); // tempo missing
    expect(a.errorCount).toBeGreaterThanOrEqual(2); // uneven split + bar overflow (+ bad strum)
    expect(a.issues.length).toBe(a.errorCount + a.warningCount);
    for (let i = 1; i < a.issues.length; i++) expect(a.issues[i].line).toBeGreaterThanOrEqual(a.issues[i - 1].line);
    expect(a.issues.some((e) => e.line === 3 && e.severity === 'error')).toBe(true);
    expect(a.issues.some((e) => e.line === 5 && e.severity === 'error')).toBe(true);
    expect(a.bars).toBe(1); // only "G . . ." survives
  });

  it('reports zero bars and zero duration for an empty or header-only source', () => {
    const a = analyzeSource('');
    expect(a.bars).toBe(0);
    expect(a.durationSec).toBe(0);
    expect(a.chords).toEqual([]);
    const b = analyzeSource('title: Solo cabecera\ntempo: 100');
    expect(b.bars).toBe(0);
    expect(b.durationSec).toBe(0);
    expect(b.song.title).toBe('Solo cabecera');
  });

  it('never throws', () => {
    expect(() => analyzeSource('[[[ | *** x0 ]]]')).not.toThrow();
  });
});

describe('lineRange / lineOfOffset', () => {
  const text = 'abc\ndefg\n\nhi';

  it('returns the character range of a 1-based line without its line break', () => {
    expect(lineRange(text, 1)).toEqual({ start: 0, end: 3 });
    expect(lineRange(text, 2)).toEqual({ start: 4, end: 8 });
    expect(lineRange(text, 3)).toEqual({ start: 9, end: 9 });
    expect(lineRange(text, 4)).toEqual({ start: 10, end: 12 });
  });

  it('clamps out-of-range lines', () => {
    expect(lineRange(text, 0)).toEqual({ start: 0, end: 3 });
    expect(lineRange(text, -5)).toEqual({ start: 0, end: 3 });
    expect(lineRange(text, 99)).toEqual({ start: 10, end: 12 });
    expect(lineRange('', 1)).toEqual({ start: 0, end: 0 });
    expect(lineRange('', 7)).toEqual({ start: 0, end: 0 });
  });

  it('excludes a trailing CR from the range for CRLF text', () => {
    const crlf = 'abc\r\ndef\r\n';
    expect(lineRange(crlf, 1)).toEqual({ start: 0, end: 3 });
    expect(lineRange(crlf, 2)).toEqual({ start: 5, end: 8 });
    expect(lineRange(crlf, 3)).toEqual({ start: 10, end: 10 });
  });

  it('lineOfOffset is the inverse mapping', () => {
    expect(lineOfOffset(text, 0)).toBe(1);
    expect(lineOfOffset(text, 3)).toBe(1); // at the '\n' still line 1
    expect(lineOfOffset(text, 4)).toBe(2);
    expect(lineOfOffset(text, 9)).toBe(3);
    expect(lineOfOffset(text, 10)).toBe(4);
    expect(lineOfOffset(text, 999)).toBe(4);
    expect(lineOfOffset(text, -3)).toBe(1);
    expect(lineOfOffset('', 0)).toBe(1);
    for (let line = 1; line <= 4; line++) {
      const { start } = lineRange(text, line);
      expect(lineOfOffset(text, start)).toBe(line);
    }
  });
});

describe('issuesSummary', () => {
  it('pluralises in Spanish', () => {
    expect(issuesSummary(0, 0)).toBe('Sin errores ni avisos');
    expect(issuesSummary(1, 0)).toBe('1 error');
    expect(issuesSummary(2, 0)).toBe('2 errores');
    expect(issuesSummary(0, 1)).toBe('1 aviso');
    expect(issuesSummary(0, 3)).toBe('3 avisos');
    expect(issuesSummary(2, 1)).toBe('2 errores · 1 aviso');
  });
});

describe('format help and constants', () => {
  it('covers the grammar tokens required by the spec', () => {
    const tokens = FORMAT_HELP_ROWS.map(([t]) => t).join('\n');
    for (const needle of ['>', 'x2', '*', '-', 'N.C.', 'strum', 'tempo', 'time', 'capo', '[']) {
      expect(tokens).toContain(needle);
    }
    for (const [token, description] of FORMAT_HELP_ROWS) {
      expect(token.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it('ships an example that parses without errors', () => {
    const { errors } = parseSong(FORMAT_EXAMPLE);
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(errors.filter((e) => e.severity === 'warning')).toEqual([]);
  });

  it('exposes the timing constants and the Screen object', () => {
    expect(AUTOSAVE_DELAY_MS).toBe(500);
    expect(SAVED_FLASH_MS).toBeGreaterThan(0);
    expect(MINI_DIAGRAM_W).toBeGreaterThan(0);
    expect(MINI_DIAGRAM_H).toBeGreaterThan(0);
    expect(typeof editorScreen.mount).toBe('function');
  });
});
