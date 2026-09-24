import { describe, expect, it } from 'vitest';
import {
  AUDIO_SAVE_DELAY_MS,
  DEFAULT_TRACK_GAIN,
  OFFSET_STEPS_SEC,
  PREVIEW_BARS,
  applyTempoHeader,
  confidenceLabel,
  formatBpm,
  formatMegabytes,
  formatTempoEstimate,
  previewClickTimes,
  previewStartSec,
  rewriteTempoHeader,
} from '../../src/ui/screens/editor';
import {
  BACKING_SAVE_DELAY_MS,
  HEADPHONES_WARNING,
  SPEED_TITLE_WITH_TRACK,
  backingPositionSec,
  needsHeadphonesWarning,
  practiceScreen,
} from '../../src/ui/screens/practice';
import { AUDIO_BADGE, songMeta } from '../../src/ui/screens/library';
import {
  MIN_VIEW_SEC,
  PEAK_BUCKETS_PER_SEC,
  WaveformView,
  clampViewport,
  computePeaks,
  formatRulerSec,
  gridBeatSec,
  rulerStepSec,
  zoomViewport,
} from '../../src/ui/waveform';
import { FRET_LABEL_GAP, FRET_LABEL_INSET, drawChordDiagram, fretLabelPadding, fretLabelText } from '../../src/ui/chordDiagram';
import { parseSong } from '../../src/song/parser';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { AudioTrackInfo, ChordShape, StoredSong } from '../../src/types';

// ------------------------------------------------------------------ tempo header

describe('rewriteTempoHeader / applyTempoHeader', () => {
  it('is exported under both names', () => {
    expect(applyTempoHeader).toBe(rewriteTempoHeader);
  });

  it('rewrites an existing tempo: header in place, keeping the comment', () => {
    const src = 'title: X\ntempo: 120   # original\ntime: 4/4\n\nC . . . | G . . . |';
    const out = rewriteTempoHeader(src, 96);
    expect(out).toBe('title: X\ntempo: 96   # original\ntime: 4/4\n\nC . . . | G . . . |');
    expect(parseSong(out).song.tempo).toBe(96);
  });

  it('handles "tempo:120", "Tempo : 120 bpm" and decimal values', () => {
    expect(rewriteTempoHeader('tempo:120\nC . . . |', 100)).toBe('tempo:100\nC . . . |');
    expect(rewriteTempoHeader('Tempo : 120 bpm\nC . . . |', 100)).toBe('Tempo : 100 bpm\nC . . . |');
    const out = rewriteTempoHeader('tempo: 120\nC . . . |', 96.5);
    expect(out).toBe('tempo: 96.5\nC . . . |');
    const { song, errors } = parseSong(out);
    expect(song.tempo).toBeCloseTo(96.5, 6);
    expect(errors).toEqual([]);
  });

  it('inserts the header after the leading headers when there is none', () => {
    const src = 'title: Mi canción\nartist: Yo\n\n[Intro]\nC . . . | G . . . |';
    const out = rewriteTempoHeader(src, 110);
    expect(out).toBe('title: Mi canción\nartist: Yo\ntempo: 110\n\n[Intro]\nC . . . | G . . . |');
    const { song, errors } = parseSong(out);
    expect(song.tempo).toBe(110);
    expect(errors.filter((e) => e.severity === 'warning')).toEqual([]); // no "tempo no indicado"
  });

  it('inserts at the top when the text starts with bars (or is empty)', () => {
    expect(rewriteTempoHeader('C . . . | G . . . |', 90)).toBe('tempo: 90\nC . . . | G . . . |');
    expect(rewriteTempoHeader('', 90)).toBe('tempo: 90\n');
    expect(parseSong(rewriteTempoHeader('C . . . |', 90)).song.tempo).toBe(90);
  });

  it('only touches the initial tempo, never a tempo change between bars', () => {
    const src = 'tempo: 100\nC . . . |\ntempo: 140\nG . . . |';
    const out = rewriteTempoHeader(src, 80);
    expect(out).toBe('tempo: 80\nC . . . |\ntempo: 140\nG . . . |');
    const { song } = parseSong(out);
    expect(song.tempoSegments.map((s) => s.bpm)).toEqual([80, 140]);
  });

  it('inserts before the first bar when the only tempo: comes after bars', () => {
    const src = 'title: X\nC . . . |\ntempo: 140\nG . . . |';
    const out = rewriteTempoHeader(src, 80);
    expect(out).toBe('title: X\ntempo: 80\nC . . . |\ntempo: 140\nG . . . |');
  });

  it('skips comments, blank lines, sections and lyrics while looking for the header', () => {
    const src = '# comentario\n\n[Intro]\n> letra\ntempo: 70\nC . . . |';
    expect(rewriteTempoHeader(src, 75)).toBe('# comentario\n\n[Intro]\n> letra\ntempo: 75\nC . . . |');
  });

  it('preserves CRLF line endings', () => {
    const src = 'title: X\r\ntempo: 120\r\nC . . . |';
    expect(rewriteTempoHeader(src, 100)).toBe('title: X\r\ntempo: 100\r\nC . . . |');
    expect(rewriteTempoHeader('title: X\r\nC . . . |', 100)).toBe('title: X\r\ntempo: 100\r\nC . . . |');
  });

  it('is idempotent', () => {
    const once = rewriteTempoHeader('title: X\n\nC . . . |', 96);
    expect(rewriteTempoHeader(once, 96)).toBe(once);
  });
});

