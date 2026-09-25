import { describe, expect, it } from 'vitest';
import type { ChordTranscription, TranscribedBar } from '../../src/types';
import { chartFromTranscription, defaultChartStrum, replaceChart } from '../../src/song/chartFromTranscription';
import { transcribeChords } from '../../src/dsp/chordTranscribe';
import { parseSong } from '../../src/song/parser';
import { synthProgression, synthStructuredSong } from '../helpers/synth';

function transcription(bars: TranscribedBar[], patch: Partial<ChordTranscription> = {}): ChordTranscription {
  const beatsPerBar = patch.beatsPerBar ?? 4;
  const beats: ChordTranscription['beats'] = [];
  for (const bar of bars) {
    for (const c of bar.chords) {
      for (let i = 0; i < c.beats; i++) beats.push({ timeSec: beats.length * 0.6, chord: c.chord, score: 0.8 });
    }
  }
  return {
    bpm: 99.6,
    beatsPerBar,
    firstDownbeatSec: 1.5,
    key: { root: 0, mode: 'major', name: 'Do mayor' },
    beats,
    bars,
    confidence: 0.3,
    ...patch,
  };
}

const FIVE_BARS: TranscribedBar[] = [
  { startBeat: 0, chords: [{ chord: 'C', beats: 4 }] },
  { startBeat: 4, chords: [{ chord: 'G', beats: 2 }, { chord: 'Am', beats: 2 }] },
  { startBeat: 8, chords: [{ chord: null, beats: 4 }] },
  { startBeat: 12, chords: [{ chord: 'F#m', beats: 3 }, { chord: 'D', beats: 1 }] },
  { startBeat: 16, chords: [{ chord: 'E', beats: 4 }] },
];

/** Bars of a parsed song as [name, beats] pairs (N.C. -> null). */
function parsedBars(source: string) {
  const { song, errors } = parseSong(source);
  return {
    song,
    errors,
    bars: song.bars.map((b) => b.chords.map((c) => [c.chord.quality === 'nc' ? null : c.chord.name, c.beats] as [string | null, number])),
  };
}

