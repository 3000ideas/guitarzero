import { describe, expect, it } from 'vitest';
import {
  CHART_BARS_PER_LINE,
  LOW_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_WARNING,
  NO_CHORD_TOKEN,
  analyzingChordsText,
  appendBarLines,
  formatTranscriptionSummary,
  transcriptionBarLines,
  transcriptionChordNames,
} from '../../src/ui/screens/editor';
import { IMPORT_TRACK_GAIN, UNTITLED, importStatusText, titleFromFileName } from '../../src/ui/screens/library';
import { parseSong } from '../../src/song/parser';
import type { ChordTranscription, TranscribedBar } from '../../src/types';

function bar(startBeat: number, ...chords: Array<[string | null, number]>): TranscribedBar {
  return { startBeat, chords: chords.map(([chord, beats]) => ({ chord, beats })) };
}

function transcription(bars: TranscribedBar[], extra: Partial<ChordTranscription> = {}): ChordTranscription {
  return {
    bpm: 96,
    beatsPerBar: 4,
    firstDownbeatSec: 0.5,
    key: { root: 7, mode: 'major', name: 'Sol mayor' },
    beats: [],
    bars,
    confidence: 0.4,
    ...extra,
  };
}

// ------------------------------------------------------------------ editor helpers

describe('analyzingChordsText', () => {
  it('formats the progress as a whole percent and clamps it', () => {
    expect(analyzingChordsText(0.4)).toBe('Analizando acordes… 40 %');
    expect(analyzingChordsText(0)).toBe('Analizando acordes… 0 %');
    expect(analyzingChordsText(1.7)).toBe('Analizando acordes… 100 %');
    expect(analyzingChordsText(-1)).toBe('Analizando acordes… 0 %');
    expect(analyzingChordsText(Number.NaN)).toBe('Analizando acordes… 0 %');
  });
});

describe('transcriptionChordNames', () => {
  it('lists distinct chords in order of first appearance, skipping N.C.', () => {
    const t = transcription([bar(0, ['G', 4]), bar(4, ['D', 2], ['Em', 2]), bar(8, [null, 4]), bar(12, ['G', 2], ['C', 2])]);
    expect(transcriptionChordNames(t)).toEqual(['G', 'D', 'Em', 'C']);
    expect(transcriptionChordNames(transcription([]))).toEqual([]);
  });
});

describe('formatTranscriptionSummary', () => {
  it('reports key, BPM, bar count and the chords', () => {
    const t = transcription([bar(0, ['G', 4]), bar(4, ['D', 2], ['Em', 2])]);
    expect(formatTranscriptionSummary(t)).toBe('Tonalidad Sol mayor · 96 BPM · 2 compases · G D Em');
  });

  it('uses the singular for one bar, keeps a tenth of BPM and says "sin acordes" when every beat is N.C.', () => {
    const t = transcription([bar(0, [null, 4])], { bpm: 100.46, key: { root: 9, mode: 'minor', name: 'La menor' } });
    expect(formatTranscriptionSummary(t)).toBe('Tonalidad La menor · 100.5 BPM · 1 compás · sin acordes');
  });
});