// ------------------------------------------------------------------ formatting helpers

describe('tempo estimate formatting', () => {
  it('formatBpm rounds to a tenth without a trailing .0', () => {
    expect(formatBpm(96)).toBe('96');
    expect(formatBpm(96.04)).toBe('96');
    expect(formatBpm(96.46)).toBe('96.5');
    expect(formatBpm(119.96)).toBe('120');
  });

  it('confidenceLabel uses the 0.6 / 0.3 thresholds', () => {
    expect(confidenceLabel(1)).toBe('alta');
    expect(confidenceLabel(0.6)).toBe('alta');
    expect(confidenceLabel(0.59)).toBe('media');
    expect(confidenceLabel(0.3)).toBe('media');
    expect(confidenceLabel(0.29)).toBe('baja');
    expect(confidenceLabel(0)).toBe('baja');
  });

  it('formatTempoEstimate matches the spec text', () => {
    expect(formatTempoEstimate({ bpm: 96, confidence: 0.8, firstBeatSec: 1.32 })).toBe('≈ 96 BPM (confianza alta), inicio 1.32 s');
    expect(formatTempoEstimate({ bpm: 140.5, confidence: 0.4, firstBeatSec: 0 })).toBe('≈ 140.5 BPM (confianza media), inicio 0.00 s');
  });

  it('formatMegabytes always reports MB with one decimal', () => {
    expect(formatMegabytes(3_200_000)).toBe('3.1 MB');
    expect(formatMegabytes(0)).toBe('0.0 MB');
    expect(formatMegabytes(-5)).toBe('0.0 MB');
    expect(formatMegabytes(1048576)).toBe('1.0 MB');
  });
});

// ------------------------------------------------------------------ test listen

describe('previewStartSec / previewClickTimes', () => {
  it('starts one bar before the offset, or at 0 when that is negative', () => {
    expect(previewStartSec(5, 120, 4)).toBeCloseTo(3, 9); // 4 beats at 120 bpm = 2 s
    expect(previewStartSec(1, 120, 4)).toBe(0);
    expect(previewStartSec(2, 120, 4)).toBe(0);
    expect(previewStartSec(-1, 120, 4)).toBe(0);
    expect(previewStartSec(3, 0, 4)).toBe(3); // degenerate tempo: from the offset itself
  });

  it('schedules a click on every grid beat from the lead-in bar, accent on the downbeat', () => {
    const clicks = previewClickTimes(4, 120, 4, 2, 2);
    // lead-in beats -4..-1 at 2, 2.5, 3, 3.5 s; bars 1-2 at 4..7.5 s
    expect(clicks.length).toBe(12);
    expect(clicks[0]).toEqual({ sec: 2, accent: true });
    expect(clicks[1]).toEqual({ sec: 2.5, accent: false });
    expect(clicks[4]).toEqual({ sec: 4, accent: true });
    expect(clicks[8]).toEqual({ sec: 6, accent: true });
    expect(clicks[11]).toEqual({ sec: 7.5, accent: false });
    for (let i = 1; i < clicks.length; i++) expect(clicks[i].sec).toBeGreaterThan(clicks[i - 1].sec);
  });

  it('drops the clicks before fromSec (lead-in cut by the start of the audio)', () => {
    const clicks = previewClickTimes(1, 120, 4, 0, 1);
    expect(clicks[0].sec).toBeCloseTo(0, 9); // beat -2 at 0 s
    expect(clicks[0].accent).toBe(false);
    expect(clicks.map((c) => c.sec)).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
    expect(clicks.filter((c) => c.accent).length).toBe(1);
  });

  it('covers PREVIEW_BARS bars by default and is empty for a degenerate grid', () => {
    const clicks = previewClickTimes(0, 60, 3, 0);
    expect(clicks.length).toBe(PREVIEW_BARS * 3);
    expect(previewClickTimes(0, 0, 4, 0)).toEqual([]);
    expect(previewClickTimes(0, 120, 0, 0)).toEqual([]);
  });

  it('exposes the audio panel constants', () => {
    expect(AUDIO_SAVE_DELAY_MS).toBe(300);
    expect(DEFAULT_TRACK_GAIN).toBe(0.8);
    expect(OFFSET_STEPS_SEC).toEqual([-0.1, -0.01, 0.01, 0.1]);
    expect(PREVIEW_BARS).toBe(8);
  });
});