describe('chartFromTranscription', () => {
  it('writes headers, the comment line and 4 bars per line with "." continuations and N.C.', () => {
    const text = chartFromTranscription(transcription(FIVE_BARS), { title: 'Prueba', artist: 'Yo' });
    expect(text.split('\n')).toEqual([
      'title: Prueba',
      'artist: Yo',
      'tempo: 100',
      'time: 4/4',
      'strum: D-D-D-D-',
      '# Acordes detectados automáticamente: revisa y corrige. Tonalidad: Do mayor',
      'C . . . | G . Am . | N.C. . . . | F#m . . D |',
      'E . . . |',
      '',
    ]);
  });

  it('parses without errors or warnings and reproduces the bars', () => {
    const text = chartFromTranscription(transcription(FIVE_BARS), { title: 'Prueba', artist: 'Yo' });
    const { song, errors, bars } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.title).toBe('Prueba');
    expect(song.artist).toBe('Yo');
    expect(song.tempo).toBe(100);
    expect(song.timeSignature).toEqual({ beatsPerBar: 4, beatUnit: 4 });
    expect(song.capo).toBe(0);
    expect(bars).toEqual([
      [['C', 4]],
      [['G', 2], ['Am', 2]],
      [[null, 4]],
      [['F#m', 3], ['D', 1]],
      [['E', 4]],
    ]);
    expect(song.chordNames).toEqual(['C', 'G', 'Am', 'F#m', 'D', 'E']);
    expect(song.totalBeats).toBe(20);
  });

  it('3/4 uses time 3/4 and strum D-D-D-; opts.strum overrides; no artist line without artist', () => {
    const bars: TranscribedBar[] = [
      { startBeat: 0, chords: [{ chord: 'Am', beats: 3 }] },
      { startBeat: 3, chords: [{ chord: 'F', beats: 2 }, { chord: 'C', beats: 1 }] },
    ];
    const text = chartFromTranscription(transcription(bars, { beatsPerBar: 3, bpm: 90.4 }), { title: 'Vals' });
    expect(text).toContain('time: 3/4\n');
    expect(text).toContain('strum: D-D-D-\n');
    expect(text).toContain('tempo: 90\n');
    expect(text).not.toContain('artist:');
    expect(text).toContain('Am . . | F . C |\n');
    const { errors, bars: parsed, song } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.timeSignature.beatsPerBar).toBe(3);
    expect(parsed).toEqual([[['Am', 3]], [['F', 2], ['C', 1]]]);

    const custom = chartFromTranscription(transcription(bars, { beatsPerBar: 3 }), { title: 'Vals', strum: 'DDU' });
    expect(custom).toContain('strum: DDU\n');
    expect(parseSong(custom).errors).toEqual([]);
    expect(defaultChartStrum(4)).toBe('D-D-D-D-');
    expect(defaultChartStrum(3)).toBe('D-D-D-');
    expect(defaultChartStrum(2)).toBe('D-D-');
  });

  it('an empty transcription gives a chart with headers only that still parses cleanly', () => {
    const text = chartFromTranscription(transcription([]), { title: 'Vacía' });
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.bars).toEqual([]);
    expect(song.title).toBe('Vacía');
    expect(song.tempo).toBe(100);
  });

  it('keeps the key name and multi-word / accented titles on one line', () => {
    const t = transcription(FIVE_BARS, { key: { root: 6, mode: 'minor', name: 'Fa# menor' } });
    const text = chartFromTranscription(t, { title: 'Canción\ncon salto', artist: '  Los  Artistas ' });
    expect(text).toContain('Tonalidad: Fa# menor');
    expect(text).toContain('title: Canción con salto\n');
    expect(text).toContain('artist: Los Artistas\n');
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.title).toBe('Canción con salto');
  });

  it('round trip: audio -> transcribeChords -> chart -> parseSong reproduces the bars', () => {
    const p = synthProgression(['C', 'G', 'Am', 'F'], 44100, { bpm: 100, rounds: 1, seed: 21 });
    const t = transcribeChords(p.signal, 44100);
    const text = chartFromTranscription(t, { title: 'Desde audio' });
    const { song, errors, bars } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.tempo).toBe(Math.round(t.bpm));
    expect(bars).toEqual(t.bars.map((b) => b.chords.map((c) => [c.chord, c.beats])));
    expect(bars).toEqual([[['C', 4]], [['G', 4]], [['Am', 4]], [['F', 4]]]);
  });
});

