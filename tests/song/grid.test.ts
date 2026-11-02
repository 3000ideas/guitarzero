import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { EXAMPLE_SONGS } from '../../src/song/examples';
import {
  applyTempoMap,
  addBarLine,
  addSection,
  appendBar,
  barNumbers,
  beatsAt,
  chartChords,
  deleteBar,
  expandRepeats,
  duplicateBar,
  headerValue,
  insertBar,
  lyricOf,
  moveBar,
  normalizeCellValue,
  parseBarCells,
  parseGrid,
  retimeBar,
  serializeGrid,
  setCell,
  setHeader,
  setLineRepeat,
  setLyric,
  setSectionLabel,
  setSectionRepeat,
} from '../../src/song/grid';

const SAMPLE = `title: Mi canción
artist: Yo
tempo: 100
time: 4/4
strum: D-DU-UDU

# un comentario
[Intro]
C . . . | G . . . | x2
[Estrofa]
C G | Am*3 F | N.C. | - - G . |
> Letra de la estrofa
[Estribillo] x2
F . . . | . . G . |   # sigue el acorde anterior
`;

/** Bars of a song as `name:beats` per chord, to compare two texts musically. */
function musical(source: string): string[] {
  const { song } = parseSong(source);
  return song.bars.map((b) => b.chords.map((c) => `${c.chord.name}:${c.beats}`).join(' '));
}

describe('parseBarCells', () => {
  it('reads a held chord', () => expect(parseBarCells('C . . .', 4)).toEqual(['C', '', '', '']));
  it('splits bare chords evenly', () => expect(parseBarCells('C G', 4)).toEqual(['C', '', 'G', '']));
  it('reads explicit durations', () => expect(parseBarCells('Am*3 F', 4)).toEqual(['Am', '', '', 'F']));
  it('reads rests and N.C.', () => {
    expect(parseBarCells('- - G .', 4)).toEqual(['-', '-', 'G', '']);
    expect(parseBarCells('N.C.', 4)).toEqual(['N.C.', '', '', '']);
  });
  it('leading dots hold the previous bar', () => expect(parseBarCells('. . G .', 4)).toEqual(['', '', 'G', '']));
  it('works in 3/4 and 6/8', () => {
    expect(parseBarCells('C . G', 3)).toEqual(['C', '', 'G']);
    expect(parseBarCells('C . . G . .', 6, 8)).toEqual(['C', '', '', 'G', '', '']);
  });
  it('rejects invalid and incomplete bars', () => {
    expect(parseBarCells('C . .', 4)).toBeNull();
    expect(parseBarCells('H . . .', 4)).toBeNull();
    expect(parseBarCells('C . . . .', 4)).toBeNull();
    expect(parseBarCells('', 4)).toBeNull();
  });
  it('rejects chords that start between beats (half beats)', () => {
    // 3 beats split between 2 chords with an 8-slot strum would give 1.5 beats each.
    expect(parseBarCells('C G', 3, 4, 'D-D-D-D-')).toBeNull();
  });
});