// ------------------------------------------------------------------ waveform helpers

describe('waveform helpers', () => {
  it('computePeaks gives one min/max bucket per millisecond', () => {
    const sr = 1000;
    const samples = new Float32Array(2500);
    for (let i = 0; i < samples.length; i++) samples[i] = i < 1000 ? 0.5 : i < 2000 ? -0.25 : 0;
    samples[1500] = 0.9;
    const peaks = computePeaks(samples, sr);
    expect(peaks.bucketsPerSec).toBe(PEAK_BUCKETS_PER_SEC);
    expect(peaks.durationSec).toBeCloseTo(2.5, 9);
    expect(peaks.min.length).toBe(2500);
    expect(peaks.max[0]).toBeCloseTo(0.5, 6);
    expect(peaks.min[0]).toBeCloseTo(0.5, 6);
    expect(peaks.min[1200]).toBeCloseTo(-0.25, 6);
    expect(peaks.max[1500]).toBeCloseTo(0.9, 6);
    expect(peaks.min[2400]).toBe(0);
  });

  it('computePeaks buckets several samples at high sample rates and tolerates empty input', () => {
    const sr = 48000;
    const samples = new Float32Array(4800); // 0.1 s
    samples[10] = -1;
    samples[4700] = 1;
    const peaks = computePeaks(samples, sr);
    expect(peaks.min.length).toBe(100);
    expect(peaks.min[0]).toBe(-1);
    expect(peaks.max[97]).toBe(1);
    const empty = computePeaks(new Float32Array(0), sr);
    expect(empty.durationSec).toBe(0);
    expect(empty.min.length).toBe(0);
  });

  it('clampViewport keeps the view inside the audio', () => {
    expect(clampViewport(0, 10, 10)).toEqual({ startSec: 0, seconds: 10 });
    expect(clampViewport(5, 10, 10)).toEqual({ startSec: 0, seconds: 10 });
    expect(clampViewport(-3, 2, 10)).toEqual({ startSec: 0, seconds: 2 });
    expect(clampViewport(9.5, 2, 10)).toEqual({ startSec: 8, seconds: 2 });
    expect(clampViewport(1, 0, 10)).toEqual({ startSec: 0, seconds: 10 });
    expect(clampViewport(1, 0.0001, 10).seconds).toBe(MIN_VIEW_SEC);
    expect(clampViewport(NaN, NaN, 10)).toEqual({ startSec: 0, seconds: 10 });
  });

  it('zoomViewport keeps the anchor time at the same pixel', () => {
    const view = { startSec: 0, seconds: 10 };
    const zoomed = zoomViewport(view, 2, 5, 60);
    expect(zoomed.seconds).toBeCloseTo(5, 9);
    // 5 s was at 50 % of the view; it must stay at 50 %
    expect(zoomed.startSec + zoomed.seconds * 0.5).toBeCloseTo(5, 9);
    const out = zoomViewport({ startSec: 10, seconds: 10 }, 0.5, 12, 60);
    expect(out.seconds).toBeCloseTo(20, 9);
    expect(out.startSec + out.seconds * 0.2).toBeCloseTo(12, 9);
    expect(zoomViewport(view, 0, 5, 60)).toEqual(view);
    expect(zoomViewport(view, 0.01, 5, 60).seconds).toBe(60);
  });

  it('gridBeatSec / rulerStepSec / formatRulerSec', () => {
    expect(gridBeatSec({ bpm: 120, offsetSec: 1.5 }, 4)).toBeCloseTo(3.5, 9);
    expect(gridBeatSec({ bpm: 120, offsetSec: 1.5 }, -4)).toBeCloseTo(-0.5, 9);
    expect(rulerStepSec(100)).toBe(1); // 1 s = 100 px >= 72
    expect(rulerStepSec(10)).toBe(10);
    expect(rulerStepSec(1000)).toBe(0.1);
    expect(rulerStepSec(0.001)).toBe(600);
    expect(formatRulerSec(65, 1)).toBe('1:05');
    expect(formatRulerSec(5, 5)).toBe('0:05');
    expect(formatRulerSec(65.25, 0.05)).toBe('1:05.25');
    expect(formatRulerSec(3.5, 0.5)).toBe('0:03.5');
    expect(formatRulerSec(-1, 1)).toBe('0:00');
  });

  it('exports the WaveformView class with the spec API (not instantiated: no canvas in Node)', () => {
    const proto = WaveformView.prototype as unknown as Record<string, unknown>;
    for (const m of ['setAudio', 'setGrid', 'setPlayhead', 'setViewport', 'zoomBy', 'scrollBy', 'resize', 'render', 'dispose']) {
      expect(typeof proto[m]).toBe('function');
    }
  });
});

