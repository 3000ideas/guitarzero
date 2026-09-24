import { describe, expect, it } from 'vitest';
import {
  SUMMARY_MAX_SECTION_LABELS,
  VARIABLE_TEMPO_THRESHOLD,
  formatTranscriptionSummary,
  previewClickTimes,
  sectionsSummaryText,
  tempoRange,
  transcriptionSectionLabels,
  variableTempoText,
} from '../../src/ui/screens/editor';
import { WaveformView, gridBeatSec, gridMinBeatSec, gridSecToBeat, strumMarks } from '../../src/ui/waveform';
import { beatToSec } from '../../src/song/tempo';
import editorSource from '../../src/ui/screens/editor.ts?raw';
import librarySource from '../../src/ui/screens/library.ts?raw';
import type { ChordTranscription, TempoSegment, TranscribedSection } from '../../src/types';

function section(label: string, startBar: number, endBar: number, letter = 'A'): TranscribedSection {
  return { startBar, endBar, label, letter };
}

function transcription(extra: Partial<ChordTranscription> = {}): ChordTranscription {
  return {
    bpm: 96,
    beatsPerBar: 4,
    firstDownbeatSec: 0.5,
    key: { root: 7, mode: 'major', name: 'Sol mayor' },
    beats: [],
    bars: [
      { startBeat: 0, chords: [{ chord: 'G', beats: 4 }] },
      { startBeat: 4, chords: [{ chord: 'D', beats: 2 }, { chord: 'Em', beats: 2 }] },
    ],
    confidence: 0.4,
    ...extra,
  };
}

/** 120 BPM for the first bar, then 60 BPM (one beat per second). */
const TWO_TEMPOS: TempoSegment[] = [
  { fromBeat: 0, bpm: 120 },
  { fromBeat: 4, bpm: 60 },
];

// ------------------------------------------------------------------ "Detectar acordes" summary (SPEC section 15)

describe('sectionsSummaryText', () => {
  it('is null without sections', () => {
    expect(sectionsSummaryText(undefined)).toBeNull();
    expect(sectionsSummaryText([])).toBeNull();
  });

  it('counts the sections and lists the distinct labels in order of appearance', () => {
    const sections = [
      section('Intro', 0, 3),
      section('Estrofa', 4, 11, 'A'),
      section('Estribillo', 12, 19, 'B'),
      section('Estrofa', 20, 27, 'A'),
      section('Estribillo', 28, 35, 'B'),
      section('Final', 36, 39, 'C'),
    ];
    expect(transcriptionSectionLabels(sections)).toEqual(['Intro', 'Estrofa', 'Estribillo', 'Final']);
    expect(sectionsSummaryText(sections)).toBe('6 secciones: Intro · Estrofa · Estribillo · Final');
  });

  it('stops after SUMMARY_MAX_SECTION_LABELS labels with an ellipsis and uses the singular for one', () => {
    expect(SUMMARY_MAX_SECTION_LABELS).toBe(6);
    const labels = ['Intro', 'Estrofa', 'Estribillo', 'Puente', 'Parte D', 'Parte E', 'Final'];
    const sections = labels.map((label, i) => section(label, i * 4, i * 4 + 3));
    expect(sectionsSummaryText(sections)).toBe('7 secciones: Intro · Estrofa · Estribillo · Puente · Parte D · Parte E…');
    expect(sectionsSummaryText([section('Parte A', 0, 7)])).toBe('1 sección: Parte A');
  });
});

describe('variableTempoText / tempoRange', () => {
  it('is null without usable bar tempos or when the tempo is steady', () => {
    expect(tempoRange(undefined)).toBeNull();
    expect(tempoRange([])).toBeNull();
    expect(tempoRange([Number.NaN, 0, -5])).toBeNull();
    expect(variableTempoText(undefined)).toBeNull();
    expect(variableTempoText([])).toBeNull();
    expect(variableTempoText([100, 100, 100, 100])).toBeNull();
  });

  it('reports the slowest–fastest range once the spread reaches 1.5 % of the slowest bar', () => {
    expect(VARIABLE_TEMPO_THRESHOLD).toBe(0.015);
    expect(variableTempoText([...Array<number>(8).fill(100), ...Array<number>(8).fill(104)])).toBe('tempo variable (100–104 BPM)');
    expect(variableTempoText([100, 101])).toBeNull(); // 1 % < 1.5 %
    expect(variableTempoText([100, 102])).toBe('tempo variable (100–102 BPM)');
    expect(variableTempoText([102, 100])).toBe('tempo variable (100–102 BPM)');
  });

  it('formats to a tenth of a BPM and ignores non-finite or non-positive values', () => {
    expect(tempoRange([95.52, 99.96])).toEqual({ min: 95.52, max: 99.96 });
    expect(variableTempoText([95.52, 99.96])).toBe('tempo variable (95.5–100 BPM)');
    expect(tempoRange([Number.NaN, 100, 104, 0, Number.POSITIVE_INFINITY])).toEqual({ min: 100, max: 104 });
    expect(variableTempoText([Number.NaN, 100, 104, 0])).toBe('tempo variable (100–104 BPM)');
  });
});