describe('parseGrid / serializeGrid', () => {
  it('round-trips the text exactly when nothing is edited', () => {
    expect(serializeGrid(parseGrid(SAMPLE))).toBe(SAMPLE);
  });

  it('round-trips CRLF text', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    expect(serializeGrid(parseGrid(crlf))).toBe(crlf);
  });

  it('round-trips every bundled example', () => {
    for (const ex of EXAMPLE_SONGS) {
      expect(serializeGrid(parseGrid(ex.source)), ex.id).toBe(ex.source);
    }
  });

  it('understands the lines of the sample', () => {
    const chart = parseGrid(SAMPLE);
    const bars = chart.items.filter((i) => i.kind === 'bars');
    expect(bars).toHaveLength(3);
    expect(bars[0].kind === 'bars' && bars[0].repeat).toBe(2);
    expect(bars[1].kind === 'bars' && bars[1].bars.map((b) => b.cells)).toEqual([
      ['C', '', 'G', ''],
      ['Am', '', '', 'F'],
      ['N.C.', '', '', ''],
      ['-', '-', 'G', ''],
    ]);
    expect(bars[2].kind === 'bars' && bars[2].comment).toBe('# sigue el acorde anterior');
    expect(chartChords(chart)).toEqual(['C', 'G', 'Am', 'F']);
  });

  it('keeps unrepresentable lines as raw text', () => {
    const src = 'tempo: 90\nC . . | G . . . |\nxyz\nC . . . |\n';
    const chart = parseGrid(src);
    expect(chart.items.filter((i) => i.kind === 'raw')).toHaveLength(2);
    expect(serializeGrid(chart)).toBe(src);
  });

  it('follows time: changes', () => {
    const src = 'time: 3/4\nC . . | G . . |\ntime: 4/4\nC . . . |\n';
    const chart = parseGrid(src);
    const bars = chart.items.filter((i) => i.kind === 'bars');
    expect(bars.map((b) => (b.kind === 'bars' ? b.bars[0].cells.length : 0))).toEqual([3, 4]);
    expect(beatsAt(chart, 1)).toBe(3);
    expect(beatsAt(chart, 3)).toBe(4);
  });

  it('numbers the bars counting repeats', () => {
    expect(barNumbers(parseGrid('C . . . | G . . . | x2\nAm . . . |\n'))).toEqual([1, 5, 6]);
  });
});

