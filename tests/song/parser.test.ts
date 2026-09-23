import { describe, expect, it } from 'vitest';
import { defaultStrum, isValidStrumLength, parseSong, restChord, sameChord } from '../../src/song/parser';
import type { ParseResult, StrumEvent } from '../../src/types';

// ---------------------------------------------------------------- helpers

const src = (...lines: string[]): string => lines.join('\n');
const errorsOf = (r: ParseResult) => r.errors.filter((e) => e.severity === 'error');
const warningsOf = (r: ParseResult) => r.errors.filter((e) => e.severity === 'warning');
const eventsOfBar = (r: ParseResult, barIndex: number): StrumEvent[] =>
  r.song.events.filter((e) => e.barIndex === barIndex);
const chordsOf = (r: ParseResult, barIndex: number): Array<[string, number]> =>
  r.song.bars[barIndex].chords.map((c) => [c.chord.name, c.beats]);
const beatsInBar = (r: ParseResult, barIndex: number): number[] => eventsOfBar(r, barIndex).map((e) => e.beatInBar);

/** The example of SPEC.md section 2, verbatim. */
const CIELITO = `title: Cielito Lindo
artist: Tradicional
tempo: 120          # pulsos por minuto de la figura del denominador del compás
time: 4/4           # compás: 4/4 (defecto), 3/4, 2/4, 6/8 (en x/8 el pulso es la corchea)
strum: D-DU-UDU     # patrón de rasgueo por compás (ver abajo)
capo: 2             # cejilla: se muestra y la detección se desplaza +2 semitonos

[Intro]             # sección (etiqueta)
C . . . | G . . . | C . G . |
# comentario
[Estrofa]
C G | Am F |        # acordes "desnudos": el compás se reparte a partes iguales (2+2)
Am*3 F |            # Am durante 3 beats, F el beat restante
N.C. | G . . . |    # N.C. = sin acorde (la pelota bota, no se juzga)
- - G . |           # - = silencio de 1 beat (sin rasgueo)
> Ay, ay, ay, ay, canta y no llores    # letra asociada a la línea de compases anterior
[Estribillo]
C . . . | G . . . | x2                  # repite los compases de esta línea 2 veces
[Estrofa]                                # sección vacía = vuelve a insertar la última definición
[Estribillo] x2                          # inserta la sección 2 veces
`;

/** The 3/4 example of SPEC.md section 2, verbatim. */
const VALS = `title: Vals
tempo: 90
time: 3/4
strum: D-DUDU
C . . | G . . | G . C |
`;

// ---------------------------------------------------------------- examples of section 2

describe('parseSong: examples of SPEC section 2', () => {
  const r = parseSong(CIELITO, { id: 'cielito' });
  const { song } = r;

  it('parses without errors or warnings', () => {
    expect(r.errors).toEqual([]);
  });

  it('reads the headers', () => {
    expect(song.id).toBe('cielito');
    expect(song.title).toBe('Cielito Lindo');
    expect(song.artist).toBe('Tradicional');
    expect(song.tempo).toBe(120);
    expect(song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
    expect(song.capo).toBe(2);
    expect(song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 120 }]);
    expect(song.source).toBe(CIELITO);
  });

  it('expands sections and repeats into 27 bars of 4 beats', () => {
    expect(song.bars.length).toBe(27);
    expect(song.totalBeats).toBe(108);
    song.bars.forEach((b, i) => {
      expect(b.index).toBe(i);
      expect(b.beats).toBe(4);
      expect(b.startBeat).toBe(i * 4);
    });
    const sections = song.bars.map((b) => b.section);
    expect(sections.slice(0, 3)).toEqual(['Intro', 'Intro', 'Intro']);
    expect(sections.slice(3, 9)).toEqual(Array(6).fill('Estrofa'));
    expect(sections.slice(9, 13)).toEqual(Array(4).fill('Estribillo'));
    expect(sections.slice(13, 19)).toEqual(Array(6).fill('Estrofa'));
    expect(sections.slice(19, 27)).toEqual(Array(8).fill('Estribillo'));
  });

  it('assigns the chord durations of every bar', () => {
    expect(chordsOf(r, 0)).toEqual([['C', 4]]);
    expect(chordsOf(r, 2)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 3)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 4)).toEqual([
      ['Am', 2],
      ['F', 2],
    ]);
    expect(chordsOf(r, 5)).toEqual([
      ['Am', 3],
      ['F', 1],
    ]);
    expect(chordsOf(r, 6)).toEqual([['N.C.', 4]]);
    expect(song.bars[6].chords[0].chord).toEqual({ name: 'N.C.', root: -1, quality: 'nc', bass: null });
    expect(chordsOf(r, 8)).toEqual([
      ['-', 1],
      ['-', 1],
      ['G', 2],
    ]);
    expect(song.bars[8].chords[0].chord).toEqual({ name: '-', root: -1, quality: 'nc', bass: null });
    // chords[].startBeat is absolute, also inside copies
    expect(song.bars[3].chords.map((c) => c.startBeat)).toEqual([12, 14]);
    expect(song.bars[13].chords.map((c) => c.startBeat)).toEqual([52, 54]);
    // copies keep the same chords
    expect(chordsOf(r, 13)).toEqual(chordsOf(r, 3));
    expect(chordsOf(r, 18)).toEqual(chordsOf(r, 8));
    expect(chordsOf(r, 19)).toEqual(chordsOf(r, 9));
    expect(chordsOf(r, 26)).toEqual(chordsOf(r, 12));
  });

  it('collects chordNames as written, excluding rests and N.C.', () => {
    expect(song.chordNames).toEqual(['C', 'G', 'Am', 'F']);
  });

  it('attaches the lyric to the previous bar line and copies it with the section', () => {
    expect(song.lyricLines).toEqual([
      { barIndex: 8, text: 'Ay, ay, ay, ay, canta y no llores' },
      { barIndex: 18, text: 'Ay, ay, ay, ay, canta y no llores' },
    ]);
  });

  it('generates events from the D-DU-UDU pattern', () => {
    expect(beatsInBar(r, 0)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(eventsOfBar(r, 0).map((e) => e.direction)).toEqual(['down', 'down', 'up', 'up', 'down', 'up']);
    expect(eventsOfBar(r, 0).map((e) => e.chordChange)).toEqual([true, false, false, false, false, false]);
    expect(eventsOfBar(r, 0).every((e) => e.chord.name === 'C' && !e.muted)).toBe(true);
    // bar 3 "C G": the chord change on beat 2 falls on a '-' -> extra down event
    expect(beatsInBar(r, 3)).toEqual([0, 1, 1.5, 2, 2.5, 3, 3.5]);
    const b3 = eventsOfBar(r, 3);
    expect(b3.map((e) => e.chord.name)).toEqual(['C', 'C', 'C', 'G', 'G', 'G', 'G']);
    expect(b3.map((e) => e.chordChange)).toEqual([true, false, false, true, false, false, false]);
    expect(b3[3].direction).toBe('down');
    expect(b3[3].time).toBe(14);
    // bar 5 "Am*3 F": F starts on beat 3 where the pattern has a D
    expect(beatsInBar(r, 5)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(eventsOfBar(r, 5).map((e) => e.chord.name)).toEqual(['Am', 'Am', 'Am', 'Am', 'F', 'F']);
    expect(eventsOfBar(r, 5).map((e) => e.chordChange)).toEqual([true, false, false, false, true, false]);
    // bar 6 N.C.: events with quality nc, first one is a chord change
    const b6 = eventsOfBar(r, 6);
    expect(b6.length).toBe(6);
    expect(b6.every((e) => e.chord.quality === 'nc' && e.chord.name === 'N.C.')).toBe(true);
    expect(b6.map((e) => e.chordChange)).toEqual([true, false, false, false, false, false]);
    // bar 7 G after N.C. -> chord change
    expect(eventsOfBar(r, 7)[0].chordChange).toBe(true);
    // bar 8 "- - G .": nothing during the rest, G starts on a '-' after a rest
    expect(beatsInBar(r, 8)).toEqual([2, 2.5, 3, 3.5]);
    expect(eventsOfBar(r, 8)[0]).toMatchObject({ time: 34, chordChange: true, direction: 'down', muted: false });
    expect(song.events.length).toBe(163);
  });

  it('keeps event invariants and copies events with the sections', () => {
    song.events.forEach((e, i) => {
      expect(e.index).toBe(i);
      expect(e.time).toBe(song.bars[e.barIndex].startBeat + e.beatInBar);
      if (i > 0) expect(e.time).toBeGreaterThan(song.events[i - 1].time);
    });
    const shifted = (a: number, b: number) => {
      const ea = eventsOfBar(r, a);
      const eb = eventsOfBar(r, b);
      expect(eb.map((e) => e.beatInBar)).toEqual(ea.map((e) => e.beatInBar));
      expect(eb.map((e) => e.chord.name)).toEqual(ea.map((e) => e.chord.name));
      expect(eb.map((e) => e.direction)).toEqual(ea.map((e) => e.direction));
      expect(eb.map((e) => e.time - song.bars[b].startBeat)).toEqual(ea.map((e) => e.time - song.bars[a].startBeat));
    };
    for (let i = 0; i < 6; i++) shifted(3 + i, 13 + i);
    for (let i = 0; i < 4; i++) {
      shifted(9 + i, 19 + i);
      shifted(9 + i, 23 + i);
    }
  });

  it('parses the 3/4 example', () => {
    const v = parseSong(VALS);
    expect(v.errors).toEqual([]);
    expect(v.song.title).toBe('Vals');
    expect(v.song.tempo).toBe(90);
    expect(v.song.timeSignature).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    expect(v.song.bars.length).toBe(3);
    expect(v.song.bars.map((b) => b.section)).toEqual([null, null, null]);
    expect(v.song.totalBeats).toBe(9);
    expect(chordsOf(v, 2)).toEqual([
      ['G', 2],
      ['C', 1],
    ]);
    expect(beatsInBar(v, 0)).toEqual([0, 1, 1.5, 2, 2.5]);
    expect(beatsInBar(v, 2)).toEqual([0, 1, 1.5, 2, 2.5]);
    expect(eventsOfBar(v, 2).map((e) => e.chord.name)).toEqual(['G', 'G', 'G', 'C', 'C']);
    // bar 2 starts with the same G as bar 1: not a chord change (only root/quality/bass count)
    expect(eventsOfBar(v, 2).map((e) => e.chordChange)).toEqual([false, false, false, true, false]);
    expect(eventsOfBar(v, 0)[0].chordChange).toBe(true); // first event of the song
    expect(eventsOfBar(v, 1)[0].chordChange).toBe(true); // G after C
    expect(eventsOfBar(v, 0).map((e) => e.direction)).toEqual(['down', 'down', 'up', 'down', 'up']);
    expect(v.song.events.length).toBe(15);
  });
});

