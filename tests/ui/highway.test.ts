import { describe, expect, it } from 'vitest';
import {
  HighwayRenderer,
  MARGIN_PX,
  ballHeight,
  ballY,
  clamp,
  computeBounce,
  computeLayout,
  countInStartBeat,
  eventX,
  firstBarAtOrAfter,
  idleBeat,
  lowerBound,
  pxPerBeatFor,
  rowOf,
  strikeXFor,
  timingText,
  upperBound,
  verdictColor,
  verdictText,
  visibleBeatRange,
  visibleEventRange,
  type Bounce,
} from '../../src/ui/highway';
import { DIAGRAM_COLORS, diagramFretCount, drawChordDiagram } from '../../src/ui/chordDiagram';
import type { ChordShape, ChordSymbol, Song, SongBar, StrumEvent } from '../../src/types';

// ------------------------------------------------------------------ fixtures

const C_CHORD: ChordSymbol = { name: 'C', root: 0, quality: 'maj', bass: null };

function ev(index: number, time: number, chordChange = false): StrumEvent {
  return {
    index,
    time,
    chord: C_CHORD,
    direction: 'down',
    muted: false,
    barIndex: Math.floor(time / 4),
    beatInBar: time % 4,
    chordChange,
  };
}

/** Events every `step` beats from 0 (inclusive) to `end` (inclusive). */
function eventsEvery(step: number, end: number): StrumEvent[] {
  const out: StrumEvent[] = [];
  for (let t = 0, i = 0; t <= end + 1e-9; t += step, i++) out.push(ev(i, t, t % 4 === 0));
  return out;
}

function makeSong(barBeats: number[], events: StrumEvent[] = []): Song {
  const bars: SongBar[] = [];
  let start = 0;
  for (let i = 0; i < barBeats.length; i++) {
    bars.push({ index: i, startBeat: start, beats: barBeats[i], section: null, chords: [] });
    start += barBeats[i];
  }
  return {
    id: 't',
    title: 'Test',
    artist: '',
    tempo: 120,
    tempoSegments: [{ fromBeat: 0, bpm: 120 }],
    timeSignature: { beatsPerBar: barBeats[0] ?? 4, beatUnit: 4 },
    capo: 0,
    bars,
    events,
    totalBeats: start,
    chordNames: ['C'],
    lyricLines: [],
    source: '',
  };
}

function bounce(): Bounce {
  return { start: 0, end: 0, fixed: false, resting: false };
}

// ------------------------------------------------------------------ basic helpers

describe('clamp / rowOf / scale helpers', () => {
  it('clamp bounds the value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('rowOf uses tab order by default (1st string on top) and 6th on top when inverted', () => {
    for (let i = 0; i < 6; i++) {
      expect(rowOf(i, false)).toBe(5 - i);
      expect(rowOf(i, true)).toBe(i);
    }
    // bijective in both modes
    const a = new Set([0, 1, 2, 3, 4, 5].map((i) => rowOf(i, false)));
    const b = new Set([0, 1, 2, 3, 4, 5].map((i) => rowOf(i, true)));
    expect(a.size).toBe(6);
    expect(b.size).toBe(6);
  });

  it('pxPerBeat = clamp(width / 8, 90, 160)', () => {
    expect(pxPerBeatFor(400)).toBe(90);
    expect(pxPerBeatFor(1000)).toBe(125);
    expect(pxPerBeatFor(2000)).toBe(160);
  });

  it('strikeX = 0.25 * width and eventX moves with the beat', () => {
    expect(strikeXFor(800)).toBe(200);
    expect(eventX(4, 4, 200, 100)).toBe(200);
    expect(eventX(5, 4, 200, 100)).toBe(300);
    expect(eventX(3.5, 4, 200, 100)).toBe(150);
  });
});

