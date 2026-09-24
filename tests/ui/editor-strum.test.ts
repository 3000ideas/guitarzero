import { describe, expect, it } from 'vitest';
import {
  STRUM_ANALYZING_TEXT,
  STRUM_CONFIDENCE_THRESHOLD,
  STRUM_DETECT_LABEL,
  STRUM_DETECT_NOTE,
  chartStrumFrom,
  firstDownbeatInAudio,
  formatStrumDetection,
  isValidStrumPattern,
  presetIdFor,
  waveformStrum,
} from '../../src/ui/screens/editor';
import { strumStatusText } from '../../src/ui/screens/library';
import { MIN_STRUM_SLOT_PX, STRUM_MARK_COLORS, WaveformView, strumMarkGlyph, strumMarks } from '../../src/ui/waveform';
import { chartFromTranscription } from '../../src/song/chartFromTranscription';
import { parseSong } from '../../src/song/parser';
import type { ChordTranscription, StrumDetection } from '../../src/types';

function detection(pattern: string, confidence: number, extra: Partial<StrumDetection> = {}): StrumDetection {
  const charsPerBeat = (extra.charsPerBeat ?? 2) as 1 | 2 | 4;
  return { pattern, charsPerBeat, slotStrength: [], confidence, bars: 16, ...extra };
}

function transcription(extra: Partial<ChordTranscription> = {}): ChordTranscription {
  return {
    bpm: 100,
    beatsPerBar: 4,
    firstDownbeatSec: 0.5,
    key: { root: 0, mode: 'major', name: 'Do mayor' },
    beats: [],
    bars: [
      { startBeat: 0, chords: [{ chord: 'C', beats: 4 }] },
      { startBeat: 4, chords: [{ chord: 'G', beats: 2 }, { chord: 'Am', beats: 2 }] },
    ],
    confidence: 0.5,
    ...extra,
  };
}

// ------------------------------------------------------------------ Rasgueo card texts

describe('strum detection texts (editor)', () => {
  it('formatStrumDetection reports the analysed bars and the confidence label', () => {
    expect(formatStrumDetection({ bars: 12, confidence: 0.8 })).toBe('Detectado en 12 compases (confianza alta)');
    expect(formatStrumDetection({ bars: 12, confidence: 0.6 })).toBe('Detectado en 12 compases (confianza alta)');
    expect(formatStrumDetection({ bars: 7, confidence: 0.45 })).toBe('Detectado en 7 compases (confianza media)');
    expect(formatStrumDetection({ bars: 7, confidence: 0.3 })).toBe('Detectado en 7 compases (confianza media)');
    expect(formatStrumDetection({ bars: 3, confidence: 0.1 })).toBe('Detectado en 3 compases (confianza baja)');
    expect(formatStrumDetection({ bars: 1, confidence: 0 })).toBe('Detectado en 1 compás (confianza baja)');
    expect(formatStrumDetection({ bars: 0, confidence: 0 })).toBe('Detectado en 0 compases (confianza baja)');
  });

  it('exposes the button label, the note about ↓ on beats / ↑ on off-beats and the busy text', () => {
    expect(STRUM_DETECT_LABEL).toBe('Detectar rasgueo del audio');
    expect(STRUM_DETECT_NOTE).toBe('Las flechas se calculan con los golpes del audio: ↓ en los tiempos, ↑ en los contratiempos');
    expect(STRUM_ANALYZING_TEXT).toBe('Analizando…');
  });

  it('a detected pattern selects its preset or "Personalizado" and is a valid header value', () => {
    expect(presetIdFor('D-DU-UDU', 4)).toBe('pop');
    expect(presetIdFor('D-D-D-D-', 4)).toBe('one');
    expect(presetIdFor('DUD-DU-U', 4)).toBe('custom');
    expect(isValidStrumPattern('D-DUD-DUD-DUD-DU', 4)).toBe(true);
    expect(isValidStrumPattern('D-DUDU', 3)).toBe(true);
  });

  it('strumStatusText (library import)', () => {
    expect(strumStatusText('cancion.mp3')).toBe('Detectando el rasgueo de «cancion.mp3»…');
  });
});

// ------------------------------------------------------------------ chart strum from a detection

