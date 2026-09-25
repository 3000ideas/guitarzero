import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NO_TAPS_TEXT,
  PREVIEW_BARS,
  RECORDING_TEXT,
  RECORD_BARS,
  SECTION_POST_ROLL_SEC,
  SECTION_PRE_ROLL_SEC,
  SECTION_STRUM_MIN_BARS,
  STRUM_RECORD_LABEL,
  STRUM_RECORD_NOTE,
  STRUM_TAP_LABEL,
  barNumberAt,
  detectSectionStrums,
  formatRecordedStrum,
  isTypingTarget,
  previewClickTimes,
  previewEndSec,
  previewStartSec,
  recordingBeatTimes,
  recordingStatusText,
  sectionBeatTimes,
  sectionStrumJob,
  sectionStrumPattern,
  sectionStrumsNote,
  type StrumDetector,
} from '../../src/ui/screens/editor';
import { patternFromTaps } from '../../src/dsp/strumFromTaps';
import { beatToSec } from '../../src/song/tempo';
import { synthStrummedProgression } from '../helpers/synth';
import editorSource from '../../src/ui/screens/editor.ts?raw';
import librarySource from '../../src/ui/screens/library.ts?raw';
import type { ChordTranscription, StrumDetection, TempoSegment, TranscribedSection } from '../../src/types';

const CONSTANT_120: TempoSegment[] = [{ fromBeat: 0, bpm: 120 }];
/** 120 BPM for the first bar (0.5 s per beat), then 60 BPM (one beat per second). */
const TWO_TEMPOS: TempoSegment[] = [
  { fromBeat: 0, bpm: 120 },
  { fromBeat: 4, bpm: 60 },
];

function detection(pattern: string, confidence: number, bars: number): StrumDetection {
  return { pattern, charsPerBeat: 2, slotStrength: [], confidence, bars };
}

function section(startBar: number, endBar: number, label = 'Parte A', letter = 'A'): TranscribedSection {
  return { startBar, endBar, label, letter };
}

/** `bars` bars of 4/4 at `bpm` with one tracked beat per beat from `firstDownbeatSec`, chord C everywhere. */
function transcription(bars: number, bpm: number, firstDownbeatSec: number, extra: Partial<ChordTranscription> = {}): ChordTranscription {
  const beatSec = 60 / bpm;
  return {
    bpm,
    beatsPerBar: 4,
    firstDownbeatSec,
    key: { root: 0, mode: 'major', name: 'Do mayor' },
    beats: Array.from({ length: bars * 4 }, (_, k) => ({ timeSec: firstDownbeatSec + k * beatSec, chord: 'C', score: 0.8 })),
    bars: Array.from({ length: bars }, (_, i) => ({ startBeat: i * 4, chords: [{ chord: 'C', beats: 4 }] })),
    confidence: 0.5,
    ...extra,
  };
}

/**
 * Tap times of `pattern` (2 chars per beat) over `bars` bars on `beatTimes` (slots halfway
 * between consecutive beats), the way a user tapping exactly on the strums would produce them.
 */
function tapsFor(pattern: string, beatTimes: number[], beatsPerBar: number, bars: number): number[] {
  const taps: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < pattern.length; k++) {
      if (pattern[k] === '-') continue;
      const beat = b * beatsPerBar + (k >> 1);
      taps.push(beatTimes[beat] + (k % 2) * 0.5 * (beatTimes[beat + 1] - beatTimes[beat]));
    }
  }
  return taps;
}

// ------------------------------------------------------------------ Rasgueo card texts (SPEC section 16)