describe('ball maths', () => {
  it('ballHeight = clamp(0.5 * deltaBeats * pxPerBeat, 24, 0.6 * height)', () => {
    expect(ballHeight(1, 120, 300)).toBe(60);
    expect(ballHeight(0.1, 120, 300)).toBe(24);
    expect(ballHeight(100, 120, 300)).toBe(180);
    // never taller than 0.6 * height, even when that is below the 24 px floor
    expect(ballHeight(1, 120, 30)).toBe(18);
  });

  it('ballY is a parabola with its apex at f = 0.5', () => {
    expect(ballY(0, 50)).toBe(0);
    expect(ballY(1, 50)).toBe(0);
    expect(ballY(0.5, 50)).toBe(50);
    expect(ballY(0.25, 50)).toBeCloseTo(ballY(0.75, 50));
    expect(ballY(0.25, 50)).toBeCloseTo(37.5);
    // f outside [0, 1] is clamped
    expect(ballY(-1, 50)).toBe(0);
    expect(ballY(2, 50)).toBe(0);
  });
});

// ------------------------------------------------------------------ ranges

describe('lowerBound / upperBound / firstBarAtOrAfter', () => {
  const events = eventsEvery(0.5, 8);

  it('lowerBound returns the first event at or after the time', () => {
    expect(lowerBound(events, 3)).toBe(6);
    expect(lowerBound(events, 3.1)).toBe(7);
    expect(lowerBound(events, -5)).toBe(0);
    expect(lowerBound(events, 100)).toBe(events.length);
    expect(lowerBound([], 0)).toBe(0);
  });

  it('upperBound returns the first event strictly after the time', () => {
    expect(upperBound(events, 3)).toBe(7);
    expect(upperBound(events, 2.9)).toBe(6);
    expect(upperBound(events, -5)).toBe(0);
    expect(upperBound(events, 8)).toBe(events.length);
    expect(upperBound([], 0)).toBe(0);
  });

  it('firstBarAtOrAfter searches by startBeat', () => {
    const song = makeSong([4, 4, 4, 4]);
    expect(firstBarAtOrAfter(song.bars, -3)).toBe(0);
    expect(firstBarAtOrAfter(song.bars, 4)).toBe(1);
    expect(firstBarAtOrAfter(song.bars, 4.5)).toBe(2);
    expect(firstBarAtOrAfter(song.bars, 99)).toBe(4);
  });
});

describe('visible range', () => {
  it('visibleBeatRange maps the canvas (plus margin) to beats', () => {
    const r = visibleBeatRange(4, 100, 100, 400, 0);
    expect(r.fromBeat).toBe(3);
    expect(r.toBeat).toBe(7);
    const m = visibleBeatRange(4, 100, 100, 400, 50);
    expect(m.fromBeat).toBe(2.5);
    expect(m.toBeat).toBe(7.5);
  });

  it('visibleEventRange culls off-screen events on both sides', () => {
    const events = eventsEvery(0.5, 15);
    const { from, to } = visibleEventRange(events, 4, 100, 100, 400, 0);
    expect(events[from].time).toBe(3);
    expect(events[from - 1].time).toBeLessThan(3);
    expect(events[to - 1].time).toBe(7);
    expect(events[to].time).toBeGreaterThan(7);
    for (let i = from; i < to; i++) {
      const x = eventX(events[i].time, 4, 100, 100);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
    }
  });

  it('visibleEventRange uses MARGIN_PX by default and handles empty lists', () => {
    const events = eventsEvery(1, 15);
    const withDefault = visibleEventRange(events, 4, 100, 100, 400);
    const explicit = visibleEventRange(events, 4, 100, 100, 400, MARGIN_PX);
    expect(withDefault).toEqual(explicit);
    expect(visibleEventRange([], 4, 100, 100, 400)).toEqual({ from: 0, to: 0 });
  });
});

// ------------------------------------------------------------------ idle / count-in