describe('editing keeps the song musically identical', () => {
  it('normalising an untouched bar line to text gives the same bars', () => {
    const chart = parseGrid(SAMPLE);
    for (const it of chart.items) if (it.kind === 'bars') it.orig = null; // force rewrite
    const out = serializeGrid(chart);
    expect(musical(out)).toEqual(musical(SAMPLE));
    expect(parseSong(out).errors.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('only the touched line changes', () => {
    const chart = parseGrid(SAMPLE);
    const idx = chart.items.findIndex((i) => i.kind === 'bars');
    expect(setCell(chart, idx, 1, 2, 'Em')).toBe(true);
    const lines = serializeGrid(chart).split('\n');
    const orig = SAMPLE.split('\n');
    const changed = lines.map((l, i) => (l === orig[i] ? null : i)).filter((v) => v !== null);
    expect(changed).toEqual([idx]);
    expect(lines[idx]).toBe('C . . . | G . Em . | x2');
  });

  it('setCell validates values and supports hold / rest / N.C.', () => {
    const chart = parseGrid('C . . . |\n');
    expect(setCell(chart, 0, 0, 1, 'zzz')).toBe(false);
    expect(setCell(chart, 0, 0, 1, 'a m')).toBe(false);
    expect(setCell(chart, 0, 0, 1, 'Am7')).toBe(true);
    expect(setCell(chart, 0, 0, 2, '-')).toBe(true);
    expect(setCell(chart, 0, 0, 3, 'nc')).toBe(true);
    expect(serializeGrid(chart)).toBe('C Am7 - N.C. |\n');
    expect(setCell(chart, 0, 0, 1, '')).toBe(true);
    expect(serializeGrid(chart)).toBe('C . - N.C. |\n');
    expect(setCell(chart, 0, 0, 9, 'C')).toBe(false);
  });

  it('inserts, duplicates, moves and deletes bars', () => {
    const chart = parseGrid('C . . . | G . . . |\n');
    duplicateBar(chart, 0, 0);
    expect(serializeGrid(chart)).toBe('C . . . | C . . . | G . . . |\n');
    insertBar(chart, 0, 0);
    expect(serializeGrid(chart)).toBe('C . . . | . . . . | C . . . | G . . . |\n');
    expect(moveBar(chart, 0, 3, -1)).toBe(2);
    expect(serializeGrid(chart)).toBe('C . . . | . . . . | G . . . | C . . . |\n');
    expect(deleteBar(chart, 0, 1)).toBe(false);
    expect(serializeGrid(chart)).toBe('C . . . | G . . . | C . . . |\n');
  });

  it('deleting the last bar removes the line', () => {
    const chart = parseGrid('C . . . |\nG . . . |\n');
    expect(deleteBar(chart, 0, 0)).toBe(true);
    expect(serializeGrid(chart)).toBe('G . . . |\n');
  });

  it('appendBar starts a new line after four bars', () => {
    const chart = parseGrid('C . . . | G . . . | Am . . . | F . . . |\n');
    const at = appendBar(chart, 0);
    expect(at).toEqual({ item: 1, bar: 0 });
    expect(serializeGrid(chart)).toBe('C . . . | G . . . | Am . . . | F . . . |\n. . . . |\n');
    expect(appendBar(chart, 1)).toEqual({ item: 1, bar: 1 });
  });

  it('appendBar puts the new line after the lyric of the full line', () => {
    const chart = parseGrid('C . . . | G . . . | Am . . . | F . . . |\n> la la\n');
    expect(appendBar(chart, 0)).toEqual({ item: 2, bar: 0 });
    expect(serializeGrid(chart)).toBe('C . . . | G . . . | Am . . . | F . . . |\n> la la\n. . . . |\n');
  });

  it('line repeat, sections and lyrics', () => {
    const chart = parseGrid('[Intro]\nC . . . |\n');
    setLineRepeat(chart, 1, 3);
    setSectionLabel(chart, 0, 'Puente');
    setSectionRepeat(chart, 0, 2);
    expect(setLyric(chart, 1, 'La la la')).toBe(2);
    expect(lyricOf(chart, 1)).toBe('La la la');
    expect(serializeGrid(chart)).toBe('[Puente] x2\nC . . . | x3\n> La la la\n');
    setLyric(chart, 1, '');
    expect(serializeGrid(chart)).toBe('[Puente] x2\nC . . . | x3\n');
  });

  it('addSection and addBarLine keep the final newline last', () => {
    const chart = parseGrid('tempo: 100\nC . . . |\n');
    addSection(chart, 'Estribillo');
    addBarLine(chart);
    expect(serializeGrid(chart)).toBe('tempo: 100\nC . . . |\n[Estribillo]\n. . . . |\n. . . . |\n');
  });

  it('setHeader rewrites, inserts, and relayouts bars on a time change', () => {
    const chart = parseGrid('title: A\ntempo: 100\nC . . . | G . . . |\n');
    setHeader(chart, 'tempo', '120');
    setHeader(chart, 'capo', '2');
    expect(headerValue(chart, 'capo')).toBe('2');
    setHeader(chart, 'time', '3/4');
    const out = serializeGrid(chart);
    expect(out).toContain('tempo: 120');
    expect(out).toContain('capo: 2');
    expect(out).toContain('time: 3/4');
    expect(out).toContain('C . . | G . . |');
    expect(parseSong(out).song.timeSignature.beatsPerBar).toBe(3);
  });

  it('serialised edits always parse without errors', () => {
    const chart = parseGrid(SAMPLE);
    const idx = chart.items.findIndex((i) => i.kind === 'bars');
    setCell(chart, idx, 0, 3, 'D');
    setLineRepeat(chart, idx, 4);
    duplicateBar(chart, idx + 2, 0);
    const errors = parseSong(serializeGrid(chart)).errors.filter((e) => e.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('normalizeCellValue', () => {
  it('accepts chords, rests, N.C. and empty; rejects the rest', () => {
    expect(normalizeCellValue(' Am ')).toBe('Am');
    expect(normalizeCellValue('')).toBe('');
    expect(normalizeCellValue('n.c')).toBe('N.C.');
    expect(normalizeCellValue('-')).toBe('-');
    expect(normalizeCellValue('G/B')).toBe('G/B');
    expect(normalizeCellValue('C | G')).toBeNull();
    expect(normalizeCellValue('Am*3')).toBeNull();
    expect(normalizeCellValue('hola')).toBeNull();
  });
});

describe('regressions found in review', () => {
  const errorsOf = (src: string) => parseSong(src).errors.filter((e) => e.severity === 'error');

  it('sharps are valid cell values', () => {
    expect(normalizeCellValue('F#m')).toBe('F#m');
    expect(normalizeCellValue('#x')).toBeNull();
    const chart = parseGrid('C . . . |\n');
    expect(setCell(chart, 0, 0, 2, 'C#')).toBe(true);
    expect(errorsOf(serializeGrid(chart))).toEqual([]);
  });

  it('free text never writes a comment-starting #', () => {
    const chart = parseGrid('[Estrofa]\nC . . . |\n');
    setSectionLabel(chart, 0, 'Estribillo #2');
    setLyric(chart, 1, 'ay #1 mio');
    setHeader(chart, 'title', 'Song #1');
    const out = serializeGrid(chart);
    expect(errorsOf(out).filter((e) => e.message.includes('sección'))).toEqual([]);
    expect(parseSong(out).song.title).toBe('Song 1');
    expect(parseSong(out).song.lyricLines[0].text).toBe('ay 1 mio');
  });

  it('an emptied header is removed, not left as "key:"', () => {
    const chart = parseGrid('tempo: 100\ncapo: 2\nC . . . |\n');
    setHeader(chart, 'capo', '');
    setHeader(chart, 'tempo', '');
    expect(serializeGrid(chart)).toBe('C . . . |\n');
  });

  it('deleting the last bar of a line takes its lyric, and an emptied section header, with it', () => {
    const chart = parseGrid('[Verse]\nC . . . | G . . . |\n[Chorus]\nAm . . . |\n> uno\n[Verse]\nF . . . |\n');
    expect(deleteBar(chart, 3, 0)).toBe(true);
    const out = serializeGrid(chart);
    expect(out).toBe('[Verse]\nC . . . | G . . . |\n[Verse]\nF . . . |\n');
    expect(musical(out)).toEqual(['C:4', 'G:4', 'F:4']);
  });

  it('a new first bar has a chord of its own and a trailing recall is not turned into a hold', () => {
    const empty = parseGrid('');
    addBarLine(empty);
    expect(errorsOf(serializeGrid(empty))).toEqual([]);
    const recall = parseGrid('[Verse]\nC . . . |\n[Chorus]\nG . . . |\n[Verse]\n');
    expect(addBarLine(recall)).toBe(-1);
    expect(serializeGrid(recall)).toBe('[Verse]\nC . . . |\n[Chorus]\nG . . . |\n[Verse]\n');
  });

  it('a hold at the very start of the song stays raw text', () => {
    const chart = parseGrid('tempo: 80\n. . C G |\n');
    expect(chart.items.map((i) => i.kind)).toEqual(['header', 'raw', 'blank']);
  });

  it('removing the time header goes back to 4 beats', () => {
    const chart = parseGrid('time: 3/4\nC . . | G . . |\n');
    setHeader(chart, 'time', '');
    expect(serializeGrid(chart)).toBe('C . . . | G . . . |\n');
  });
});

describe('retimeBar', () => {
  it('gives one bar of a line its own tempo and goes back after it', () => {
    const chart = parseGrid('tempo: 80\nD . . . | F#m . . . | D . . . | A . . . |\nD . . . |\n');
    expect(retimeBar(chart, 1, 3, 70, 80)).toBe(true);
    const out = serializeGrid(chart);
    expect(out).toBe('tempo: 80\nD . . . | F#m . . . | D . . . |\ntempo: 70\nA . . . |\ntempo: 80\nD . . . |\n');
    const { song } = parseSong(out);
    expect(song.tempoSegments.map((t) => t.bpm)).toEqual([80, 70, 80]);
    expect(parseSong(out).errors.filter((e) => e.severity === 'error')).toEqual([]);
  });

  it('works for the first and the last bar of the song, and refuses repeated lines', () => {
    const a = parseGrid('tempo: 80\nD . . . | A . . . |\n');
    expect(retimeBar(a, 1, 0, 90, 80)).toBe(true);
    expect(serializeGrid(a)).toBe('tempo: 80\ntempo: 90\nD . . . |\ntempo: 80\nA . . . |\n');
    const b = parseGrid('tempo: 80\nD . . . | A . . . |\n');
    expect(retimeBar(b, 1, 1, 90, null)).toBe(true);
    expect(serializeGrid(b)).toBe('tempo: 80\nD . . . |\ntempo: 90\nA . . . |\n');
    const rep = parseGrid('tempo: 80\nD . . . | A . . . | x2\n');
    expect(retimeBar(rep, 1, 0, 90, 80)).toBe(false);
    expect(retimeBar(a, 1, 0, 5, 80)).toBe(false);
  });
});

describe('applyTempoMap', () => {
  it('writes a tempo before every line whose tempo changes and drops the old mid-song ones', () => {
    const chart = parseGrid('tempo: 100\n[A]\nC . . . | G . . . |\ntempo: 50\nAm . . . | F . . . |\nC . . . | G . . . |\n');
    const n = applyTempoMap(chart, [
      { item: 2, bpm: 98.5 },
      { item: 4, bpm: 98.55 }, // within 0.15 bpm of the previous one: not written
      { item: 5, bpm: 101.2 },
    ]);
    expect(n).toBe(2);
    const out = serializeGrid(chart);
    expect(out).toBe('tempo: 98.5\n[A]\nC . . . | G . . . |\nAm . . . | F . . . |\ntempo: 101.2\nC . . . | G . . . |\n');
    expect(parseSong(out).song.tempoSegments.map((t) => t.bpm)).toEqual([98.5, 101.2]);
  });

  it('adds the leading tempo when there is none', () => {
    const chart = parseGrid('C . . . | G . . . |\nAm . . . |\n');
    applyTempoMap(chart, [{ item: 0, bpm: 90 }, { item: 1, bpm: 95 }]);
    expect(serializeGrid(chart)).toBe('tempo: 90\nC . . . | G . . . |\ntempo: 95\nAm . . . |\n');
  });
});

describe('expandRepeats', () => {
  const SRC = 'tempo: 90\nstrum: D-D-U-U-\n[Intro] x2\nD . . . | A . . . |\n[Estrofa]\nD . . . | F#m . . . | x2\n> la\nG . . . |\n[Estribillo]\nA . . . | D . . . |\n[Estrofa]\n[Estribillo] x2\n';

  it('writes every repetition out without changing the music', () => {
    const chart = parseGrid(SRC);
    expect(expandRepeats(chart)).toBe(true);
    const out = serializeGrid(chart);
    expect(musical(out)).toEqual(musical(SRC));
    expect(out).not.toMatch(/x\d/);
    expect(parseSong(out).errors.filter((e) => e.severity === 'error')).toEqual([]);
    // every bar of the song now has its own place in the text
    const bars = parseSong(out).song.bars;
    const places = new Set(bars.map((b) => `${b.srcLine}:${b.srcBar}`));
    expect(places.size).toBe(bars.length);
  });

  it('refuses what it cannot copy safely', () => {
    expect(expandRepeats(parseGrid('[A]\nC . . . |\n[B] x2\n'))).toBe(false); // recall of an undefined section
    expect(expandRepeats(parseGrid('[A]\nC . . . |\nstrum: D-D-U-U-\n[A]\n'))).toBe(false); // strum change in the middle
    expect(expandRepeats(parseGrid('[A]\nC . . |\n'))).toBe(false); // a line the grid cannot read
  });
});