describe('tap recording texts', () => {
  it('exposes the button labels, the note and the recording constants', () => {
    expect(STRUM_RECORD_LABEL).toBe('Grabar rasgueo tocando');
    expect(STRUM_TAP_LABEL).toBe('¡Rasgueo!');
    expect(STRUM_RECORD_NOTE).toBe('Toca la barra espaciadora (o el botón) en cada rasgueo mientras suena. Abajo en los tiempos, arriba en los contratiempos.');
    expect(RECORD_BARS).toBe(16);
    expect(NO_TAPS_TEXT).toBe('No se registró ningún rasgueo');
    expect(RECORDING_TEXT).toBe('Grabando…');
  });

  it('recordingStatusText: "Grabando… N toques · compás M" with the singular for one tap', () => {
    expect(recordingStatusText(0, 0)).toBe('Grabando… 0 toques · compás 0');
    expect(recordingStatusText(1, 1)).toBe('Grabando… 1 toque · compás 1');
    expect(recordingStatusText(12, 3)).toBe('Grabando… 12 toques · compás 3');
    expect(recordingStatusText(-2, 2.4)).toBe('Grabando… 0 toques · compás 2');
  });

  it('formatRecordedStrum: bars and confidence label (alta ≥ 0.6, media ≥ 0.3, baja)', () => {
    expect(formatRecordedStrum({ bars: 8, confidence: 1 })).toBe('Grabado en 8 compases (confianza alta)');
    expect(formatRecordedStrum({ bars: 8, confidence: 0.6 })).toBe('Grabado en 8 compases (confianza alta)');
    expect(formatRecordedStrum({ bars: 5, confidence: 0.45 })).toBe('Grabado en 5 compases (confianza media)');
    expect(formatRecordedStrum({ bars: 5, confidence: 0.3 })).toBe('Grabado en 5 compases (confianza media)');
    expect(formatRecordedStrum({ bars: 1, confidence: 0.1 })).toBe('Grabado en 1 compás (confianza baja)');
    expect(formatRecordedStrum({ bars: 0, confidence: 0 })).toBe('Grabado en 0 compases (confianza baja)');
  });
});

// ------------------------------------------------------------------ grid of a recording