describe('idleBeat', () => {
  const song = makeSong([4, 4, 4, 4]);

  it('shows one bar of lead before the bar the session starts from', () => {
    expect(idleBeat(song, 0)).toBe(-4);
    expect(idleBeat(song, 8)).toBe(4);
    expect(idleBeat(song, 9)).toBe(4);
    expect(idleBeat(song, -3)).toBe(-4);
    expect(idleBeat(song, NaN)).toBe(-4);
  });

  it('respects the bar length and the lead cap', () => {
    expect(idleBeat(makeSong([3, 3]), 0)).toBe(-3);
    expect(idleBeat(song, 0, 2)).toBe(-2);
    expect(idleBeat(song, 8, 2)).toBe(6);
    expect(idleBeat(song, 0, 0)).toBe(-1);
    expect(idleBeat(makeSong([]), 0)).toBe(-4);
  });
});

describe('countInStartBeat', () => {
  it('recovers the pass start from beat + countInBeatsLeft', () => {
    expect(countInStartBeat(-4, 4)).toBe(0);
    expect(countInStartBeat(-3.2, 4)).toBe(0);
    expect(countInStartBeat(-0.3, 1)).toBe(0);
    expect(countInStartBeat(12.3, 4)).toBe(16);
    expect(countInStartBeat(12, 4)).toBe(16);
    expect(countInStartBeat(15.999, 1)).toBe(16);
  });
});

// ------------------------------------------------------------------ bounce

describe('computeBounce', () => {
  const events = eventsEvery(1, 7); // 0..7

  it('bounces between consecutive events while playing', () => {
    const b = computeBounce(bounce(), events, 2.4, 3, false, 0);
    expect(b).toEqual({ start: 2, end: 3, fixed: false, resting: false });
  });

  it('spans rests (including N.C.) with a single arc between the surrounding events', () => {
    const sparse = [ev(0, 3), ev(1, 8)];
    const b = computeBounce(bounce(), sparse, 5, 1, false, 0);
    expect(b.start).toBe(3);
    expect(b.end).toBe(8);
    expect(b.fixed).toBe(false);
  });

  it('bounces every beat during the count-in and lands the last one on the first event', () => {
    expect(computeBounce(bounce(), events, -3.5, 0, true, 4)).toEqual({ start: -4, end: -3, fixed: true, resting: false });
    expect(computeBounce(bounce(), events, -0.5, 0, true, 1)).toEqual({ start: -1, end: 0, fixed: true, resting: false });
  });

  it('lands on a first event that is off the beat', () => {
    const offBeat = [ev(0, 0.5), ev(1, 1), ev(2, 1.5)];
    expect(computeBounce(bounce(), offBeat, -0.5, 0, true, 1)).toEqual({ start: -1, end: 0, fixed: true, resting: false });
    // playing but still before the first event: short final bounce onto it
    expect(computeBounce(bounce(), offBeat, 0.2, 0, false, 0)).toEqual({ start: 0, end: 0.5, fixed: true, resting: false });
  });

  it('targets the first event of the pass when resuming mid-song', () => {
    // resume at bar 4 (beat 16): count-in 12..16, nextEventIndex still points inside bar 3
    const long = eventsEvery(1, 23);
    const b = computeBounce(bounce(), long, 15.3, 16, true, 1);
    expect(b).toEqual({ start: 15, end: 16, fixed: true, resting: false });
    const early = computeBounce(bounce(), long, 12.5, 13, true, 4);
    expect(early).toEqual({ start: 12, end: 13, fixed: true, resting: false });
  });

  it('rests after the last event and with no events at all', () => {
    const b = computeBounce(bounce(), events, 7.6, events.length, false, 0);
    expect(b).toEqual({ start: 7, end: 7, fixed: true, resting: true });
    const none = computeBounce(bounce(), [], 3.2, 0, false, 0);
    expect(none.resting).toBe(true);
    expect(none.start).toBe(3);
  });

  it('bounces per beat before the first event without a count-in (leading rest)', () => {
    const late = [ev(0, 4), ev(1, 5)];
    expect(computeBounce(bounce(), late, 1.5, 0, false, 0)).toEqual({ start: 1, end: 2, fixed: true, resting: false });
    expect(computeBounce(bounce(), late, 3.5, 0, false, 0)).toEqual({ start: 3, end: 4, fixed: true, resting: false });
  });

  it('is robust to out-of-range nextEventIndex and reuses the out object', () => {
    const out = bounce();
    expect(computeBounce(out, events, 2.5, -3, false, 0)).toBe(out);
    expect(out.fixed).toBe(true);
    expect(computeBounce(out, events, 2.5, 99, false, 0).resting).toBe(true);
  });
});

