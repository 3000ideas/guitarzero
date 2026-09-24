import { describe, expect, it } from 'vitest';
import type { ChordTranscription, TranscribedBar } from '../../src/types';
import { chartFromTranscription, defaultChartStrum, replaceChart } from '../../src/song/chartFromTranscription';
import { transcribeChords } from '../../src/dsp/chordTranscribe';
import { parseSong } from '../../src/song/parser';
import { synthProgression } from '../helpers/synth';

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