describe('recordingBeatTimes', () => {
  it('is offsetSec + beatToSec(segments, k) for k = 0 .. bars × beatsPerBar (end of the last bar included)', () => {
    expect(recordingBeatTimes(0.5, CONSTANT_120, 4, 2)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
    expect(recordingBeatTimes(0.5, TWO_TEMPOS, 4, 2)).toEqual([0.5, 1, 1.5, 2, 2.5, 3.5, 4.5, 5.5, 6.5]);
    expect(recordingBeatTimes(-1, CONSTANT_120, 3, 1)).toEqual([-1, -0.5, 0, 0.5]);
  });

  it('defaults to RECORD_BARS bars and follows the tempo map like the waveform grid', () => {
    const times = recordingBeatTimes(1.25, TWO_TEMPOS, 4);
    expect(times).toHaveLength(RECORD_BARS * 4 + 1);
    for (let k = 0; k < times.length; k++) expect(times[k]).toBeCloseTo(1.25 + beatToSec(TWO_TEMPOS, k), 9);
  });

  it('round trip: taps on the strums of D-DU-UDU over the recording grid give the pattern back', () => {
    const segments: TempoSegment[] = [{ fromBeat: 0, bpm: 100 }];
    const beatTimes = recordingBeatTimes(0.5, segments, 4, 8);
    const taps = tapsFor('D-DU-UDU', beatTimes, 4, 8);
    const exact = patternFromTaps(taps, beatTimes, 4);
    expect(exact.pattern).toBe('D-DU-UDU');
    expect(exact.charsPerBeat).toBe(2);
    expect(exact.confidence).toBe(1);
    expect(exact.bars).toBe(8);
    // A tablet's audio latency shifts every tap the same way: the auto latency absorbs it.
    const late = patternFromTaps(taps.map((t) => t + 0.09), beatTimes, 4);
    expect(late.pattern).toBe('D-DU-UDU');
    // Taps only during the lead-in bar (before bar 1) land on no bar of the chart: "No se registró ningún rasgueo".
    const leadIn = patternFromTaps([0.05, 0.2, 0.35], beatTimes, 4);
    expect(leadIn.bars).toBe(0);
    expect(leadIn.confidence).toBe(0);
  });

  it('the recording preview plays from one bar before bar 1 with clicks on RECORD_BARS bars', () => {
    // 120 BPM 4/4: a bar is 2 s, so bar 1 at 2.5 s gives a lead-in bar from 0.5 s.
    const from = previewStartSec(2.5, 120, 4);
    expect(from).toBe(0.5);
    const clicks = previewClickTimes(2.5, 120, 4, from, RECORD_BARS, CONSTANT_120);
    expect(clicks).toHaveLength((RECORD_BARS + 1) * 4);
    expect(clicks[0]).toEqual({ sec: 0.5, accent: true });
    expect(clicks[4]).toEqual({ sec: 2.5, accent: true });
    expect(clicks[clicks.length - 1].sec).toBeCloseTo(previewEndSec(2.5, CONSTANT_120, 4, RECORD_BARS) - 0.5, 9);
    // A chart starting right at the audio's start cannot have a lead-in bar: the clicks start at 0.
    expect(previewStartSec(0.5, 120, 4)).toBe(0);
    expect(previewClickTimes(0.5, 120, 4, 0, RECORD_BARS, CONSTANT_120)[0]).toEqual({ sec: 0, accent: false });
  });
});

describe('previewEndSec', () => {
  it('is the audio time at which bar `bars` of the text ends', () => {
    expect(previewEndSec(0.5, CONSTANT_120, 4, 2)).toBe(4.5);
    expect(previewEndSec(0.5, TWO_TEMPOS, 4, 2)).toBe(6.5);
    expect(previewEndSec(0.5, CONSTANT_120, 3, 1)).toBe(2);
    expect(previewEndSec(2, CONSTANT_120, 4, 0)).toBe(2);
    expect(previewEndSec(0, CONSTANT_120, 4, RECORD_BARS)).toBe(32);
  });
});

describe('barNumberAt', () => {
  it('numbers the bars of the text from 1 at offsetSec; the lead-in (and earlier) is bar 0', () => {
    expect(barNumberAt(0, 0.5, CONSTANT_120, 4)).toBe(0);
    expect(barNumberAt(-10, 0.5, CONSTANT_120, 4)).toBe(0);
    expect(barNumberAt(0.5, 0.5, CONSTANT_120, 4)).toBe(1);
    expect(barNumberAt(2.49, 0.5, CONSTANT_120, 4)).toBe(1);
    expect(barNumberAt(2.5, 0.5, CONSTANT_120, 4)).toBe(2);
    expect(barNumberAt(4.5, 0.5, CONSTANT_120, 4)).toBe(3);
    expect(barNumberAt(2, 0.5, CONSTANT_120, 3)).toBe(2);
  });

  it('follows the tempo map', () => {
    expect(barNumberAt(3.4, 0.5, TWO_TEMPOS, 4)).toBe(2);
    expect(barNumberAt(3.5, 0.5, TWO_TEMPOS, 4)).toBe(2);
    expect(barNumberAt(6.49, 0.5, TWO_TEMPOS, 4)).toBe(2);
    expect(barNumberAt(6.5, 0.5, TWO_TEMPOS, 4)).toBe(3);
    expect(barNumberAt(Number.NaN, 0.5, TWO_TEMPOS, 4)).toBe(0);
  });
});

describe('isTypingTarget', () => {
  it('is true for text fields, selects and editable elements (the space bar must not tap there)', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('is false for buttons, the body, missing targets and anything else', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'BODY', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({} as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

// ------------------------------------------------------------------ strum per section (SPEC section 16)

describe('sectionBeatTimes', () => {
  const t = transcription(3, 100, 0.5); // 12 beats at 0.5 + 0.6 k

  it('returns the tracked beats of the section plus the first beat after it', () => {
    const times = sectionBeatTimes(t, section(0, 1));
    expect(times).toHaveLength(9);
    times.forEach((sec, k) => expect(sec).toBeCloseTo(0.5 + 0.6 * k, 9));
    const middle = sectionBeatTimes(t, section(1, 1));
    expect(middle).toHaveLength(5);
    expect(middle[0]).toBeCloseTo(0.5 + 0.6 * 4, 9);
  });

  it('a last section has no beat after it: only its own beats', () => {
    const times = sectionBeatTimes(t, section(1, 2));
    expect(times).toHaveLength(8);
    expect(times[0]).toBeCloseTo(2.9, 9);
    expect(times[7]).toBeCloseTo(0.5 + 0.6 * 11, 9);
  });

  it('is empty for a section outside the transcription or with a non-finite beat', () => {
    expect(sectionBeatTimes(t, section(0, 5))).toEqual([]);
    expect(sectionBeatTimes(t, section(-1, 1))).toEqual([]);
    expect(sectionBeatTimes(t, section(2, 1))).toEqual([]);
    const broken = transcription(2, 100, 0);
    broken.beats[3] = { ...broken.beats[3], timeSec: Number.NaN };
    expect(sectionBeatTimes(broken, section(0, 0))).toEqual([]);
  });
});

describe('sectionStrumJob', () => {
  it('slices the audio from SECTION_PRE_ROLL_SEC before the first beat and shifts the detection times to the slice', () => {
    expect(SECTION_PRE_ROLL_SEC).toBe(1);
    expect(SECTION_POST_ROLL_SEC).toBe(0.25);
    const t = transcription(3, 100, 3); // 12 beats at 3 + 0.6 k
    const job = sectionStrumJob(t, section(1, 2));
    expect(job).not.toBeNull();
    if (!job) return;
    expect(job.startSec).toBeCloseTo(5.4 - 1, 9);
    expect(job.endSec).toBeCloseTo(3 + 0.6 * 11 + 0.6 + 0.25, 9);
    expect(job.opts.bpm).toBe(100);
    expect(job.opts.beatsPerBar).toBe(4);
    expect(job.opts.firstDownbeatSec).toBeCloseTo(1, 9);
    expect(job.opts.beatTimes).toHaveLength(8);
    job.opts.beatTimes?.forEach((sec, k) => expect(sec).toBeCloseTo(1 + 0.6 * k, 9));
    expect(job.opts.maxSeconds).toBeCloseTo(job.endSec - job.startSec + 1, 9);
  });

  it('never starts before the audio and takes the pre/post roll as parameters', () => {
    const t = transcription(3, 100, 0.5);
    const job = sectionStrumJob(t, section(0, 1));
    expect(job?.startSec).toBe(0);
    expect(job?.opts.firstDownbeatSec).toBe(0.5);
    expect(job?.opts.beatTimes).toHaveLength(9);
    const custom = sectionStrumJob(t, section(1, 1), 0.2, 0);
    expect(custom?.startSec).toBeCloseTo(2.9 - 0.2, 9);
    expect(custom?.endSec).toBeCloseTo(0.5 + 0.6 * 8 + 0.6, 9);
  });

  it('is null for a section with fewer beats than a bar (nothing to analyse)', () => {
    const t = transcription(3, 100, 0.5);
    expect(sectionStrumJob(t, section(2, 2))).toBeNull(); // last bar alone: 4 beats, no beat after it
    expect(sectionStrumJob(t, section(0, 9))).toBeNull();
  });
});

describe('sectionStrumPattern', () => {
  it('keeps the pattern from confidence 0.3 over at least SECTION_STRUM_MIN_BARS bars', () => {
    expect(SECTION_STRUM_MIN_BARS).toBe(2);
    expect(sectionStrumPattern(detection('D-DU-UDU', 0.9, 8))).toBe('D-DU-UDU');
    expect(sectionStrumPattern(detection('D-DU-UDU', 0.3, 2))).toBe('D-DU-UDU');
    expect(sectionStrumPattern(detection('D-DU-UDU', 0.29, 8))).toBeUndefined();
    expect(sectionStrumPattern(detection('D-DU-UDU', 0.9, 1))).toBeUndefined();
    expect(sectionStrumPattern(detection('D-DU-UDU', Number.NaN, 8))).toBeUndefined();
    expect(sectionStrumPattern(detection('', 0.9, 8))).toBeUndefined();
    expect(sectionStrumPattern(null)).toBeUndefined();
    expect(sectionStrumPattern(undefined)).toBeUndefined();
  });
});

describe('detectSectionStrums', () => {
  const SR = 1000;
  afterEach(() => vi.restoreAllMocks());

  function twoSections(): ChordTranscription {
    return transcription(4, 100, 0.5, { sections: [section(0, 1, 'Estrofa', 'A'), section(2, 3, 'Estribillo', 'B')] });
  }

  it('runs the detector on every section slice with the section grid and keeps the confident patterns', () => {
    const calls: Array<{ length: number; opts: Parameters<StrumDetector>[2] }> = [];
    const results = [detection('D-DU-UDU', 0.8, 2), detection('DUDUDUDU', 0.2, 2)];
    const detect: StrumDetector = (samples, rate, opts) => {
      expect(rate).toBe(SR);
      calls.push({ length: samples.length, opts });
      return results[calls.length - 1];
    };
    const out = detectSectionStrums(new Float32Array(12 * SR), SR, twoSections(), detect);
    expect(out).toEqual(['D-DU-UDU', undefined]);
    expect(calls).toHaveLength(2);
    expect(calls[0].opts).toMatchObject({ bpm: 100, beatsPerBar: 4, firstDownbeatSec: 0.5 });
    expect(calls[0].opts.beatTimes).toHaveLength(9);
    expect(calls[0].length / SR).toBeCloseTo(0.5 + 0.6 * 8 + 0.6 + 0.25, 2);
    expect(calls[1].opts.firstDownbeatSec).toBeCloseTo(1, 9);
    expect(calls[1].opts.beatTimes).toHaveLength(8);
    expect(calls[1].length / SR).toBeCloseTo(0.5 + 0.6 * 15 + 0.85 - (0.5 + 0.6 * 8 - 1), 2);
  });

  it('is undefined without sections or when no section has a pattern of its own', () => {
    const detect = vi.fn<StrumDetector>(() => detection('D-DU-UDU', 0.9, 8));
    expect(detectSectionStrums(new Float32Array(12 * SR), SR, transcription(4, 100, 0.5), detect)).toBeUndefined();
    expect(detectSectionStrums(new Float32Array(12 * SR), SR, transcription(4, 100, 0.5, { sections: [] }), detect)).toBeUndefined();
    expect(detect).not.toHaveBeenCalled();
    const weak = vi.fn<StrumDetector>(() => detection('D-DU-UDU', 0.1, 8));
    expect(detectSectionStrums(new Float32Array(12 * SR), SR, twoSections(), weak)).toBeUndefined();
    expect(weak).toHaveBeenCalledTimes(2);
  });

  it('a failing detection only loses that section (warned, never thrown)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const detect: StrumDetector = () => {
      n++;
      if (n === 1) throw new Error('boom');
      return detection('D-D-D-D-', 0.7, 2);
    };
    expect(detectSectionStrums(new Float32Array(12 * SR), SR, twoSections(), detect)).toEqual([undefined, 'D-D-D-D-']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Estrofa');
  });

  it('skips a section too short to analyse and clamps the slice to the audio', () => {
    const t = transcription(3, 100, 0.5, { sections: [section(0, 1, 'Intro', 'A'), section(2, 2, 'Final', 'B')] });
    const detect = vi.fn<StrumDetector>(() => detection('D-DU-UDU', 0.9, 2));
    // Only 4 s of audio: the first section's slice ends at the audio's end.
    expect(detectSectionStrums(new Float32Array(4 * SR), SR, t, detect)).toEqual(['D-DU-UDU', undefined]);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0][0]).toHaveLength(4 * SR);
  });

  it('end to end with dsp/strumDetect.ts: two sections strummed differently get their own patterns', () => {
    const SR = 44100;
    const a = synthStrummedProgression(['C', 'G', 'Am', 'F'], SR, { bpm: 100, pattern: 'D-DU-UDU', rounds: 2, seed: 1 });
    const b = synthStrummedProgression(['F', 'G', 'C', 'C'], SR, { bpm: 100, pattern: 'D-D-D-D-', rounds: 2, seed: 31 });
    const samples = new Float32Array(a.signal.length + b.signal.length);
    samples.set(a.signal, 0);
    samples.set(b.signal, a.signal.length);
    const t = transcription(16, 100, 0, { sections: [section(0, 7, 'Estrofa', 'A'), section(8, 15, 'Estribillo', 'B')] });
    const out = detectSectionStrums(samples, SR, t);
    expect(out).toEqual(['D-DU-UDU', 'D-D-D-D-']);
    expect(sectionStrumsNote(out, 'D-DU-UDU', 4)).toBe('rasgueo propio en 1 sección');
  });
});

describe('sectionStrumsNote', () => {
  it('counts the sections whose pattern differs from the global one', () => {
    expect(sectionStrumsNote(undefined, 'D-DU-UDU', 4)).toBeNull();
    expect(sectionStrumsNote([undefined, undefined], 'D-DU-UDU', 4)).toBeNull();
    expect(sectionStrumsNote(['D-DU-UDU', undefined], 'D-DU-UDU', 4)).toBeNull();
    expect(sectionStrumsNote(['D-DU-UDU', 'DUDUDUDU'], 'D-DU-UDU', 4)).toBe('rasgueo propio en 1 sección');
    expect(sectionStrumsNote(['DUDUDUDU', 'D-D-DUDU', undefined], 'D-DU-UDU', 4)).toBe('rasgueo propio en 2 secciones');
  });

  it('without a global pattern the reference is one down-strum per beat', () => {
    expect(sectionStrumsNote(['D-D-D-D-'], undefined, 4)).toBeNull();
    expect(sectionStrumsNote(['D-D-D-'], '', 3)).toBeNull();
    expect(sectionStrumsNote(['D-DU-UDU'], undefined, 4)).toBe('rasgueo propio en 1 sección');
  });
});

// ------------------------------------------------------------------ wiring (source-level checks, no DOM in Node)

describe('editor / library wiring (SPEC section 16)', () => {
  it('the editor records taps with a document space-bar listener that is removed when the recording ends', () => {
    expect(editorSource).toMatch(/document\.addEventListener\('keydown', onRecordKeyDown\)/);
    expect(editorSource).toMatch(/document\.removeEventListener\('keydown', onRecordKeyDown\)/);
    expect(editorSource).toMatch(/isTypingTarget\(ev\.target\)/);
    expect(editorSource).toMatch(/patternFromTaps\(rec\.taps, rec\.beatTimes, rec\.beatsPerBar\)/);
    expect(editorSource).toMatch(/startPreview\('metronome', \{ bars: RECORD_BARS, stopAtEnd: true \}\)/);
    expect(editorSource).toMatch(/ctx\.resume\(\)/);
  });

  it('"Sustituir acordes" and "Desde audio…" pass the per-section strums to chartFromTranscription', () => {
    expect(editorSource).toMatch(/transcriptionSectionStrums = detectSectionStrums\(samples, sampleRate, t\)/);
    expect(editorSource).toMatch(/sectionStrums:\s*transcriptionSectionStrums/);
    expect(librarySource).toMatch(/detectSectionStrums\(samples, info\.sampleRate, transcription\)/);
    expect(librarySource).toMatch(/\{ title, strum, sectionStrums \}/);
  });

  it('keeps the default test listen at PREVIEW_BARS bars', () => {
    expect(PREVIEW_BARS).toBe(8);
    expect(editorSource).toMatch(/opts\.bars > 0 \? Math\.round\(opts\.bars\) : PREVIEW_BARS/);
  });
});