// ------------------------------------------------------------------ labels / colours

describe('labels and colours', () => {
  it('timingText gives the Spanish feedback strings', () => {
    expect(timingText('perfect')).toBe('¡Perfecto!');
    expect(timingText('good')).toBe('¡Bien!');
    expect(timingText('late')).toBe('Tarde');
    expect(timingText('early')).toBe('Pronto');
    expect(timingText(null)).toBe('');
  });

  it('verdictText labels wrong and missed only', () => {
    expect(verdictText('wrong')).toBe('Mal');
    expect(verdictText('missed')).toBe('Perdido');
    expect(verdictText('correct')).toBe('');
    expect(verdictText('skipped')).toBe('');
  });

  it('verdictColor is distinct per kind and neutral otherwise', () => {
    const colours = new Set([verdictColor('correct'), verdictColor('wrong'), verdictColor('missed'), verdictColor(undefined)]);
    expect(colours.size).toBe(4);
    expect(verdictColor('skipped')).toBe(verdictColor(undefined));
    expect(verdictColor(null)).toBe(verdictColor(undefined));
  });
});

// ------------------------------------------------------------------ layout

describe('computeLayout', () => {
  it('keeps everything inside the canvas at common sizes', () => {
    for (const [w, h] of [
      [800, 300],
      [360, 160],
      [1400, 500],
      [320, 200],
    ]) {
      const L = computeLayout(w, h);
      expect(L.strikeX).toBe(0.25 * w);
      expect(L.pxPerBeat).toBe(pxPerBeatFor(w));
      expect(L.stringsTop).toBeGreaterThan(L.chordNameY);
      expect(L.chordNameY).toBeGreaterThan(L.headerY);
      expect(L.stringsBottom).toBeGreaterThan(L.stringsTop);
      expect(L.stringsTop + 5 * L.rowGap).toBeCloseTo(L.stringsBottom);
      expect(2 * L.markerR).toBeLessThanOrEqual(L.rowGap + 1e-9);
      expect(L.ballBaseline + L.ballR).toBeLessThanOrEqual(h);
      expect(L.ballBaseline).toBeGreaterThan(L.stringsBottom);
    }
  });

  it('never breaks on a zero-sized canvas', () => {
    const L = computeLayout(0, 0);
    expect(L.width).toBe(0);
    expect(L.height).toBe(0);
    expect(Number.isFinite(L.rowGap)).toBe(true);
  });
});

// ------------------------------------------------------------------ renderer (type-level only)

describe('HighwayRenderer', () => {
  it('is exported as a class (not instantiated: no canvas in Node)', () => {
    expect(typeof HighwayRenderer).toBe('function');
    expect(typeof HighwayRenderer.prototype.render).toBe('function');
    expect(typeof HighwayRenderer.prototype.resize).toBe('function');
    expect(typeof HighwayRenderer.prototype.setSettings).toBe('function');
  });
});

// ------------------------------------------------------------------ chord diagram (recording fake context)

interface Call {
  name: string;
  args: unknown[];
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
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
  return { ctx, calls };
}

function texts(calls: Call[]): string[] {
  return calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
}

const C_SHAPE: ChordShape = { name: 'C', frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], baseFret: 1 };
const F_SHAPE: ChordShape = {
  name: 'F',
  frets: [1, 3, 3, 2, 1, 1],
  fingers: [1, 3, 4, 2, 1, 1],
  baseFret: 1,
  barre: { fret: 1, fromString: 0, toString: 5 },
};
const GM_SHAPE: ChordShape = {
  name: 'Gm',
  frets: [3, 5, 5, 3, 3, 3],
  fingers: [1, 3, 4, 1, 1, 1],
  baseFret: 3,
  barre: { fret: 3, fromString: 0, toString: 5 },
  generated: true,
};
const BOX = { x: 10, y: 10, w: 120, h: 160 };