describe('transcriptionBarLines', () => {
  it('writes each chord followed by a dot per extra beat, four bars per line', () => {
    const bars = [
      bar(0, ['C', 4]),
      bar(4, ['G', 2], ['Am', 2]),
      bar(8, ['F', 4]),
      bar(12, ['G', 4]),
      bar(16, ['Am', 1], ['F', 3]),
      bar(20, [null, 4]),
    ];
    expect(transcriptionBarLines(transcription(bars))).toBe(`C . . . | G . Am . | F . . . | G . . . |\nAm F . . | ${NO_CHORD_TOKEN} . . . |`);
    expect(CHART_BARS_PER_LINE).toBe(4);
  });

  it('honours barsPerLine and returns "" without bars', () => {
    const bars = [bar(0, ['C', 3]), bar(3, ['G', 3]), bar(6, ['D', 3])];
    expect(transcriptionBarLines(transcription(bars, { beatsPerBar: 3 }), 2)).toBe('C . . | G . . |\nD . . |');
    expect(transcriptionBarLines(transcription([]))).toBe('');
  });

  it('produces text the parser reproduces bar by bar, without errors or warnings', () => {
    const bars = [bar(0, ['C', 4]), bar(4, ['G', 2], ['Am', 2]), bar(8, ['F#m', 1], ['F', 3]), bar(12, [null, 4]), bar(16, ['G', 4])];
    const source = `tempo: 96\ntime: 4/4\n\n${transcriptionBarLines(transcription(bars))}`;
    const { song, errors } = parseSong(source);
    expect(errors).toEqual([]);
    expect(song.bars.length).toBe(5);
    expect(song.bars.map((b) => b.chords.map((c) => [c.chord.quality === 'nc' ? null : c.chord.name, c.beats]))).toEqual(
      bars.map((b) => b.chords.map((c) => [c.chord, c.beats])),
    );
    expect(song.chordNames).toEqual(['C', 'G', 'Am', 'F#m', 'F']);
  });
});

describe('appendBarLines', () => {
  it('appends after a blank line and ends with a newline', () => {
    expect(appendBarLines('title: X\ntempo: 100\n\nC . . . |', 'G . . . |\nD . . . |')).toBe('title: X\ntempo: 100\n\nC . . . |\n\nG . . . |\nD . . . |\n');
  });

  it('collapses trailing newlines of the source and preserves CRLF', () => {
    expect(appendBarLines('C . . . |\n\n\n', 'G . . . |')).toBe('C . . . |\n\nG . . . |\n');
    expect(appendBarLines('title: X\r\nC . . . |\r\n', 'G . . . |\nD . . . |')).toBe('title: X\r\nC . . . |\r\n\r\nG . . . |\r\nD . . . |\r\n');
  });

  it('returns just the lines for an empty source and the source for empty lines', () => {
    expect(appendBarLines('', 'G . . . |')).toBe('G . . . |');
    expect(appendBarLines('  \n', 'G . . . |')).toBe('G . . . |');
    expect(appendBarLines('C . . . |', '')).toBe('C . . . |');
  });
});

describe('low confidence warning', () => {
  it('matches the SPEC threshold and text', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.15);
    expect(LOW_CONFIDENCE_WARNING).toBe('Confianza baja: revisa los acordes');
  });
});

// ------------------------------------------------------------------ library helpers

describe('titleFromFileName', () => {
  it('drops the extension and keeps the rest', () => {
    expect(titleFromFileName('Mi canción.mp3')).toBe('Mi canción');
    expect(titleFromFileName('track.FLAC')).toBe('track');
    expect(titleFromFileName('archivo.tar.gz')).toBe('archivo.tar');
    expect(titleFromFileName('noext')).toBe('noext');
  });

  it('strips directories, collapses whitespace and falls back to "Sin título"', () => {
    expect(titleFromFileName('C:\\Música\\demo.wav')).toBe('demo');
    expect(titleFromFileName('/tmp/demo.ogg')).toBe('demo');
    expect(titleFromFileName('  a   b .wav')).toBe('a b');
    expect(titleFromFileName('.mp3')).toBe(UNTITLED);
    expect(titleFromFileName('')).toBe(UNTITLED);
  });
});

describe('importStatusText', () => {
  it('formats "Analizando «archivo»… N %"', () => {
    expect(importStatusText('cancion.mp3', 0.4)).toBe('Analizando «cancion.mp3»… 40 %');
    expect(importStatusText('cancion.mp3', 2)).toBe('Analizando «cancion.mp3»… 100 %');
    expect(importStatusText('cancion.mp3', Number.NaN)).toBe('Analizando «cancion.mp3»… 0 %');
  });
});

describe('IMPORT_TRACK_GAIN', () => {
  it('is the SPEC default gain of 0.8', () => {
    expect(IMPORT_TRACK_GAIN).toBe(0.8);
  });
});