describe('chartStrumFrom', () => {
  it('returns the pattern from the threshold up and undefined below it', () => {
    expect(STRUM_CONFIDENCE_THRESHOLD).toBe(0.3);
    expect(chartStrumFrom(detection('D-DU-UDU', 0.9))).toBe('D-DU-UDU');
    expect(chartStrumFrom(detection('D-DU-UDU', 0.3))).toBe('D-DU-UDU');
    expect(chartStrumFrom(detection('D-DU-UDU', 0.29))).toBeUndefined();
    expect(chartStrumFrom(detection('D-DU-UDU', 0))).toBeUndefined();
    expect(chartStrumFrom(detection('D-DU-UDU', Number.NaN))).toBeUndefined();
    expect(chartStrumFrom(detection('', 0.9))).toBeUndefined();
    expect(chartStrumFrom(null)).toBeUndefined();
    expect(chartStrumFrom(undefined)).toBeUndefined();
  });

  it('feeds chartFromTranscription: a confident pattern becomes the strum: header, a weak one keeps one per beat', () => {
    const t = transcription();
    const confident = chartFromTranscription(t, { title: 'Prueba', strum: chartStrumFrom(detection('D-DU-UDU', 0.7)) });
    expect(confident).toContain('strum: D-DU-UDU\n');
    const parsed = parseSong(confident);
    expect(parsed.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(parsed.song.events.map((e) => e.direction).slice(0, 5)).toEqual(['down', 'down', 'up', 'up', 'down']);

    const weak = chartFromTranscription(t, { title: 'Prueba', strum: chartStrumFrom(detection('D-DU-UDU', 0.1)) });
    expect(weak).toContain('strum: D-D-D-D-\n');
    expect(parseSong(weak).song.events.every((e) => e.direction === 'down')).toBe(true);
  });

  it('works for 3/4 and sixteenth-note patterns', () => {
    const t = transcription({ beatsPerBar: 3, bars: [{ startBeat: 0, chords: [{ chord: 'C', beats: 3 }] }] });
    const out = chartFromTranscription(t, { title: 'Vals', strum: chartStrumFrom(detection('D-DUDU', 0.5)) });
    expect(out).toContain('time: 3/4\nstrum: D-DUDU\n');
    expect(parseSong(out).errors.filter((e) => e.severity === 'error')).toEqual([]);

    const sixteenths = chartFromTranscription(transcription(), { title: 'Funk', strum: chartStrumFrom(detection('D-DUD-DUD-DUD-DU', 0.5, { charsPerBeat: 4 })) });
    expect(sixteenths).toContain('strum: D-DUD-DUD-DUD-DU\n');
    expect(parseSong(sixteenths).errors.filter((e) => e.severity === 'error')).toEqual([]);
  });
});

// ------------------------------------------------------------------ grid helpers

describe('firstDownbeatInAudio', () => {
  it('keeps a non-negative offset', () => {
    expect(firstDownbeatInAudio(0, 120, 4)).toBe(0);
    expect(firstDownbeatInAudio(1.32, 120, 4)).toBe(1.32);
  });

  it('advances a negative offset by whole bars until it is inside the audio', () => {
    // 120 bpm 4/4 -> 2 s per bar
    expect(firstDownbeatInAudio(-0.5, 120, 4)).toBeCloseTo(1.5, 9);
    expect(firstDownbeatInAudio(-2, 120, 4)).toBeCloseTo(0, 9);
    expect(firstDownbeatInAudio(-2.5, 120, 4)).toBeCloseTo(1.5, 9);
    // 3/4 at 90 bpm -> 2 s per bar
    expect(firstDownbeatInAudio(-3.9, 90, 3)).toBeCloseTo(0.1, 9);
  });

  it('leaves the offset alone when the grid is unusable', () => {
    expect(firstDownbeatInAudio(-1, 0, 4)).toBe(-1);
    expect(firstDownbeatInAudio(-1, 120, 0)).toBe(-1);
    expect(firstDownbeatInAudio(-1, Number.NaN, 4)).toBe(-1);
  });
});

describe('waveformStrum', () => {
  it('uses the leading strum: header when it fits the meter', () => {
    expect(waveformStrum('title: X\ntempo: 100\nstrum: D-DU-UDU\n\nC . . . |', 4)).toEqual({ pattern: 'D-DU-UDU', charsPerBeat: 2 });
    expect(waveformStrum('strum: DUDU\nC . . . |', 4)).toEqual({ pattern: 'DUDU', charsPerBeat: 1 });
    expect(waveformStrum('strum: D-DUD-DUD-DUD-DU\nC . . . |', 4)).toEqual({ pattern: 'D-DUD-DUD-DUD-DU', charsPerBeat: 4 });
    expect(waveformStrum('time: 3/4\nstrum: D-DUDU\nC . . |', 3)).toEqual({ pattern: 'D-DUDU', charsPerBeat: 2 });
  });

  it('falls back to one down-strum per beat without a header or when it does not fit (parser rule)', () => {
    expect(waveformStrum('tempo: 100\nC . . . |', 4)).toEqual({ pattern: 'D-D-D-D-', charsPerBeat: 2 });
    expect(waveformStrum('strum: D-DU-UDU\nC . . |', 3)).toEqual({ pattern: 'D-D-D-', charsPerBeat: 2 });
    expect(waveformStrum('strum: D-DQ-UDU\nC . . . |', 4)).toEqual({ pattern: 'D-D-D-D-', charsPerBeat: 2 });
    // A strum: line after the first bar line is a mid-song header, not the leading one.
    expect(waveformStrum('C . . . |\nstrum: DUDUDUDU\nG . . . |', 4)).toEqual({ pattern: 'D-D-D-D-', charsPerBeat: 2 });
  });
});

// ------------------------------------------------------------------ waveform strum marks

describe('strumMarks', () => {
  const grid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.5, totalBeats: 8 };

  it('places the D/U slots of every bar on the grid (2 chars per beat)', () => {
    const marks = strumMarks(grid, 'D-DU-UDU', 2, 0, 10);
    // six strums per bar (D at 0, 2, 6; U at 3, 5, 7) over two bars
    expect(marks).toHaveLength(12);
    const bar1 = marks.filter((m) => m.bar === 0);
    expect(bar1.map((m) => [m.slot, m.kind, m.sec])).toEqual([
      [0, 'down', 0.5],
      [2, 'down', 1],
      [3, 'up', 1.25],
      [5, 'up', 1.75],
      [6, 'down', 2],
      [7, 'up', 2.25],
    ]);
    expect(marks.filter((m) => m.bar === 1)[0]).toMatchObject({ slot: 0, kind: 'down' });
    expect(marks.filter((m) => m.bar === 1)[0].sec).toBeCloseTo(2.5, 9);
  });

  it('marks exactly the D, U and x slots ("-" produces nothing)', () => {
    const marks = strumMarks({ ...grid, totalBeats: 4 }, 'D-DU-UDU', 2, 0, 10);
    expect(marks.map((m) => m.slot)).toEqual([0, 2, 3, 5, 6, 7]);
    expect(marks.map((m) => m.kind)).toEqual(['down', 'down', 'up', 'up', 'down', 'up']);
    expect(marks.map((m) => m.sec)).toEqual([0.5, 1, 1.25, 1.75, 2, 2.25]);
    const muted = strumMarks({ ...grid, totalBeats: 4 }, 'D-x-D-x-', 2, 0, 10);
    expect(muted.map((m) => m.kind)).toEqual(['down', 'muted', 'down', 'muted']);
  });

  it('keeps only the slots inside the requested range', () => {
    const marks = strumMarks(grid, 'D-DU-UDU', 2, 1.1, 2.0);
    expect(marks.map((m) => m.sec)).toEqual([1.25, 1.75, 2]);
    expect(strumMarks(grid, 'D-DU-UDU', 2, 20, 30)).toEqual([]);
    expect(strumMarks(grid, 'D-DU-UDU', 2, 5, 1)).toEqual([]);
  });

  it('never goes past the end of the chart (totalBeats) nor before bar 1', () => {
    const marks = strumMarks({ ...grid, totalBeats: 6 }, 'D-DU-UDU', 2, 0, 10);
    // bar 2 (beats 4..6) keeps the slots at beats 4, 5 and 5.5 only
    expect(marks.filter((m) => m.bar === 1).map((m) => m.slot)).toEqual([0, 2, 3]);
    expect(marks.every((m) => m.sec < 0.5 + (6 * 60) / 120)).toBe(true);
    // A chart that starts before the audio: slots before 0 are simply outside the range.
    const early = strumMarks({ ...grid, offsetSec: -1 }, 'D-DU-UDU', 2, 0, 10);
    expect(early.every((m) => m.sec >= 0)).toBe(true);
    // bar 1 starts at -1 s: its slots 0, 2 and 3 fall before the audio; slot 5 (beat 2.5) is the first one heard
    expect(early[0]).toMatchObject({ bar: 0, slot: 5, kind: 'up' });
    expect(early[0].sec).toBeCloseTo(0.25, 9);
  });

  it('supports 1 and 4 chars per beat and 3/4', () => {
    const quarters = strumMarks({ ...grid, totalBeats: 4 }, 'DUDU', 1, 0, 10);
    expect(quarters.map((m) => m.sec)).toEqual([0.5, 1, 1.5, 2]);
    expect(quarters.map((m) => m.kind)).toEqual(['down', 'up', 'down', 'up']);
    const sixteenths = strumMarks({ ...grid, totalBeats: 4 }, 'D-DUD-DUD-DUD-DU', 4, 0, 10);
    expect(sixteenths).toHaveLength(12);
    expect(sixteenths.slice(0, 3).map((m) => m.sec)).toEqual([0.5, 0.75, 0.875]);
    const waltz = strumMarks({ bpm: 90, beatsPerBar: 3, offsetSec: 0, totalBeats: 6 }, 'D-DUDU', 2, 0, 10);
    expect(waltz).toHaveLength(10);
    expect(waltz.filter((m) => m.bar === 1)[0].sec).toBeCloseTo(2, 9);
  });

  it('returns nothing for an unusable grid or pattern', () => {
    expect(strumMarks({ ...grid, bpm: 0 }, 'D-DU-UDU', 2, 0, 10)).toEqual([]);
    expect(strumMarks({ ...grid, beatsPerBar: 0 }, 'D-DU-UDU', 2, 0, 10)).toEqual([]);
    expect(strumMarks({ ...grid, totalBeats: 0 }, 'D-DU-UDU', 2, 0, 10)).toEqual([]);
    expect(strumMarks(grid, '', 2, 0, 10)).toEqual([]);
    expect(strumMarks(grid, 'D-DU-UDU', 0, 0, 10)).toEqual([]);
    expect(strumMarks(grid, '--------', 2, 0, 10)).toEqual([]);
  });

  it('uses the highway colours (↓ blue, ↑ pink) and the ↓ / ↑ / × glyphs', () => {
    expect(STRUM_MARK_COLORS.down).toBe('#38bdf8');
    expect(STRUM_MARK_COLORS.up).toBe('#f9a8d4');
    expect(strumMarkGlyph('down')).toBe('↓');
    expect(strumMarkGlyph('up')).toBe('↑');
    expect(strumMarkGlyph('muted')).toBe('×');
    expect(MIN_STRUM_SLOT_PX).toBeGreaterThan(0);
  });
});