describe('diagramFretCount', () => {
  it('shows at least 4 frets and grows with the shape', () => {
    expect(diagramFretCount(C_SHAPE)).toBe(4);
    expect(diagramFretCount(GM_SHAPE)).toBe(4);
    expect(diagramFretCount({ name: 'X', frets: [3, 5, 7, 3, 3, 3], fingers: [1, 2, 4, 1, 1, 1], baseFret: 3 })).toBe(5);
  });
});

describe('drawChordDiagram', () => {
  it('draws a box with the title and "sin digitación" for a null shape', () => {
    const { ctx, calls } = fakeCtx();
    drawChordDiagram(ctx, null, BOX, { title: 'Cmaj9' });
    const t = texts(calls);
    expect(t).toContain('Cmaj9');
    expect(t).toContain('sin digitación');
    expect(calls.filter((c) => c.name === 'save').length).toBe(1);
    expect(calls.filter((c) => c.name === 'restore').length).toBe(1);
  });

  it('draws dots with finger numbers, O markers and no fret label for an open chord', () => {
    const { ctx, calls } = fakeCtx();
    drawChordDiagram(ctx, C_SHAPE, BOX);
    const t = texts(calls);
    expect(t).toContain('C');
    expect(t).toContain('3');
    expect(t).toContain('2');
    expect(t).toContain('1');
    expect(t.some((s) => s.endsWith('fr'))).toBe(false);
    // 3 dots + 2 open-string markers
    expect(calls.filter((c) => c.name === 'arc').length).toBe(5);
  });

  it('draws the barre as a rounded bar and only the remaining dots', () => {
    const { ctx, calls } = fakeCtx();
    drawChordDiagram(ctx, F_SHAPE, BOX);
    expect(calls.some((c) => c.name === 'arcTo')).toBe(true);
    // strings 1, 2, 3 are above the barre -> 3 dots; no open strings
    expect(calls.filter((c) => c.name === 'arc').length).toBe(3);
    const t = texts(calls);
    expect(t.filter((s) => s === '1').length).toBe(1);
    expect(t).toContain('3');
    expect(t).toContain('4');
    expect(t).toContain('2');
  });

  it('labels the base fret when the shape does not start at the nut', () => {
    const { ctx, calls } = fakeCtx();
    drawChordDiagram(ctx, GM_SHAPE, BOX);
    expect(texts(calls)).toContain('3fr');
  });

  it('omits finger numbers when showFingers is false and honours a custom title', () => {
    const { ctx, calls } = fakeCtx();
    drawChordDiagram(ctx, C_SHAPE, BOX, { title: 'Do', showFingers: false });
    const t = texts(calls);
    expect(t).toContain('Do');
    expect(t).not.toContain('C');
    expect(t.some((s) => /^\d$/.test(s))).toBe(false);
  });

  it('draws a big X when muted (with and without a shape)', () => {
    const plain = fakeCtx();
    drawChordDiagram(plain.ctx, C_SHAPE, BOX);
    const muted = fakeCtx();
    drawChordDiagram(muted.ctx, C_SHAPE, BOX, { muted: true });
    const strokes = (calls: Call[]) => calls.filter((c) => c.name === 'stroke').length;
    expect(strokes(muted.calls)).toBe(strokes(plain.calls) + 1);
    expect((muted.ctx as unknown as { strokeStyle: string }).strokeStyle).toBe(DIAGRAM_COLORS.mutedX);

    const none = fakeCtx();
    expect(() => drawChordDiagram(none.ctx, null, BOX, { muted: true })).not.toThrow();
    expect(texts(none.calls)).toContain('sin digitación');
  });

  it('does not throw on a tiny box', () => {
    const { ctx } = fakeCtx();
    expect(() => drawChordDiagram(ctx, F_SHAPE, { x: 0, y: 0, w: 4, h: 4 })).not.toThrow();
  });
});