// ------------------------------------------------------------------ practice: backing helpers

describe('practice backing-track helpers', () => {
  const audio: AudioTrackInfo = { name: 'a.mp3', type: 'audio/mpeg', size: 1, durationSec: 100, offsetSec: 1.5, gain: 0.8 };

  it('backingPositionSec maps a beat to audio seconds through the tempo map', () => {
    const song = { tempoSegments: [{ fromBeat: 0, bpm: 120 }] };
    expect(backingPositionSec(audio, song, 0)).toBeCloseTo(1.5, 9);
    expect(backingPositionSec(audio, song, 8)).toBeCloseTo(5.5, 9);
    // count-in start before the audio starts -> negative (BackingTrack delays the source)
    expect(backingPositionSec(audio, song, -4)).toBeCloseTo(-0.5, 9);
    const twoTempos = { tempoSegments: [{ fromBeat: 0, bpm: 120 }, { fromBeat: 8, bpm: 60 }] };
    expect(backingPositionSec(audio, twoTempos, 12)).toBeCloseTo(1.5 + 4 + 4, 9);
  });

  it('needsHeadphonesWarning only when the track plays while the mic evaluates', () => {
    expect(needsHeadphonesWarning(true, { backingTrack: true, listen: true })).toBe(true);
    expect(needsHeadphonesWarning(false, { backingTrack: true, listen: true })).toBe(false);
    expect(needsHeadphonesWarning(true, { backingTrack: false, listen: true })).toBe(false);
    expect(needsHeadphonesWarning(true, { backingTrack: true, listen: false })).toBe(false);
    expect(needsHeadphonesWarning(true, DEFAULT_SETTINGS)).toBe(true);
  });

  it('exposes the Spanish strings and constants of the header', () => {
    expect(BACKING_SAVE_DELAY_MS).toBe(300);
    expect(SPEED_TITLE_WITH_TRACK).toBe('A menos velocidad la pista suena más grave');
    expect(HEADPHONES_WARNING).toContain('auriculares');
    expect(typeof practiceScreen.mount).toBe('function');
  });
});

// ------------------------------------------------------------------ library badge

describe('library "♪ pista" badge', () => {
  const base: StoredSong = { id: 's_x', title: 'T', artist: '', source: 'tempo: 100\nC . . . |', updatedAt: 1 };

  it('songMeta reports hasAudio only for songs with a track', () => {
    const audio: AudioTrackInfo = { name: 'a.mp3', type: 'audio/mpeg', size: 1, durationSec: 10, offsetSec: 0, gain: 0.8 };
    expect(songMeta(base).hasAudio).toBe(false);
    expect(songMeta({ ...base, audio: null }).hasAudio).toBe(false);
    expect(songMeta({ ...base, audio }).hasAudio).toBe(true);
    expect(AUDIO_BADGE).toBe('♪ pista');
  });
});

// ------------------------------------------------------------------ chord diagram: fret label fits

interface Call {
  name: string;
  args: unknown[];
}

/** Recording fake context whose measureText estimates 0.6 em per character from the current font. */
function measuringCtx(): { ctx: CanvasRenderingContext2D; calls: Call[]; state: Record<string, unknown> } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif' };
  const ctx = new Proxy(state, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop === 'measureText') {
          const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(String(t.font))?.[1] ?? '10');
          return { width: String(args[0]).length * px * 0.6 };
        }
        return undefined;
      };
    },
    set(t, prop, value) {
      if (typeof prop === 'string') t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, state };
}

const BB_SHAPE: ChordShape = {
  name: 'Bb',
  frets: [6, 8, 8, 7, 6, 6],
  fingers: [1, 3, 4, 2, 1, 1],
  baseFret: 6,
  barre: { fret: 6, fromString: 0, toString: 5 },
  generated: true,
};