describe('formatTranscriptionSummary with sections and bar tempos', () => {
  const base = 'Tonalidad Sol mayor · 96 BPM · 2 compases · G D Em';

  it('keeps the section 12 summary when the transcription has neither', () => {
    expect(formatTranscriptionSummary(transcription())).toBe(base);
    expect(formatTranscriptionSummary(transcription({ barTempos: [96, 96] }))).toBe(base);
    expect(formatTranscriptionSummary(transcription({ sections: [] }))).toBe(base);
  });

  it('appends the sections, then the variable tempo', () => {
    const sections = [section('Intro', 0, 0), section('Estrofa', 1, 1, 'A')];
    expect(formatTranscriptionSummary(transcription({ sections }))).toBe(`${base} · 2 secciones: Intro · Estrofa`);
    expect(formatTranscriptionSummary(transcription({ barTempos: [94, 98] }))).toBe(`${base} · tempo variable (94–98 BPM)`);
    expect(formatTranscriptionSummary(transcription({ sections, barTempos: [94, 98] }))).toBe(
      `${base} · 2 secciones: Intro · Estrofa · tempo variable (94–98 BPM)`,
    );
  });
});

// ------------------------------------------------------------------ waveform grid on a tempo map

describe('gridBeatSec / gridSecToBeat with segments', () => {
  const grid = { bpm: 120, offsetSec: 0.5, segments: TWO_TEMPOS };

  it('places the beats through beatToSec(segments, k) + offsetSec', () => {
    expect(gridBeatSec(grid, 0)).toBeCloseTo(0.5, 9);
    expect(gridBeatSec(grid, 4)).toBeCloseTo(2.5, 9);
    expect(gridBeatSec(grid, 6)).toBeCloseTo(4.5, 9);
    expect(gridBeatSec(grid, 8)).toBeCloseTo(6.5, 9);
    // count-in beats extrapolate with the first segment
    expect(gridBeatSec(grid, -2)).toBeCloseTo(-0.5, 9);
    for (const k of [-3, 0, 1.5, 4, 5.25, 9]) expect(gridBeatSec(grid, k)).toBeCloseTo(0.5 + beatToSec(TWO_TEMPOS, k), 12);
  });

  it('inverts the mapping', () => {
    expect(gridSecToBeat(grid, 0.5)).toBeCloseTo(0, 9);
    expect(gridSecToBeat(grid, 1)).toBeCloseTo(1, 9);
    expect(gridSecToBeat(grid, 2.5)).toBeCloseTo(4, 9);
    expect(gridSecToBeat(grid, 4.5)).toBeCloseTo(6, 9);
    expect(gridSecToBeat(grid, -0.5)).toBeCloseTo(-2, 9);
    for (const k of [-3, 0, 1.5, 4, 5.25, 9]) expect(gridSecToBeat(grid, gridBeatSec(grid, k))).toBeCloseTo(k, 9);
  });

  it('falls back to the constant bpm without segments (or with an empty map)', () => {
    expect(gridBeatSec({ bpm: 120, offsetSec: 1.5 }, 4)).toBe(3.5);
    expect(gridBeatSec({ bpm: 120, offsetSec: 0.5, segments: [] }, 4)).toBe(2.5);
    expect(gridSecToBeat({ bpm: 120, offsetSec: 1.5 }, 3.5)).toBeCloseTo(4, 9);
    expect(gridSecToBeat({ bpm: 120, offsetSec: 0.5, segments: [] }, 2.5)).toBeCloseTo(4, 9);
    // a one-segment map is exactly the constant grid
    const constant = { bpm: 120, offsetSec: 0.5 };
    const single = { ...constant, segments: [{ fromBeat: 0, bpm: 120 }] };
    for (const k of [-4, 0, 1, 2.5, 7]) expect(gridBeatSec(single, k)).toBe(gridBeatSec(constant, k));
  });

  it('gridMinBeatSec is the beat of the fastest tempo of the map', () => {
    expect(gridMinBeatSec({ bpm: 120 })).toBeCloseTo(0.5, 9);
    expect(gridMinBeatSec({ bpm: 120, segments: TWO_TEMPOS })).toBeCloseTo(0.5, 9);
    expect(gridMinBeatSec({ bpm: 96, segments: [{ fromBeat: 0, bpm: 96 }, { fromBeat: 16, bpm: 104 }] })).toBeCloseTo(60 / 104, 9);
    expect(gridMinBeatSec({ bpm: 0 })).toBe(0);
  });
});