// ---------------------------------------------------------------- basics

describe('parseSong: basics', () => {
  it('returns an empty song for an empty source (with the tempo warning)', () => {
    const r = parseSong('');
    expect(r.song.id).toBe('');
    expect(r.song.bars).toEqual([]);
    expect(r.song.events).toEqual([]);
    expect(r.song.totalBeats).toBe(0);
    expect(r.song.tempo).toBe(80);
    expect(r.song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 80 }]);
    expect(r.song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
    expect(r.song.capo).toBe(0);
    expect(r.song.title).toBe('');
    expect(r.song.artist).toBe('');
    expect(r.song.chordNames).toEqual([]);
    expect(r.song.lyricLines).toEqual([]);
    expect(errorsOf(r)).toEqual([]);
    expect(warningsOf(r)).toEqual([{ line: 1, message: 'tempo no indicado, se usa 80', severity: 'warning' }]);
  });

  it('uses opts.id and keeps the raw source', () => {
    const text = 'tempo: 100\nC . . . |';
    const r = parseSong(text, { id: 's_abc' });
    expect(r.song.id).toBe('s_abc');
    expect(r.song.source).toBe(text);
  });

  it('accepts CRLF line endings and reports 1-based line numbers', () => {
    const r = parseSong('tempo: 100\r\nC . . . |\r\nhola . . . |\r\nG . . . |');
    expect(r.song.bars.length).toBe(2);
    expect(errorsOf(r).map((e) => e.line)).toEqual([3]);
  });

  it('treats a line without | as a single bar and ignores empty segments and the final bar', () => {
    const r = parseSong(src('tempo: 100', 'C . . .', '| G . . . | | Am . . .'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(3);
    expect(r.song.chordNames).toEqual(['C', 'G', 'Am']);
  });

  it('a lone | line produces nothing', () => {
    const r = parseSong(src('tempo: 100', '|', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(1);
  });

  it('headers are case-insensitive and tolerate spaces around the colon', () => {
    const r = parseSong(src('TITLE : Mi canción', 'Artist:Yo', 'Tempo: 100', 'CAPO: 3', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.title).toBe('Mi canción');
    expect(r.song.artist).toBe('Yo');
    expect(r.song.tempo).toBe(100);
    expect(r.song.capo).toBe(3);
  });

  it('flags unknown headers with the lyric hint', () => {
    const r = parseSong(src('tempo: 100', 'titulo: Algo', 'C . . . |'));
    expect(errorsOf(r).length).toBe(1);
    expect(errorsOf(r)[0].line).toBe(2);
    expect(errorsOf(r)[0].message).toContain('cabecera desconocida "titulo"');
    expect(errorsOf(r)[0].message).toContain('si es letra, empieza la línea con ">"');
    expect(r.song.bars.length).toBe(1);
  });

  it('exports small helpers', () => {
    expect(defaultStrum(4)).toBe('D-D-D-D-');
    expect(defaultStrum(3)).toBe('D-D-D-');
    expect(isValidStrumLength(8, 4)).toBe(true);
    expect(isValidStrumLength(6, 4)).toBe(false);
    expect(isValidStrumLength(12, 6)).toBe(true);
    expect(restChord()).toEqual({ name: '-', root: -1, quality: 'nc', bass: null });
    expect(sameChord({ name: 'C', root: 0, quality: 'maj', bass: null }, { name: 'Cmaj', root: 0, quality: 'maj', bass: null })).toBe(true);
    expect(sameChord({ name: 'G', root: 7, quality: 'maj', bass: null }, { name: 'G/B', root: 7, quality: 'maj', bass: 11 })).toBe(false);
  });
});

// ---------------------------------------------------------------- comments

describe('parseSong: comments', () => {
  it('# starts a comment only at line start or after whitespace (F#m, C#7, D/F# survive)', () => {
    const r = parseSong(src('tempo: 100', '# solo comentario', '   # indentado', 'F#m . . . | D/F# . . . | C#7 . . . | # fin', 'G . . . | #sin espacio tras la almohadilla'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(4);
    expect(r.song.chordNames).toEqual(['F#m', 'D/F#', 'C#7', 'G']);
  });

  it('strips trailing comments from headers, sections and lyrics', () => {
    const r = parseSong(src('title: Hola # comentario', 'tempo: 100 # bpm', '[Intro] # sección', 'C . . . |', '> letra # nota'));
    expect(r.errors).toEqual([]);
    expect(r.song.title).toBe('Hola');
    expect(r.song.tempo).toBe(100);
    expect(r.song.bars[0].section).toBe('Intro');
    expect(r.song.lyricLines).toEqual([{ barIndex: 0, text: 'letra' }]);
  });
});

// ---------------------------------------------------------------- durations

describe('parseSong: durations', () => {
  it('splits bare chords equally (4/4, default pattern)', () => {
    const r = parseSong(src('tempo: 100', 'C G Am F |', 'C . G |', 'C G |', 'N.C. G |', 'C |'));
    expect(r.errors).toEqual([]);
    expect(chordsOf(r, 0)).toEqual([
      ['C', 1],
      ['G', 1],
      ['Am', 1],
      ['F', 1],
    ]);
    expect(chordsOf(r, 1)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 2)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 3)).toEqual([
      ['N.C.', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 4)).toEqual([['C', 4]]);
  });

  it('rejects a split that is not a multiple of the pattern grid', () => {
    const r = parseSong(src('tempo: 100', 'C G Am |'));
    expect(r.errors).toEqual([
      { line: 2, message: 'no se pueden repartir 4 beats entre 3 acordes; usa "." o "*n"', severity: 'error' },
    ]);
    expect(r.song.bars).toEqual([]);
  });

  it('the split grid depends on charsPerBeat of the pattern in effect', () => {
    const quarter = parseSong(src('tempo: 100', 'time: 3/4', 'strum: DUD', 'C G |'));
    expect(errorsOf(quarter).map((e) => [e.line, e.message])).toEqual([
      [4, 'no se pueden repartir 3 beats entre 2 acordes; usa "." o "*n"'],
    ]);
    const eighth = parseSong(src('tempo: 100', 'time: 3/4', 'strum: D-DUDU', 'C G |'));
    expect(eighth.errors).toEqual([]);
    expect(chordsOf(eighth, 0)).toEqual([
      ['C', 1.5],
      ['G', 1.5],
    ]);
    expect(beatsInBar(eighth, 0)).toEqual([0, 1, 1.5, 2, 2.5]);
    expect(eventsOfBar(eighth, 0).map((e) => e.chord.name)).toEqual(['C', 'C', 'G', 'G', 'G']);
    const sixteenth = parseSong(src('tempo: 100', 'strum: D-DUD-DUD-DUD-DU', 'C G Am |'));
    expect(errorsOf(sixteenth).length).toBe(1); // 16 grid units / 3 chords
    // "F ." is 2 explicit beats -> 2 beats (8 sixteenths) left for 3 bare chords: not splittable
    const bad16 = parseSong(src('tempo: 100', 'strum: D-DUD-DUD-DUD-DU', 'C G Am F . |'));
    expect(errorsOf(bad16).map((e) => e.message)).toEqual(['no se pueden repartir 2 beats entre 3 acordes; usa "." o "*n"']);
    // "Dm . ." is 3 explicit beats -> 1 beat (4 sixteenths) for 4 bare chords: a quarter beat each
    const ok16 = parseSong(src('tempo: 100', 'strum: D-DUD-DUD-DUD-DU', 'C G Am F Dm . . |'));
    expect(ok16.errors).toEqual([]);
    expect(chordsOf(ok16, 0)).toEqual([
      ['C', 0.25],
      ['G', 0.25],
      ['Am', 0.25],
      ['F', 0.25],
      ['Dm', 3],
    ]);
    // G starts on a '-' (k = 1) -> extra down event; the rest follow the D/U characters
    expect(beatsInBar(ok16, 0)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.5, 1.75, 2, 2.5, 2.75, 3, 3.5, 3.75]);
    expect(eventsOfBar(ok16, 0).slice(0, 6).map((e) => [e.chord.name, e.direction, e.chordChange])).toEqual([
      ['C', 'down', true],
      ['G', 'down', true],
      ['Am', 'down', true],
      ['F', 'up', true],
      ['Dm', 'down', true],
      ['Dm', 'down', false],
    ]);
    // the same bar on an eighth grid cannot be split (2 eighths / 4 chords)
    const bad8 = parseSong(src('tempo: 100', 'strum: D-DU-UDU', 'C G Am F Dm . . |'));
    expect(errorsOf(bad8).map((e) => e.message)).toEqual(['no se pueden repartir 1 beats entre 4 acordes; usa "." o "*n"']);
  });

  it('supports X*n and dots after it', () => {
    const r = parseSong(src('tempo: 100', 'Am*3 F |', 'C*2 G*2 |', 'C*4 |', '-*2 G . |', 'C*2 . G |', 'N.C.*2 G . |', 'G/B*1 C . . |'));
    expect(r.errors).toEqual([]);
    expect(chordsOf(r, 0)).toEqual([
      ['Am', 3],
      ['F', 1],
    ]);
    expect(chordsOf(r, 1)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 2)).toEqual([['C', 4]]);
    expect(chordsOf(r, 3)).toEqual([
      ['-', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 4)).toEqual([
      ['C', 3],
      ['G', 1],
    ]);
    expect(chordsOf(r, 5)).toEqual([
      ['N.C.', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 6)).toEqual([
      ['G/B', 1],
      ['C', 3],
    ]);
    expect(r.song.bars[6].chords[0].chord.bass).toBe(11);
  });

  it('rejects invalid *n durations', () => {
    const r = parseSong(src('tempo: 100', 'C*0 |', 'C*x |', '*3 |', 'C*2*2 |'));
    expect(errorsOf(r).map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(errorsOf(r)[0].message).toContain('duración inválida "C*0"');
    expect(errorsOf(r)[1].message).toContain('duración inválida "C*x"');
    expect(errorsOf(r)[2].message).toContain('duración inválida "*3"');
    expect(r.song.bars).toEqual([]);
  });

  it('reports overflow, full bar and incomplete bar', () => {
    const r = parseSong(src('tempo: 100', 'C . . . . |', 'C*5 |', 'C . . . G |', 'C . |', 'C*3 |', '- - |'));
    expect(r.errors).toEqual([
      { line: 2, message: 'compás sobrepasado: 5 beats en un compás de 4', severity: 'error' },
      { line: 3, message: 'compás sobrepasado: 5 beats en un compás de 4', severity: 'error' },
      { line: 4, message: 'compás lleno, G no cabe', severity: 'error' },
      { line: 5, message: 'compás incompleto: 2 de 4 beats', severity: 'error' },
      { line: 6, message: 'compás incompleto: 3 de 4 beats', severity: 'error' },
      { line: 7, message: 'compás incompleto: 2 de 4 beats', severity: 'error' },
    ]);
    expect(r.song.bars).toEqual([]);
  });

  it('a leading . prolongs the last group of the previous bar', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | . . G . |', '. . . . |', '. Am . . |'));
    expect(r.errors).toEqual([]);
    expect(chordsOf(r, 1)).toEqual([
      ['C', 2],
      ['G', 2],
    ]);
    expect(chordsOf(r, 2)).toEqual([['G', 4]]);
    expect(chordsOf(r, 3)).toEqual([
      ['G', 1],
      ['Am', 3],
    ]);
    // continuation is not a chord change
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2, 3]);
    expect(eventsOfBar(r, 1).map((e) => e.chordChange)).toEqual([false, false, true, false]);
    expect(eventsOfBar(r, 2).map((e) => e.chordChange)).toEqual([false, false, false, false]);
    expect(eventsOfBar(r, 3).map((e) => [e.chord.name, e.chordChange])).toEqual([
      ['G', false],
      ['Am', true],
      ['Am', false],
      ['Am', false],
    ]);
  });

  it('a leading . can prolong a rest', () => {
    const r = parseSong(src('tempo: 100', 'C . - . | . G . . |'));
    expect(r.errors).toEqual([]);
    expect(chordsOf(r, 1)).toEqual([
      ['-', 1],
      ['G', 3],
    ]);
    expect(beatsInBar(r, 1)).toEqual([1, 2, 3]);
    expect(eventsOfBar(r, 1)[0].chordChange).toBe(true);
  });

  it('a leading . without a previous bar is an error', () => {
    const r = parseSong(src('tempo: 100', '. . G . |'));
    expect(r.errors).toEqual([
      {
        line: 2,
        message: 'el compás empieza con "." pero no hay un compás anterior que prolongar',
        severity: 'error',
      },
    ]);
  });

  it('a bar that holds a chord for 6/8', () => {
    const r = parseSong(src('tempo: 120', 'time: 6/8', 'C . . . . . |', 'C*6 |', 'C G |', 'C G Am |'));
    expect(r.errors).toEqual([]);
    expect(r.song.timeSignature).toEqual({ beatsPerBar: 6, beatUnit: 8 });
    expect(r.song.bars.map((b) => b.beats)).toEqual([6, 6, 6, 6]);
    expect(chordsOf(r, 2)).toEqual([
      ['C', 3],
      ['G', 3],
    ]);
    expect(chordsOf(r, 3)).toEqual([
      ['C', 2],
      ['G', 2],
      ['Am', 2],
    ]);
    expect(r.song.totalBeats).toBe(24);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------- errors

describe('parseSong: errors', () => {
  it('reports invalid chord symbols with the line number and discards only that bar', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | hola . . . | G . . . |'));
    expect(r.errors).toEqual([{ line: 2, message: 'símbolo de acorde inválido: "hola"', severity: 'error' }]);
    expect(r.song.bars.length).toBe(2);
    expect(r.song.chordNames).toEqual(['C', 'G']);
    expect(r.song.bars[1].startBeat).toBe(4);
  });

  it('reports at most one error per line (the first invalid token)', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | hola . . . | ?? . . . | G . . . . |'));
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatchObject({ line: 2, severity: 'error' });
    expect(r.errors[0].message).toContain('"hola"');
    expect(r.song.bars.length).toBe(1);
  });

  it('adds the lyric hint when the line has no |', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'Ay, ay, ay, canta y no llores'));
    expect(errorsOf(r).length).toBe(1);
    expect(errorsOf(r)[0].line).toBe(3);
    expect(errorsOf(r)[0].message).toBe('símbolo de acorde inválido: "Ay,"; si es letra, empieza la línea con ">"');
    const withPipe = parseSong(src('tempo: 100', 'Ay, ay |'));
    expect(errorsOf(withPipe)[0].message).toBe('símbolo de acorde inválido: "Ay,"');
  });

  it('sorts errors by line', () => {
    const r = parseSong(src('tempo: 100', '[Nada]', 'tempo: 999', '[Otra]', 'C . . . |'));
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(r.errors[0].message).toContain('sección [Nada] vacía y no definida antes');
    expect(r.errors[1].message).toContain('tempo fuera de rango');
  });

  it('an error and a warning can share a line; the error comes first', () => {
    const r = parseSong('hola |');
    expect(r.errors).toEqual([
      { line: 1, message: 'símbolo de acorde inválido: "hola"', severity: 'error' },
      { line: 1, message: 'tempo no indicado, se usa 80', severity: 'warning' },
    ]);
  });

  it('chords unknown to the library are not errors (only the syntax is validated)', () => {
    const r = parseSong(src('tempo: 100', 'C#m7b5 . . . | Abaug . . . | Dbsus2 . . . | E9 . . . | Gb7sus4/Db . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.chordNames).toEqual(['C#m7b5', 'Abaug', 'Dbsus2', 'E9', 'Gb7sus4/Db']);
    expect(r.song.bars[4].chords[0].chord).toMatchObject({ root: 6, quality: '7sus4', bass: 1 });
  });

  it('never throws on garbage', () => {
    const r = parseSong('[[[\n]]]\n***\n|||\n:\n> \n#\n[]\n[x] x\nC*\n*\n. .\nx\n×3\n  x3');
    expect(r.song).toBeDefined();
    expect(r.errors.every((e) => e.line >= 1)).toBe(true);
    expect(r.song.bars).toEqual([]);
  });
});

// ---------------------------------------------------------------- tempo

describe('parseSong: tempo', () => {
  it('uses 80 with a warning when tempo is missing', () => {
    const r = parseSong('C . . . |');
    expect(r.song.tempo).toBe(80);
    expect(r.song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 80 }]);
    expect(r.errors).toEqual([{ line: 1, message: 'tempo no indicado, se usa 80', severity: 'warning' }]);
    expect(r.song.bars.length).toBe(1); // warnings keep everything
  });

  it('a tempo header only after the first bar still leaves the initial tempo at 80 (warning)', () => {
    const r = parseSong(src('C . . . |', 'tempo: 120', 'G . . . |'));
    expect(warningsOf(r).length).toBe(1);
    expect(r.song.tempo).toBe(80);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 80 },
      { fromBeat: 4, bpm: 120 },
    ]);
  });

  it('creates a tempo segment at the start of the next bar', () => {
    const r = parseSong(src('tempo: 120', 'C . . . | G . . . |', 'tempo: 60', 'Am . . . |', 'F . . . |', 'tempo: 60', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.tempo).toBe(120);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 120 },
      { fromBeat: 8, bpm: 60 },
    ]);
  });

  it('two tempo headers without bars in between: the last one wins', () => {
    const r = parseSong(src('tempo: 120', 'C . . . |', 'tempo: 60', 'tempo: 90', 'G . . . |'));
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 120 },
      { fromBeat: 4, bpm: 90 },
    ]);
    const before = parseSong(src('tempo: 60', 'tempo: 100', 'C . . . |'));
    expect(before.song.tempo).toBe(100);
    expect(before.song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 100 }]);
  });

  it('a tempo header after the last bar does not add a segment', () => {
    const r = parseSong(src('tempo: 120', 'C . . . |', 'tempo: 60'));
    expect(r.errors).toEqual([]);
    expect(r.song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 120 }]);
  });

  it('coalesces consecutive bars with the same bpm and returns to the previous tempo', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'tempo: 140', 'G . . . | Am . . . |', 'tempo: 100', 'F . . . |'));
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 4, bpm: 140 },
      { fromBeat: 12, bpm: 100 },
    ]);
  });

  it('coalesces the bars of a repeated line into one segment', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'tempo: 120', 'G . . . | Am . . . | x3', 'tempo: 100', 'F . . . | x2'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(9);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 4, bpm: 120 },
      { fromBeat: 28, bpm: 100 },
    ]);
  });

  it('rejects tempo out of 20..400 or non-numeric and ignores the header', () => {
    const r = parseSong(src('tempo: 500', 'tempo: 19', 'tempo: abc', 'C . . . |'));
    expect(r.errors.map((e) => [e.line, e.severity])).toEqual([
      [1, 'error'],
      [2, 'error'],
      [3, 'error'],
    ]);
    expect(r.errors[0].message).toContain('tempo fuera de rango: 500');
    expect(r.errors[1].message).toContain('tempo fuera de rango: 19');
    expect(r.errors[2].message).toContain('tempo inválido: "abc"');
    expect(r.song.tempo).toBe(80);
    expect(r.song.bars.length).toBe(1);
    const mid = parseSong(src('tempo: 100', 'C . . . |', 'tempo: 1000', 'G . . . |'));
    expect(errorsOf(mid).map((e) => e.line)).toEqual([3]);
    expect(mid.song.tempoSegments).toEqual([{ fromBeat: 0, bpm: 100 }]);
  });

  it('accepts the bounds, decimals and a bpm suffix', () => {
    expect(parseSong('tempo: 20').song.tempo).toBe(20);
    expect(parseSong('tempo: 400').song.tempo).toBe(400);
    expect(parseSong('tempo: 92.5').song.tempo).toBe(92.5);
    expect(parseSong('tempo: 110 bpm').song.tempo).toBe(110);
    expect(parseSong('tempo: 110 bpm').errors).toEqual([]);
  });

  it('song.tempo always equals tempoSegments[0].bpm', () => {
    for (const text of ['', 'tempo: 100', 'tempo: 100\nC . . . |', 'C . . . |\ntempo: 100\nG . . . |']) {
      const r = parseSong(text);
      expect(r.song.tempo).toBe(r.song.tempoSegments[0].bpm);
      expect(r.song.tempoSegments[0].fromBeat).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- time signature

describe('parseSong: time signature', () => {
  it('supports 4/4, 3/4, 2/4 and 6/8 and rejects others', () => {
    for (const [text, sig] of [
      ['4/4', [4, 4]],
      ['3/4', [3, 4]],
      ['2/4', [2, 4]],
      ['6/8', [6, 8]],
      ['6 / 8', [6, 8]],
    ] as const) {
      const r = parseSong(src('tempo: 100', `time: ${text}`, 'C*' + sig[0] + ' |'));
      expect(r.errors).toEqual([]);
      expect(r.song.timeSignature).toEqual({ beatsPerBar: sig[0], beatUnit: sig[1] });
    }
    const bad = parseSong(src('tempo: 100', 'time: 5/4', 'time: 4', 'time: 7/8', 'C . . . |'));
    expect(errorsOf(bad).map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errorsOf(bad)[0].message).toContain('compás no soportado: "5/4"');
    expect(bad.song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
  });

  it('a mid-song time change applies to the following bars; Song.timeSignature is the initial one', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'time: 3/4', 'G . . |', 'time: 2/4', 'Am . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
    expect(r.song.bars.map((b) => b.beats)).toEqual([4, 3, 2]);
    expect(r.song.bars.map((b) => b.startBeat)).toEqual([0, 4, 7]);
    expect(r.song.totalBeats).toBe(9);
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2]);
    expect(beatsInBar(r, 2)).toEqual([0, 1]);
  });

  it('time before any bar sets the initial signature (last one wins)', () => {
    const r = parseSong(src('tempo: 100', 'time: 6/8', 'time: 3/4', 'C . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.timeSignature).toEqual({ beatsPerBar: 3, beatUnit: 4 });
  });

  it('reverts an explicit pattern that no longer fits with a warning', () => {
    const r = parseSong(src('tempo: 100', 'strum: D-DU-UDU', 'C . . . |', 'time: 3/4', 'G . . |'));
    expect(errorsOf(r)).toEqual([]);
    expect(warningsOf(r)).toEqual([
      {
        line: 4,
        message: 'el patrón de rasgueo "D-DU-UDU" no encaja en 3/4; se usa el patrón por defecto "D-D-D-"',
        severity: 'warning',
      },
    ]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2]);
  });

  it('does not warn when the pattern in effect is the default one', () => {
    const r = parseSong(src('tempo: 100', 'time: 3/4', 'C . . |', 'time: 6/8', 'G*6 |', 'time: 4/4', 'Am . . . |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2]);
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(beatsInBar(r, 2)).toEqual([0, 1, 2, 3]);
  });

  it('the default pattern always follows a time change, even when the old default would fit', () => {
    // 4/4 default "D-D-D-D-" (8 chars) would fit 2/4 as sixteenths; 3/4 default (6) would fit 6/8 as quarters
    const r = parseSong(src('tempo: 100', 'C . . . |', 'time: 2/4', 'G . |', 'time: 3/4', 'Am . . |', 'time: 6/8', 'F*6 |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]);
    expect(beatsInBar(r, 1)).toEqual([0, 1]);
    expect(beatsInBar(r, 2)).toEqual([0, 1, 2]);
    expect(beatsInBar(r, 3)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.song.events.every((e) => e.direction === 'down' && !e.muted)).toBe(true);
    // after reverting an explicit pattern, the pattern is a default again and keeps following time
    const reverted = parseSong(src('tempo: 100', 'strum: D-DU-UDU', 'C . . . |', 'time: 3/4', 'G . . |', 'time: 6/8', 'Am*6 |'));
    expect(warningsOf(reverted).map((e) => e.line)).toEqual([4]);
    expect(beatsInBar(reverted, 2)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps an explicit pattern that still fits the new signature', () => {
    const r = parseSong(src('tempo: 100', 'strum: D-DU-UDU', 'C . . . |', 'time: 2/4', 'G . |'));
    expect(r.errors).toEqual([]);
    // 8 chars in 2/4 -> 4 chars per beat (sixteenths)
    expect(beatsInBar(r, 1)).toEqual([0, 0.5, 0.75, 1.25, 1.5, 1.75]);
  });
});

// ---------------------------------------------------------------- strum patterns

describe('parseSong: strum patterns', () => {
  it('4 characters: one event per beat, D/U directions', () => {
    const r = parseSong(src('tempo: 100', 'strum: DUDU', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]);
    expect(eventsOfBar(r, 0).map((e) => e.direction)).toEqual(['down', 'up', 'down', 'up']);
    expect(eventsOfBar(r, 0).every((e) => !e.muted)).toBe(true);
  });

  it('8 characters: eighths', () => {
    const r = parseSong(src('tempo: 100', 'strum: DUDUDUDU', 'C . . . |'));
    expect(beatsInBar(r, 0)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  });

  it('16 characters: sixteenths', () => {
    const r = parseSong(src('tempo: 100', 'strum: D--UD--UD--UD--U', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 0.75, 1, 1.75, 2, 2.75, 3, 3.75]);
    expect(eventsOfBar(r, 0).map((e) => e.direction)).toEqual(['down', 'up', 'down', 'up', 'down', 'up', 'down', 'up']);
  });

  it('x is a muted down-strum', () => {
    const r = parseSong(src('tempo: 100', 'strum: DxUx', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(eventsOfBar(r, 0).map((e) => [e.direction, e.muted])).toEqual([
      ['down', false],
      ['down', true],
      ['up', false],
      ['down', true],
    ]);
    expect(eventsOfBar(r, 0).every((e) => e.chord.name === 'C')).toBe(true);
  });

  it('a muted event can be the chord change and carries the chord in effect', () => {
    const r = parseSong(src('tempo: 100', 'strum: xUDU', 'C G |'));
    expect(r.errors).toEqual([]);
    expect(eventsOfBar(r, 0).map((e) => [e.beatInBar, e.chord.name, e.muted, e.chordChange])).toEqual([
      [0, 'C', true, true],
      [1, 'C', false, false],
      [2, 'G', false, true],
      [3, 'G', false, false],
    ]);
  });

  it('a 12-character pattern in 6/8 is a sixteenth grid (2 characters per beat)', () => {
    const r = parseSong(src('tempo: 120', 'time: 6/8', 'strum: DUDUDUDUDUDU', 'C*6 |', 'strum: D-D-D-D-D-D-D-D-D-D-D-D-', 'G*6 |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
    expect(beatsInBar(r, 1)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
  });

  it('rejects wrong lengths with the expected message and keeps the current pattern', () => {
    const r = parseSong(src('tempo: 100', 'strum: DUDUDU', 'C . . . |', 'time: 3/4', 'strum: DUDU', 'G . . |', 'time: 6/8', 'strum: DUDUDUDUDU', 'Am*6 |'));
    expect(errorsOf(r).map((e) => [e.line, e.message])).toEqual([
      [2, 'patrón de 6 caracteres; se esperaban 4, 8 o 16 para 4/4'],
      [5, 'patrón de 4 caracteres; se esperaban 3, 6 o 12 para 3/4'],
      [8, 'patrón de 10 caracteres; se esperaban 6, 12 o 24 para 6/8'],
    ]);
    expect(warningsOf(r)).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]); // default pattern still in effect
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2]);
    expect(beatsInBar(r, 2)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects invalid characters and empty patterns', () => {
    const r = parseSong(src('tempo: 100', 'strum: DUQU', 'strum:', 'C . . . |'));
    expect(errorsOf(r).map((e) => e.line)).toEqual([2, 3]);
    expect(errorsOf(r)[0].message).toContain('patrón de rasgueo inválido: "DUQU"');
    expect(errorsOf(r)[1].message).toContain('patrón de rasgueo vacío');
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]);
  });

  it('accepts lowercase letters and spaces inside the pattern', () => {
    const r = parseSong(src('tempo: 100', 'strum: d-du -udu', 'C . . . |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(eventsOfBar(r, 0).map((e) => e.direction)).toEqual(['down', 'down', 'up', 'up', 'down', 'up']);
  });

  it('a mid-song strum change applies to the following bars only', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'strum: DUDUDUDU', 'G . . . |'));
    expect(r.errors).toEqual([]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]);
    expect(beatsInBar(r, 1)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  });

  it('creates an extra down event when the chord changes on a -', () => {
    const r = parseSong(src('tempo: 100', 'strum: D---', 'C G |', 'G . . . |', 'Am*3 F |'));
    expect(r.errors).toEqual([]);
    const ev = r.song.events.map((e) => [e.time, e.chord.name, e.direction, e.chordChange]);
    expect(ev).toEqual([
      [0, 'C', 'down', true],
      [2, 'G', 'down', true],
      [4, 'G', 'down', false],
      [8, 'Am', 'down', true],
      [11, 'F', 'down', true],
    ]);
  });

  it('does not create an extra event on - when the chord does not change', () => {
    const r = parseSong(src('tempo: 100', 'strum: -D--', 'C . . . | C . . . | Cmaj . . . | G . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.events.map((e) => [e.time, e.chord.name, e.chordChange])).toEqual([
      [0, 'C', true], // song start on a '-': extra event
      [1, 'C', false],
      [5, 'C', false],
      [9, 'Cmaj', false], // same root/quality/bass as C
      [12, 'G', true], // change on a '-': extra event
      [13, 'G', false],
    ]);
    expect(r.song.events[0].direction).toBe('down');
  });

  it('creates the extra event when a chord starts after a rest on a -', () => {
    const r = parseSong(src('tempo: 100', 'strum: D---', 'C . - . | C . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.events.map((e) => [e.time, e.chordChange])).toEqual([
      [0, true],
      [4, true],
    ]);
  });

  it('creates the extra event for an N.C. start on a -', () => {
    const r = parseSong(src('tempo: 100', 'strum: D---', 'C N.C. |'));
    expect(r.song.events.map((e) => [e.time, e.chord.quality, e.chordChange])).toEqual([
      [0, 'maj', true],
      [2, 'nc', true],
    ]);
  });
});

// ---------------------------------------------------------------- rests and N.C.

describe('parseSong: rests and N.C.', () => {
  it('rests generate no events and are stored as name "-" quality nc', () => {
    const r = parseSong(src('tempo: 100', '- - G . |', 'C . - . |', '- . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars[0].chords[0].chord).toEqual({ name: '-', root: -1, quality: 'nc', bass: null });
    expect(beatsInBar(r, 0)).toEqual([2, 3]);
    expect(eventsOfBar(r, 0)[0].chordChange).toBe(true);
    expect(beatsInBar(r, 1)).toEqual([0, 1]);
    expect(eventsOfBar(r, 2)).toEqual([]);
    expect(chordsOf(r, 2)).toEqual([['-', 4]]);
    expect(r.song.chordNames).toEqual(['G', 'C']);
  });

  it('the first event after a rest is a chord change even with the same chord', () => {
    const r = parseSong(src('tempo: 100', 'C . - . | C . . . |'));
    expect(eventsOfBar(r, 1)[0].chordChange).toBe(true);
    const noRest = parseSong(src('tempo: 100', 'C . . . | C . . . |'));
    expect(eventsOfBar(noRest, 1)[0].chordChange).toBe(false);
  });

  it('N.C. and NC generate nc events (the ball bounces), excluded from chordNames', () => {
    const r = parseSong(src('tempo: 100', 'N.C. | G . . . |', 'NC . . . |', 'n.c. G |'));
    expect(r.errors).toEqual([]);
    const b0 = eventsOfBar(r, 0);
    expect(b0.length).toBe(4);
    expect(b0.every((e) => e.chord.quality === 'nc' && e.chord.root === -1 && e.chord.bass === null)).toBe(true);
    expect(b0[0].chord.name).toBe('N.C.');
    expect(b0.map((e) => e.chordChange)).toEqual([true, false, false, false]);
    expect(eventsOfBar(r, 1)[0].chordChange).toBe(true);
    expect(eventsOfBar(r, 2)[0].chord.name).toBe('NC');
    expect(eventsOfBar(r, 2)[0].chordChange).toBe(true);
    expect(chordsOf(r, 3)).toEqual([
      ['n.c.', 2],
      ['G', 2],
    ]);
    expect(r.song.chordNames).toEqual(['G']);
  });

  it('the same chord before and after an N.C. is a chord change on both sides', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | N.C. | C . . . |'));
    expect(eventsOfBar(r, 1)[0].chordChange).toBe(true);
    expect(eventsOfBar(r, 2)[0].chordChange).toBe(true);
  });
});

// ---------------------------------------------------------------- line repeats

describe('parseSong: line repeats x<n>', () => {
  it('x3 repeats the bars of the line 3 times', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | G . . . | x3', 'Am . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => b.chords[0].chord.name)).toEqual(['C', 'G', 'C', 'G', 'C', 'G', 'Am']);
    expect(r.song.bars.map((b) => b.startBeat)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    expect(r.song.events.filter((e) => e.chordChange).length).toBe(7);
  });

  it('accepts ×, X, no final bar and x1', () => {
    expect(parseSong(src('tempo: 100', 'C . . . ×2')).song.bars.length).toBe(2);
    expect(parseSong(src('tempo: 100', 'C . . . | X4')).song.bars.length).toBe(4);
    expect(parseSong(src('tempo: 100', 'C . . . | x1')).song.bars.length).toBe(1);
    expect(parseSong(src('tempo: 100', 'C . . . | x32')).song.bars.length).toBe(32);
  });

  it('x0 and x99 are errors and the line is discarded', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | x0', 'G . . . | x99', 'Am . . . | x33'));
    expect(r.errors.map((e) => [e.line, e.severity])).toEqual([
      [2, 'error'],
      [3, 'error'],
      [4, 'error'],
    ]);
    expect(r.errors[0].message).toContain('repetición x0 fuera de rango (1..32)');
    expect(r.errors[1].message).toContain('repetición x99 fuera de rango (1..32)');
    expect(r.song.bars).toEqual([]);
  });

  it('x2 inside a bar is a symbol error; the other bars are kept', () => {
    const r = parseSong(src('tempo: 100', 'C x2 | G . . . |', 'C . . . |x2'));
    expect(errorsOf(r).map((e) => e.line)).toEqual([2, 3]);
    expect(errorsOf(r)[0].message).toContain('símbolo inválido "x2"');
    expect(errorsOf(r)[1].message).toContain('símbolo inválido "x2"');
    expect(r.song.bars.map((b) => b.chords[0].chord.name)).toEqual(['G', 'C']);
  });

  it('a line with only x2 is an error', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'x2', '| x3'));
    expect(errorsOf(r).map((e) => e.line)).toEqual([3, 4]);
    expect(errorsOf(r)[0].message).toContain('sin compases');
    expect(r.song.bars.length).toBe(1);
  });

  it('repeats only the valid bars of the line', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | hola | x2'));
    expect(errorsOf(r).length).toBe(1);
    expect(r.song.bars.map((b) => b.chords[0].chord.name)).toEqual(['C', 'C']);
  });
});

// ---------------------------------------------------------------- sections

describe('parseSong: sections', () => {
  it('labels the following bars; bars before the first header have section null', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', '[Intro]', 'G . . . | Am . . . |', '[Estrofa]', 'F . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => b.section)).toEqual([null, 'Intro', 'Intro', 'Estrofa']);
  });

  it('[Section] x2 inserts the section twice', () => {
    const r = parseSong(src('tempo: 100', '[Estribillo] x2', 'C . . . | G . . . |', '[Final]', 'F . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => [b.section, b.chords[0].chord.name])).toEqual([
      ['Estribillo', 'C'],
      ['Estribillo', 'G'],
      ['Estribillo', 'C'],
      ['Estribillo', 'G'],
      ['Final', 'F'],
    ]);
    expect(r.song.totalBeats).toBe(20);
    expect(r.song.events.filter((e) => e.chordChange).length).toBe(5);
  });

  it('an empty [Section] recalls the last definition (case and spacing insensitive)', () => {
    const r = parseSong(src('tempo: 100', '[Estrofa]', 'C . . . | G . . . |', '[Estribillo]', 'F . . . |', '[ estrofa ]', '[ESTRIBILLO] x2', '[Estrofa]x2'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => [b.section, b.chords[0].chord.name])).toEqual([
      ['Estrofa', 'C'],
      ['Estrofa', 'G'],
      ['Estribillo', 'F'],
      ['Estrofa', 'C'],
      ['Estrofa', 'G'],
      ['Estribillo', 'F'],
      ['Estribillo', 'F'],
      ['Estrofa', 'C'],
      ['Estrofa', 'G'],
      ['Estrofa', 'C'],
      ['Estrofa', 'G'],
    ]);
    expect(r.song.bars.map((b) => b.startBeat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
  });

  it('an empty section that was never defined is an error with the header line', () => {
    const r = parseSong(src('tempo: 100', '[Intro]', 'C . . . |', '[Puente]', '[Intro]', '[Coda] x2'));
    expect(r.errors).toEqual([
      { line: 4, message: 'sección [Puente] vacía y no definida antes', severity: 'error' },
      { line: 6, message: 'sección [Coda] vacía y no definida antes', severity: 'error' },
    ]);
    expect(r.song.bars.length).toBe(2);
  });

  it('a section whose only bar line is invalid is not treated as a recall', () => {
    const r = parseSong(src('tempo: 100', '[Intro]', 'hola . . . |'));
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].line).toBe(3);
  });

  it('a section with bars redefines the name', () => {
    const r = parseSong(src('tempo: 100', '[A]', 'C . . . |', '[A]', 'G . . . |', '[A]'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => b.chords[0].chord.name)).toEqual(['C', 'G', 'G']);
  });

  it('copies keep their own tempo, strum and time (headers never affect copies)', () => {
    const r = parseSong(
      src(
        'tempo: 100',
        'strum: DUDU',
        '[A]',
        'C . . . |',
        'tempo: 140',
        'strum: D-DU-UDU',
        'time: 3/4',
        '[B]',
        'G . . |',
        '[A]',
        '[B]',
      ),
    );
    expect(errorsOf(r)).toEqual([]);
    expect(r.song.bars.map((b) => [b.section, b.beats, b.startBeat])).toEqual([
      ['A', 4, 0],
      ['B', 3, 4],
      ['A', 4, 7],
      ['B', 3, 11],
    ]);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 4, bpm: 140 },
      { fromBeat: 7, bpm: 100 },
      { fromBeat: 11, bpm: 140 },
    ]);
    expect(beatsInBar(r, 0)).toEqual([0, 1, 2, 3]);
    expect(beatsInBar(r, 2)).toEqual([0, 1, 2, 3]);
    expect(eventsOfBar(r, 2).map((e) => e.direction)).toEqual(['down', 'up', 'down', 'up']);
    expect(beatsInBar(r, 1)).toEqual([0, 1, 2]);
    expect(beatsInBar(r, 3)).toEqual([0, 1, 2]);
    expect(r.song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
  });

  it('a mid-section tempo change is preserved inside every copy', () => {
    const r = parseSong(src('tempo: 100', '[A] x2', 'C . . . |', 'tempo: 120', 'G . . . |', '[A]'));
    expect(r.errors).toEqual([]);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 4, bpm: 120 },
      { fromBeat: 8, bpm: 100 },
      { fromBeat: 12, bpm: 120 },
      { fromBeat: 16, bpm: 100 },
      { fromBeat: 20, bpm: 120 },
    ]);
  });

  it('rejects x0/x99 on sections (treated as x1) and malformed headers', () => {
    const r = parseSong(src('tempo: 100', '[A] x0', 'C . . . |', '[A] x99', '[B] foo', 'G . . . |', '[]', '[C'));
    expect(errorsOf(r).map((e) => e.line)).toEqual([2, 4, 5, 7, 8]);
    expect(errorsOf(r)[0].message).toContain('repetición x0 fuera de rango (1..32)');
    expect(errorsOf(r)[1].message).toContain('repetición x99 fuera de rango (1..32)');
    expect(errorsOf(r)[2].message).toContain('texto inesperado tras la sección [B]');
    expect(errorsOf(r)[3].message).toContain('nombre de sección vacío');
    expect(errorsOf(r)[4].message).toContain('cabecera de sección inválida');
    expect(r.song.bars.map((b) => [b.section, b.chords[0].chord.name])).toEqual([
      ['A', 'C'],
      ['A', 'C'],
      ['B', 'G'],
    ]);
  });

  it('events are generated over the expanded bar list (chordChange looks across copy boundaries)', () => {
    const r = parseSong(src('tempo: 100', '[A]', 'C . . . |', '[A]', '[B]', 'G . . . |', '[A] x2'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((b) => b.chords[0].chord.name)).toEqual(['C', 'C', 'G', 'C', 'C']);
    expect(r.song.bars.map((_, i) => eventsOfBar(r, i)[0].chordChange)).toEqual([true, false, true, true, false]);
    expect(r.song.events.map((e) => e.barIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    expect(r.song.events.map((e) => e.time)).toEqual(r.song.events.map((_, i) => i));
  });

  it('a leading . after a section copy prolongs the last copied bar', () => {
    const r = parseSong(src('tempo: 100', '[A]', 'C . G . |', '[A]', '[B]', '. . Am . |'));
    expect(r.errors).toEqual([]);
    expect(chordsOf(r, 2)).toEqual([
      ['G', 2],
      ['Am', 2],
    ]);
  });
});

// ---------------------------------------------------------------- lyrics

describe('parseSong: lyrics', () => {
  it('never produces errors or bars and attaches to the first bar of the previous bar line', () => {
    const r = parseSong(src('tempo: 100', '> antes de todo', 'C . . . | G . . . |', '> primera', 'Am . . . | F . . . | x2', '> segunda', '> tercera | con | barras', '>   con espacios   '));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(6);
    expect(r.song.lyricLines).toEqual([
      { barIndex: 0, text: 'antes de todo' },
      { barIndex: 0, text: 'primera' },
      { barIndex: 2, text: 'segunda' },
      { barIndex: 2, text: 'tercera | con | barras' },
      { barIndex: 2, text: 'con espacios' },
    ]);
  });

  it('accepts indentation before > and an empty lyric, and never parses its content as chords', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', '   > hola x2 [Intro] tempo: 999', '>', '> C*9 | ??'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(1);
    expect(r.song.tempo).toBe(100);
    expect(r.song.lyricLines).toEqual([
      { barIndex: 0, text: 'hola x2 [Intro] tempo: 999' },
      { barIndex: 0, text: '' },
      { barIndex: 0, text: 'C*9 | ??' },
    ]);
  });

  it('a lyric after an invalid line keeps the previous attachment', () => {
    const r = parseSong(src('tempo: 100', 'C . . . |', 'G . . . |', 'hola |', '> letra'));
    expect(r.song.lyricLines).toEqual([{ barIndex: 1, text: 'letra' }]);
  });

  it('lyrics are copied with repeated and recalled sections', () => {
    const r = parseSong(src('tempo: 100', '[A]', 'C . . . | G . . . |', '> hola', 'Am . . . |', '> adiós', '[B]', 'F . . . |', '> puente', '[A]', '[B] x2'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.length).toBe(9);
    expect(r.song.lyricLines).toEqual([
      { barIndex: 0, text: 'hola' },
      { barIndex: 2, text: 'adiós' },
      { barIndex: 3, text: 'puente' },
      { barIndex: 4, text: 'hola' },
      { barIndex: 6, text: 'adiós' },
      { barIndex: 7, text: 'puente' },
      { barIndex: 8, text: 'puente' },
    ]);
  });

  it('[Section] x2 with bars copies its lyrics into every copy', () => {
    const r = parseSong(src('tempo: 100', '[A] x2', 'C . . . |', '> uno', 'G . . . |', '> dos'));
    expect(r.song.lyricLines).toEqual([
      { barIndex: 0, text: 'uno' },
      { barIndex: 1, text: 'dos' },
      { barIndex: 2, text: 'uno' },
      { barIndex: 3, text: 'dos' },
    ]);
  });

  it('lyrics written under a recall attach to the first inserted bar', () => {
    const r = parseSong(src('tempo: 100', '[A]', 'C . . . |', '> uno', '[B]', 'G . . . |', '[A]', '> otra letra'));
    expect(r.errors).toEqual([]);
    expect(r.song.lyricLines).toEqual([
      { barIndex: 0, text: 'uno' },
      { barIndex: 2, text: 'uno' },
      { barIndex: 2, text: 'otra letra' },
    ]);
  });
});

// ---------------------------------------------------------------- chordChange

describe('parseSong: chordChange', () => {
  it('is true on the first event and when root, quality or bass differ', () => {
    const r = parseSong(src('tempo: 100', 'C . . . | Cmaj . . . | G . . . | G/B . . . | G . . . | Gm . . . | Gm . . . |'));
    expect(r.errors).toEqual([]);
    expect(r.song.bars.map((_, i) => eventsOfBar(r, i)[0].chordChange)).toEqual([true, false, true, true, true, true, false]);
    // never inside a held chord
    r.song.bars.forEach((_, i) => {
      expect(eventsOfBar(r, i).slice(1).every((e) => !e.chordChange)).toBe(true);
    });
  });

  it('compares enharmonic spellings by pitch class', () => {
    const r = parseSong(src('tempo: 100', 'Bb . . . | A# . . . |'));
    expect(r.errors).toEqual([]);
    expect(eventsOfBar(r, 1)[0].chordChange).toBe(false);
    expect(r.song.chordNames).toEqual(['Bb', 'A#']);
  });
});

// ---------------------------------------------------------------- capo

describe('parseSong: capo', () => {
  it('defaults to 0, accepts 0..12 and rejects the rest', () => {
    expect(parseSong('tempo: 100').song.capo).toBe(0);
    expect(parseSong('tempo: 100\ncapo: 0').song.capo).toBe(0);
    expect(parseSong('tempo: 100\ncapo: 12').song.capo).toBe(12);
    expect(parseSong('tempo: 100\ncapo: 12').errors).toEqual([]);
    for (const bad of ['13', '-1', '2.5', 'x', '']) {
      const r = parseSong(`tempo: 100\ncapo: ${bad}\ncapo: 4\ncapo: 20`);
      expect(errorsOf(r).map((e) => e.line)).toEqual([2, 4]);
      expect(errorsOf(r)[0].message).toContain('cejilla inválida');
      expect(r.song.capo).toBe(4);
    }
  });
});