function labelCall(calls: Call[], text: string): Call {
  const call = calls.find((c) => c.name === 'fillText' && c.args[0] === text);
  if (!call) throw new Error(`no fillText for ${text}`);
  return call;
}

/** x of every vertical segment (moveTo followed by lineTo at the same x): the six strings. */
function stringXs(calls: Call[]): number[] {
  const xs: number[] = [];
  for (let i = 1; i < calls.length; i++) {
    const a = calls[i - 1];
    const b = calls[i];
    if (a.name === 'moveTo' && b.name === 'lineTo' && a.args[0] === b.args[0] && a.args[1] !== b.args[1]) xs.push(a.args[0] as number);
  }
  return xs;
}

describe('drawChordDiagram base-fret label', () => {
  it('fretLabelText / fretLabelPadding', () => {
    expect(fretLabelText(6)).toBe('6fr');
    expect(fretLabelPadding(14.4, 0, 5)).toBe(14.4);
    expect(fretLabelPadding(14.4, 20, 5)).toBe(FRET_LABEL_INSET + 20 + FRET_LABEL_GAP + 5 + 1);
  });

  it('keeps "6fr" inside a 96 px wide box (the practice "Siguiente" canvas)', () => {
    const box = { x: 0, y: 0, w: 96, h: 80 };
    const { ctx, calls } = measuringCtx();
    drawChordDiagram(ctx, BB_SHAPE, box, { title: 'Bb', showFingers: true });
    const label = labelCall(calls, '6fr');
    const right = label.args[1] as number;
    const px = parseFloat(/(\d+)px/.exec(String(calls.find((c) => c.name === 'measureText') ? ctx.font : '10px'))?.[1] ?? '10');
    const width = '6fr'.length * px * 0.6;
    expect(right - width).toBeGreaterThanOrEqual(box.x + FRET_LABEL_INSET - 1e-9);
    expect(right).toBeLessThan(box.x + box.w);
    // the label sits left of the 6th string (the leftmost vertical line)
    const gridLeft = Math.min(...stringXs(calls));
    expect(right).toBeLessThan(gridLeft);
  });

  it('widens only the left padding: the 1st string stays where it was and the strings stay evenly spaced', () => {
    const box = { x: 10, y: 10, w: 96, h: 120 };
    const open: ChordShape = { name: 'C', frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], baseFret: 1 };
    const a = measuringCtx();
    drawChordDiagram(a.ctx, open, box);
    const b = measuringCtx();
    drawChordDiagram(b.ctx, BB_SHAPE, box);
    const openStrings = stringXs(a.calls);
    const barreStrings = stringXs(b.calls);
    expect(openStrings.length).toBe(6);
    expect(barreStrings.length).toBe(6);
    expect(Math.max(...barreStrings)).toBeCloseTo(Math.max(...openStrings), 6); // right padding untouched
    expect(Math.max(...openStrings)).toBeCloseTo(box.x + box.w - box.w * 0.15, 6);
    expect(Math.min(...barreStrings)).toBeGreaterThan(Math.min(...openStrings)); // left padding grew
    const gaps = barreStrings.slice(1).map((x, i) => x - barreStrings[i]);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 6);
    // the barre dot row and the fret label share the first row: label right of box.x + inset, left of string 6
    const label = labelCall(b.calls, '6fr');
    expect(label.args[1] as number).toBeLessThan(Math.min(...barreStrings));
  });

  it('does not widen the padding for open-position shapes', () => {
    const box = { x: 0, y: 0, w: 96, h: 120 };
    const open: ChordShape = { name: 'G', frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3], baseFret: 1 };
    const { ctx, calls } = measuringCtx();
    drawChordDiagram(ctx, open, box);
    expect(calls.some((c) => c.name === 'measureText')).toBe(false);
    expect(Math.min(...stringXs(calls))).toBeCloseTo(box.w * 0.15, 6);
  });

  it('still draws with a measureText that returns 0 (estimate fallback)', () => {
    const box = { x: 0, y: 0, w: 96, h: 80 };
    const calls: Call[] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
      get(t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in t) return t[prop];
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          return prop === 'measureText' ? { width: 0 } : undefined;
        };
      },
      set(t, prop, value) {
        if (typeof prop === 'string') t[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    expect(() => drawChordDiagram(ctx, BB_SHAPE, box)).not.toThrow();
    const label = labelCall(calls, '6fr');
    expect(label.args[1] as number).toBeGreaterThan(box.x + FRET_LABEL_INSET);
  });
});