describe('strumMarks on a tempo map', () => {
  const grid = { bpm: 120, beatsPerBar: 4, offsetSec: 0.5, totalBeats: 8, segments: TWO_TEMPOS };

  it('uses the same beat times as the grid lines', () => {
    const marks = strumMarks(grid, 'D-DU-UDU', 2, 0, 10);
    expect(marks).toHaveLength(12);
    // bar 1 at 120 BPM is unchanged; bar 2 at 60 BPM stretches to one beat per second
    expect(marks.filter((m) => m.bar === 0).map((m) => m.sec)).toEqual([0.5, 1, 1.25, 1.75, 2, 2.25]);
    const bar2 = marks.filter((m) => m.bar === 1);
    expect(bar2.map((m) => m.slot)).toEqual([0, 2, 3, 5, 6, 7]);
    expect(bar2.map((m) => m.kind)).toEqual(['down', 'down', 'up', 'up', 'down', 'up']);
    const expected = [2.5, 3.5, 4, 5, 5.5, 6];
    bar2.forEach((m, i) => expect(m.sec).toBeCloseTo(expected[i], 9));
    for (const m of marks) expect(m.sec).toBeCloseTo(gridBeatSec(grid, m.bar * 4 + m.slot / 2), 12);
  });

  it('keeps only the slots inside the range, found through the tempo map', () => {
    const marks = strumMarks(grid, 'D-DU-UDU', 2, 3, 4.5);
    expect(marks.map((m) => [m.bar, m.slot])).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(marks.map((m) => m.sec)).toEqual([3.5, 4]);
  });

  it('gives the constant result for a one-segment map', () => {
    const constant = { bpm: 120, beatsPerBar: 4, offsetSec: 0.5, totalBeats: 8 };
    const single = { ...constant, segments: [{ fromBeat: 0, bpm: 120 }] };
    expect(strumMarks(single, 'D-DU-UDU', 2, 0, 10)).toEqual(strumMarks(constant, 'D-DU-UDU', 2, 0, 10));
    expect(strumMarks(single, 'D-DUD-DUD-DUD-DU', 4, 1.1, 2.0)).toEqual(strumMarks(constant, 'D-DUD-DUD-DUD-DU', 4, 1.1, 2.0));
  });
});

describe('WaveformView.setGrid with segments', () => {
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

  it('stores the tempo map and returns a private copy of it', () => {
    const proto = WaveformView.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getGrid).toBe('function');
    const view = new WaveformView(fakeCanvas(), { onOffsetChange: () => {} });
    expect(view.getGrid()).toBeNull();
    const segments: TempoSegment[] = [{ fromBeat: 0, bpm: 96 }, { fromBeat: 32, bpm: 104 }];
    view.setGrid({ bpm: 96, beatsPerBar: 4, offsetSec: 1.2, totalBeats: 64, segments });
    const stored = view.getGrid();
    expect(stored).toEqual({ bpm: 96, beatsPerBar: 4, offsetSec: 1.2, totalBeats: 64, segments });
    expect(stored?.segments).not.toBe(segments);
    // neither the caller's array nor the returned copy can change the view's map
    segments.push({ fromBeat: 48, bpm: 90 });
    stored?.segments?.push({ fromBeat: 56, bpm: 80 });
    expect(view.getGrid()?.segments).toHaveLength(2);
    view.setGrid({ bpm: 120, beatsPerBar: 4, offsetSec: 0, totalBeats: 8 });
    expect(view.getGrid()).toEqual({ bpm: 120, beatsPerBar: 4, offsetSec: 0, totalBeats: 8 });
    expect('segments' in (view.getGrid() as object)).toBe(false);
    view.setGrid(null);
    expect(view.getGrid()).toBeNull();
    view.dispose();
  });
});

// ------------------------------------------------------------------ test listen clicks on a tempo map

describe('previewClickTimes with segments', () => {
  it('follows the tempo changes of the text like the grid', () => {
    const clicks = previewClickTimes(1, 120, 4, 0, 2, TWO_TEMPOS);
    const expected = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
    expect(clicks).toHaveLength(expected.length);
    clicks.forEach((c, i) => expect(c.sec).toBeCloseTo(expected[i], 9));
    expect(clicks.map((c) => c.accent)).toEqual([false, false, true, false, false, false, true, false, false, false]);
  });

  it('is the constant grid for a one-segment (or empty) map', () => {
    expect(previewClickTimes(1, 120, 4, 0, 2, [{ fromBeat: 0, bpm: 120 }])).toEqual(previewClickTimes(1, 120, 4, 0, 2));
    expect(previewClickTimes(1, 120, 4, 0, 2, [])).toEqual(previewClickTimes(1, 120, 4, 0, 2));
  });
});

// ------------------------------------------------------------------ screen wiring that cannot run in Node

describe('editor and library wiring (source-level guards)', () => {
  it('the editor no longer shows the constant-tempo warning and hands the tempo map to the waveform', () => {
    expect(editorSource).not.toContain('La pista solo se sincroniza con tempo constante');
    expect(editorSource).not.toContain('constantTempoWarn');
    expect(editorSource).toMatch(/segments:\s*analysis\.song\.tempoSegments/);
  });

  it('"Desde audio…" asks for beat tracking and section detection explicitly', () => {
    expect(librarySource).toMatch(/trackBeats:\s*true/);
    expect(librarySource).toMatch(/detectSections:\s*true/);
  });
});