describe('chartFromTranscription tempo map and sections (SPEC 15)', () => {
  /** 16 bars of one chord each, cycling C G Am F. */
  const SIXTEEN: TranscribedBar[] = Array.from({ length: 16 }, (_, i) => ({
    startBeat: 4 * i,
    chords: [{ chord: ['C', 'G', 'Am', 'F'][i % 4], beats: 4 }],
  }));

  it('barTempos [100 x 8, 104 x 8] -> one "tempo: 104" line before bar 9 and two tempo segments', () => {
    const t = transcription(SIXTEEN, { bpm: 100, barTempos: [...Array(8).fill(100), ...Array(8).fill(104)] });
    const text = chartFromTranscription(t, { title: 'Cambio' });
    const lines = text.split('\n');
    const tempoLines = lines.map((l, i) => [l, i] as [string, number]).filter(([l]) => /^tempo:/.test(l));
    expect(tempoLines.map(([l]) => l)).toEqual(['tempo: 100', 'tempo: 104']);
    // The change line sits right after the second bar line (bars 5-8) and before the third (bars 9-12).
    const barLines = lines.map((l, i) => [l, i] as [string, number]).filter(([l]) => /\|\s*$/.test(l));
    expect(barLines).toHaveLength(4);
    expect(tempoLines[1][1]).toBe(barLines[1][1] + 1);
    expect(tempoLines[1][1]).toBe(barLines[2][1] - 1);
    const { song, errors, bars } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.tempo).toBe(100);
    expect(song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 32, bpm: 104 },
    ]);
    expect(bars).toHaveLength(16);
    expect(song.bars[8].startBeat).toBe(32);
  });

  it('without tempo changes there is no extra tempo line; below 1.5 % or not sustained is ignored', () => {
    const flat = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, barTempos: Array(16).fill(100) }), { title: 'Plano' });
    expect(flat.match(/^tempo:/gm)).toHaveLength(1);
    expect(parseSong(flat).song.tempoSegments).toHaveLength(1);
    // 1 % away: nothing.
    const small = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, barTempos: [...Array(8).fill(100), ...Array(8).fill(101)] }), { title: 'Poco' });
    expect(small.match(/^tempo:/gm)).toHaveLength(1);
    // A single fast bar (glitch) in the middle: nothing.
    const glitch = Array(16).fill(100);
    glitch[7] = 110;
    const g = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, barTempos: glitch }), { title: 'Glitch' });
    expect(g.match(/^tempo:/gm)).toHaveLength(1);
    // A change only on the last two bars: never on the last bar, and the sustained rule needs a following bar.
    const tail = Array(16).fill(100);
    tail[15] = 110;
    const tl = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, barTempos: tail }), { title: 'Cola' });
    expect(tl.match(/^tempo:/gm)).toHaveLength(1);
    // No barTempos at all (constant grid): unchanged output.
    expect(chartFromTranscription(transcription(SIXTEEN, { bpm: 100 }), { title: 'Plano' })).toBe(flat);
  });

  it('a ramp writes at most one tempo line every 2 bars, with one decimal, and the parser follows it', () => {
    // 96 -> 104 over 16 bars (0.5 BPM per bar): sustained drift, a new line every few bars.
    const ramp = Array.from({ length: 16 }, (_, i) => Math.round((96 + 0.5 * i) * 10) / 10);
    const t = transcription(SIXTEEN, { bpm: 100, barTempos: ramp });
    const text = chartFromTranscription(t, { title: 'Rampa' });
    const lines = text.split('\n');
    const changeBars: number[] = [];
    let bar = 0;
    for (const l of lines) {
      if (/^tempo:/.test(l) && bar > 0) changeBars.push(bar);
      if (/\|\s*$/.test(l)) bar += l.split('|').filter((s) => s.trim() !== '').length;
    }
    expect(changeBars.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < changeBars.length; i++) expect(changeBars[i] - changeBars[i - 1]).toBeGreaterThanOrEqual(2);
    expect(changeBars[changeBars.length - 1]).toBeLessThan(15);
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.tempoSegments.length).toBe(changeBars.length + 1);
    // Every segment's tempo is within 1.5 % of the bar tempo where it starts.
    for (const seg of song.tempoSegments.slice(1)) {
      const b = seg.fromBeat / 4;
      expect(Math.abs(seg.bpm - ramp[b]) / ramp[b]).toBeLessThanOrEqual(0.015);
      expect(String(seg.bpm)).toMatch(/^\d+(\.\d)?$/);
    }
    // A change on the very first bar (bar 0 far from the median) sets the initial tempo.
    const start = transcription(SIXTEEN, { bpm: 100, barTempos: [...Array(4).fill(90), ...Array(12).fill(100)] });
    const s = parseSong(chartFromTranscription(start, { title: 'Arranque' }));
    expect(s.errors).toEqual([]);
    expect(s.song.tempo).toBe(90);
    expect(s.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 90 },
      { fromBeat: 16, bpm: 100 },
    ]);
  });

  it('sections become [Etiqueta] lines with 4 bars per line and song.bars[i].section is right; the strum stays global', () => {
    const sections: ChordTranscription['sections'] = [
      { startBar: 0, endBar: 1, label: 'Intro', letter: 'A' },
      { startBar: 2, endBar: 7, label: 'Estrofa', letter: 'B' },
      { startBar: 8, endBar: 11, label: 'Estribillo', letter: 'C' },
      { startBar: 12, endBar: 15, label: 'Estrofa', letter: 'B' },
    ];
    const text = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, sections }), { title: 'Partes', strum: 'D-DU-UDU' });
    const lines = text.split('\n');
    expect(lines.filter((l) => /^\[/.test(l))).toEqual(['[Intro]', '[Estrofa]', '[Estribillo]', '[Estrofa]']);
    expect(lines.filter((l) => /^strum:/.test(l))).toEqual(['strum: D-DU-UDU']);
    const i0 = lines.indexOf('[Intro]');
    expect(lines[i0 + 1]).toBe('C . . . | G . . . |');
    expect(lines[i0 + 2]).toBe('[Estrofa]');
    expect(lines[i0 + 3]).toBe('Am . . . | F . . . | C . . . | G . . . |');
    expect(lines[i0 + 4]).toBe('Am . . . | F . . . |');
    expect(lines[i0 + 5]).toBe('[Estribillo]');
    const { song, errors, bars } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(bars).toHaveLength(16);
    expect(song.bars.map((b) => b.section)).toEqual([
      ...Array(2).fill('Intro'),
      ...Array(6).fill('Estrofa'),
      ...Array(4).fill('Estribillo'),
      ...Array(4).fill('Estrofa'),
    ]);
    expect(song.events.every((e) => ['down', 'up'].includes(e.direction))).toBe(true);
    // The repeated [Estrofa] is written out (redefined), not recalled: its bars are the transcribed ones.
    expect(bars.slice(12)).toEqual([[['C', 4]], [['G', 4]], [['Am', 4]], [['F', 4]]]);
  });

  it('tempo lines inside sections break the bar lines and keep the phrase alignment; odd sections are tolerated', () => {
    const sections: ChordTranscription['sections'] = [
      { startBar: 0, endBar: 7, label: 'Estrofa [x2]', letter: 'A' },
      { startBar: 8, endBar: 15, label: 'Estribillo', letter: 'B' },
    ];
    const barTempos = [...Array(6).fill(100), ...Array(10).fill(104)];
    const text = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, sections, barTempos }), { title: 'Mixto' });
    const lines = text.split('\n');
    const i0 = lines.findIndex((l) => l.startsWith('['));
    expect(lines[i0]).toBe('[Estrofa x2]');
    expect(lines.slice(i0 + 1, i0 + 7)).toEqual([
      'C . . . | G . . . | Am . . . | F . . . |',
      'C . . . | G . . . |',
      'tempo: 104',
      'Am . . . | F . . . |',
      '[Estribillo]',
      'C . . . | G . . . | Am . . . | F . . . |',
    ]);
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 100 },
      { fromBeat: 24, bpm: 104 },
    ]);
    expect(song.bars[7].section).toBe('Estrofa x2');
    expect(song.bars[8].section).toBe('Estribillo');
    // Sections that do not cover every bar, overlap or come unsorted still give a clean chart:
    // the first section covering a bar wins, an empty label writes no line, and (song grammar)
    // a label runs until the next one, so uncovered bars after a label stay in that section.
    const messy: ChordTranscription['sections'] = [
      { startBar: 10, endBar: 13, label: 'Puente', letter: 'C' },
      { startBar: 0, endBar: 3, label: '', letter: 'A' },
      { startBar: 2, endBar: 5, label: 'Estrofa', letter: 'B' },
    ];
    const messyText = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, sections: messy }), { title: 'Raro' });
    expect(messyText.split('\n').filter((l) => l.startsWith('['))).toEqual(['[Estrofa]', '[Puente]']);
    const m = parsedBars(messyText);
    expect(m.errors).toEqual([]);
    expect(m.bars).toHaveLength(16);
    expect(m.song.bars.map((b) => b.section)).toEqual([
      ...Array(4).fill(null),
      ...Array(6).fill('Estrofa'),
      ...Array(6).fill('Puente'),
    ]);
    // An empty section list behaves like none.
    expect(chartFromTranscription(transcription(SIXTEEN, { bpm: 100, sections: [] }), { title: 'X' })).toBe(
      chartFromTranscription(transcription(SIXTEEN, { bpm: 100 }), { title: 'X' }),
    );
  });

  it('sectionStrums: two sections with different patterns -> one extra strum line, no errors, different events per section (SPEC 16)', () => {
    const sections: ChordTranscription['sections'] = [
      { startBar: 0, endBar: 7, label: 'Estrofa', letter: 'A' },
      { startBar: 8, endBar: 15, label: 'Estribillo', letter: 'B' },
    ];
    const t = transcription(SIXTEEN, { bpm: 100, sections });
    const text = chartFromTranscription(t, { title: 'Dos', sectionStrums: ['D-DU-UDU', 'DUDUDUDU'] });
    const lines = text.split('\n');
    // The header takes the first section's pattern; only the second section needs its own line.
    expect(lines.filter((l) => /^strum:/.test(l))).toEqual(['strum: D-DU-UDU', 'strum: DUDUDUDU']);
    const i0 = lines.indexOf('[Estrofa]');
    expect(lines[i0 + 1]).toBe('C . . . | G . . . | Am . . . | F . . . |');
    const i1 = lines.indexOf('[Estribillo]');
    expect(lines[i1 + 1]).toBe('strum: DUDUDUDU');
    expect(lines[i1 + 2]).toBe('C . . . | G . . . | Am . . . | F . . . |');
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(song.bars).toHaveLength(16);
    const slots = (barIndex: number) => song.events.filter((e) => e.barIndex === barIndex).map((e) => `${e.beatInBar}${e.direction[0]}`);
    for (let b = 0; b < 8; b++) expect(slots(b)).toEqual(['0d', '1d', '1.5u', '2.5u', '3d', '3.5u']);
    for (let b = 8; b < 16; b++) expect(slots(b)).toEqual(['0d', '0.5u', '1d', '1.5u', '2d', '2.5u', '3d', '3.5u']);
    expect(song.bars.map((b) => b.section)).toEqual([...Array(8).fill('Estrofa'), ...Array(8).fill('Estribillo')]);
  });

  it('sectionStrums: undefined entries keep the pattern in force, equal patterns write no line, opts.strum stays the header', () => {
    const sections: ChordTranscription['sections'] = [
      { startBar: 0, endBar: 3, label: 'Intro', letter: 'A' },
      { startBar: 4, endBar: 7, label: 'Estrofa', letter: 'B' },
      { startBar: 8, endBar: 11, label: 'Estribillo', letter: 'C' },
      { startBar: 12, endBar: 15, label: 'Final', letter: 'D' },
    ];
    const t = transcription(SIXTEEN, { bpm: 100, sections });
    // Intro: no pattern -> header (first defined: the Estrofa's). Estrofa: same as header -> no line.
    // Estribillo: new pattern -> line. Final: undefined -> keeps the Estribillo's.
    const text = chartFromTranscription(t, { title: 'Huecos', sectionStrums: [undefined, 'D-DU-UDU', 'DDDD', undefined] });
    const lines = text.split('\n');
    expect(lines.filter((l) => /^strum:/.test(l))).toEqual(['strum: D-DU-UDU', 'strum: DDDD']);
    expect(lines[lines.indexOf('[Estribillo]') + 1]).toBe('strum: DDDD');
    expect(lines[lines.indexOf('[Final]') + 1]).toMatch(/^C \. \. \. \|/);
    const { song, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    const beats = (barIndex: number) => song.events.filter((e) => e.barIndex === barIndex).map((e) => e.beatInBar);
    expect(beats(0)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(beats(7)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(beats(8)).toEqual([0, 1, 2, 3]);
    expect(beats(15)).toEqual([0, 1, 2, 3]);

    // opts.strum is the header even when the first section has its own pattern (which then differs -> line).
    const explicit = chartFromTranscription(t, { title: 'Global', strum: 'D-D-D-D-', sectionStrums: ['D-DU-UDU', 'D-DU-UDU', undefined, 'D-D-D-D-'] });
    const el = explicit.split('\n');
    expect(el.filter((l) => /^strum:/.test(l))).toEqual(['strum: D-D-D-D-', 'strum: D-DU-UDU', 'strum: D-D-D-D-']);
    expect(el[el.indexOf('[Intro]') + 1]).toBe('strum: D-DU-UDU');
    expect(el[el.indexOf('[Estrofa]') + 1]).not.toMatch(/^strum:/);
    expect(el[el.indexOf('[Final]') + 1]).toBe('strum: D-D-D-D-');
    expect(parseSong(explicit).errors).toEqual([]);

    // A repeated section with its pattern restored after a different one gets its line back each time.
    const repeated: ChordTranscription['sections'] = [
      { startBar: 0, endBar: 3, label: 'Estrofa', letter: 'A' },
      { startBar: 4, endBar: 7, label: 'Estribillo', letter: 'B' },
      { startBar: 8, endBar: 11, label: 'Estrofa', letter: 'A' },
      { startBar: 12, endBar: 15, label: 'Estribillo', letter: 'B' },
    ];
    const rep = chartFromTranscription(transcription(SIXTEEN, { bpm: 100, sections: repeated }), {
      title: 'Repe',
      sectionStrums: ['D-DU-UDU', 'DUDUDUDU', 'D-DU-UDU', 'DUDUDUDU'],
    });
    expect(rep.split('\n').filter((l) => /^strum:/.test(l))).toEqual(['strum: D-DU-UDU', 'strum: DUDUDUDU', 'strum: D-DU-UDU', 'strum: DUDUDUDU']);
    const r = parsedBars(rep);
    expect(r.errors).toEqual([]);
    expect(r.song.events.filter((e) => e.barIndex === 8).map((e) => e.beatInBar)).toEqual([0, 1, 1.5, 2.5, 3, 3.5]);
    expect(r.song.events.filter((e) => e.barIndex === 12).map((e) => e.beatInBar)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);

    // All sections with the same pattern: header only. Empty / unparsable entries are ignored.
    const same = chartFromTranscription(t, { title: 'Igual', sectionStrums: ['DUDUDUDU', 'DUDUDUDU', 'DUDUDUDU', 'DUDUDUDU'] });
    expect(same.split('\n').filter((l) => /^strum:/.test(l))).toEqual(['strum: DUDUDUDU']);
    const bad = chartFromTranscription(t, { title: 'Malo', sectionStrums: ['', 'D-DU-UDU', 'DUD', 'DDU-x', 'D-DU-UDX'] });
    expect(bad.split('\n').filter((l) => /^strum:/.test(l))).toEqual(['strum: D-DU-UDU']);
    expect(parseSong(bad).errors).toEqual([]);
    // Surrounding whitespace is trimmed (one character per beat is valid, too).
    const padded = chartFromTranscription(t, { title: 'Pad', sectionStrums: ['  DDU-  ', undefined, ' D-DU-UDU '] });
    expect(padded.split('\n').filter((l) => /^strum:/.test(l))).toEqual(['strum: DDU-', 'strum: D-DU-UDU']);
    expect(parseSong(padded).errors).toEqual([]);
    // Without sections the option changes nothing.
    expect(chartFromTranscription(transcription(SIXTEEN, { bpm: 100 }), { title: 'Sin', sectionStrums: ['DUDUDUDU'] })).toBe(
      chartFromTranscription(transcription(SIXTEEN, { bpm: 100 }), { title: 'Sin' }),
    );
  });

  it('round trip from audio: a structured song gives section labels that parseSong reproduces', () => {
    const song = synthStructuredSong(
      [
        { chords: ['C', 'C', 'G', 'G'], dbfs: -26 },
        { chords: ['C', 'G', 'Am', 'F'], rounds: 2, dbfs: -20 },
        { chords: ['F', 'G', 'C', 'C'], rounds: 2, dbfs: -14 },
        { chords: ['C', 'G', 'Am', 'F'], rounds: 2, dbfs: -20 },
        { chords: ['F', 'G', 'C', 'C'], rounds: 2, dbfs: -14 },
        { chords: ['Em', 'Em', 'Am', 'Am'], dbfs: -22 },
      ],
      44100,
      { bpm: 100, seed: 3 },
    );
    const t = transcribeChords(song.signal, 44100);
    expect(t.sections).toBeDefined();
    const text = chartFromTranscription(t, { title: 'Estructura' });
    const { song: parsed, errors } = parsedBars(text);
    expect(errors).toEqual([]);
    expect(parsed.bars).toHaveLength(t.bars.length);
    for (const s of t.sections as NonNullable<ChordTranscription['sections']>) {
      for (let i = s.startBar; i <= s.endBar; i++) expect(parsed.bars[i].section).toBe(s.label);
    }
    expect(text).toContain('[Intro]\n');
    expect(text).toContain('[Estribillo]\n');
    expect(text).toContain('[Final]\n');
    expect(parsed.tempoSegments).toHaveLength(1);
    expect(parsed.tempo).toBe(100);
  }, 60000);
});

describe('replaceChart', () => {
  const chart = chartFromTranscription(transcription(FIVE_BARS), { title: 'Nuevo título', artist: 'Otro' });

  it('keeps title, artist and capo of the original and replaces everything else', () => {
    const source = [
      'title: Mi canción',
      'artist: Yo',
      'tempo: 120',
      'capo: 2',
      'strum: DDUU',
      '[Intro]',
      'D . . . | A . . . |',
      '> letra',
    ].join('\n');
    const out = replaceChart(source, chart);
    const lines = out.split('\n');
    expect(lines.slice(0, 3)).toEqual(['title: Mi canción', 'artist: Yo', 'capo: 2']);
    expect(out).not.toContain('Nuevo título');
    expect(out).not.toContain('Otro');
    expect(out).not.toContain('[Intro]');
    expect(out).not.toContain('letra');
    expect(out).not.toContain('DDUU');
    const { song, errors, bars } = parsedBars(out);
    expect(errors).toEqual([]);
    expect(song.title).toBe('Mi canción');
    expect(song.artist).toBe('Yo');
    expect(song.capo).toBe(2);
    expect(song.tempo).toBe(100);
    expect(bars).toHaveLength(5);
    expect(bars[0]).toEqual([['C', 4]]);
    expect(song.lyricLines).toEqual([]);
  });

  it('uses the chart headers when the original lacks them', () => {
    const out = replaceChart('tempo: 80\nC . . . |\n', chart);
    const { song, errors } = parsedBars(out);
    expect(errors).toEqual([]);
    expect(song.title).toBe('Nuevo título');
    expect(song.artist).toBe('Otro');
    expect(song.capo).toBe(0);
    expect(song.tempo).toBe(100);
    expect(out.split('\n')[0]).toBe('title: Nuevo título');
  });

  it('keeps only the original title when that is all it has, and tolerates CRLF and odd casing', () => {
    const out = replaceChart('Title : Solo título\r\nG . . . |\r\n', chart);
    const { song, errors } = parsedBars(out);
    expect(errors).toEqual([]);
    expect(song.title).toBe('Solo título');
    expect(song.artist).toBe('Otro');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('G . . . |');
  });

  it('is idempotent on its own output', () => {
    const once = replaceChart('title: A\nartist: B\ncapo: 1\n', chart);
    expect(replaceChart(once, chart)).toBe(once);
  });
});