describe('WaveformView.setStrum', () => {
  /** Enough of a canvas for the constructor: no size, so nothing is ever drawn in Node. */
  function fakeCanvas(): HTMLCanvasElement {
    const listeners = new Map<string, unknown>();
    return {
      style: {},
      clientWidth: 0,
      clientHeight: 0,
      width: 0,
      height: 0,
      addEventListener: (type: string, fn: unknown) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
  }

  it('is part of the public API', () => {
    const proto = WaveformView.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.setStrum).toBe('function');
    expect(typeof proto.getStrum).toBe('function');
  });

  it('stores the pattern and chars per beat; null or an empty pattern clears it', () => {
    const view = new WaveformView(fakeCanvas(), { onOffsetChange: () => {} });
    expect(view.getStrum()).toBeNull();
    view.setStrum('D-DU-UDU', 2);
    expect(view.getStrum()).toEqual({ pattern: 'D-DU-UDU', charsPerBeat: 2 });
    view.setStrum('D-DUD-DUD-DUD-DU', 4);
    expect(view.getStrum()).toEqual({ pattern: 'D-DUD-DUD-DUD-DU', charsPerBeat: 4 });
    view.setStrum(null, 2);
    expect(view.getStrum()).toBeNull();
    view.setStrum('', 2);
    expect(view.getStrum()).toBeNull();
    view.setStrum('D-D-D-D-', 0);
    expect(view.getStrum()).toBeNull();
    view.setGrid({ bpm: 120, beatsPerBar: 4, offsetSec: 0, totalBeats: 8 });
    view.setStrum('D-D-D-D-', 2);
    expect(view.getStrum()).toEqual({ pattern: 'D-D-D-D-', charsPerBeat: 2 });
    view.dispose();
  });
});
