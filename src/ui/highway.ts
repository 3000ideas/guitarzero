/**
 * HighwayRenderer — the scrolling "road" of upcoming strums, the bouncing ball and the
 * two-phase feedback (hit ring first, verdict colour later). Canvas 2D only, dark theme,
 * crisp at any devicePixelRatio: resize() sets the DPR transform and every coordinate below
 * is in CSS pixels.
 *
 * The small pure helpers (layout, bounce maths, visible range, labels) are exported so they
 * can be unit-tested in Node without a canvas.
 */
import type {
  ChordShape,
  Hit,
  LoopRange,
  SessionState,
  Settings,
  Song,
  SongBar,
  StrumDirection,
  StrumEvent,
  TimingLabel,
  Verdict,
  VerdictKind,
} from '../types';

// ------------------------------------------------------------------ constants

const TAU = Math.PI * 2;
/** Events/grid this far outside the canvas (CSS px) are still processed, then culled. */
export const MARGIN_PX = 80;
/** Duration of the hit ring / verdict pulse animations. */
export const HIT_ANIM_MS = 1000;
/** Duration of the ball colour flash after a verdict. */
export const FLASH_MS = 400;
/** Beats after a landing during which the shockwave ring is drawn. */
export const SHOCKWAVE_BEATS = 0.5;

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SMALL = `11px ${FONT_FAMILY}`;
const FONT_SMALL_BOLD = `bold 11px ${FONT_FAMILY}`;
const FONT_FRET = `bold 11px ${FONT_FAMILY}`;
const FONT_CHORD = `bold 15px ${FONT_FAMILY}`;
const FONT_LABEL = `bold 12px ${FONT_FAMILY}`;
const FONT_FLOAT = `bold 15px ${FONT_FAMILY}`;
const FONT_COUNT = `bold 28px ${FONT_FAMILY}`;

/** String names by string index (0 = low E). */
const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];

/** Pre-built digit strings so the per-frame loop does not allocate. */
const INT_TEXT: string[] = [];
for (let i = 0; i <= 40; i++) INT_TEXT.push(String(i));
function intText(n: number): string {
  return n >= 0 && n < INT_TEXT.length ? INT_TEXT[n] : String(n);
}

export const HIGHWAY_COLORS = {
  bg: '#0f1116',
  past: 'rgba(0, 0, 0, 0.22)',
  line: '#ffffff',
  string: '#94a3b8',
  text: '#cbd5e1',
  textDim: '#64748b',
  accent: '#22d3ee',
  neutral: '#38bdf8',
  neutralText: '#e2e8f0',
  unknown: '#facc15',
  correct: '#22c55e',
  wrong: '#ef4444',
  missed: '#9ca3af',
  onMarkerDark: '#0b1220',
  onMarkerLight: '#ffffff',
  white: '#ffffff',
  ballOutline: 'rgba(0, 0, 0, 0.35)',
} as const;

const C = HIGHWAY_COLORS;

// ------------------------------------------------------------------ pure helpers

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Screen row (0 = top) of a string index (0 = low E). Tab order by default (1st string on
 * top); with `invertStrings` the 6th string is on top (player's view).
 */
export function rowOf(stringIndex: number, invertStrings: boolean): number {
  return invertStrings ? stringIndex : 5 - stringIndex;
}

export function pxPerBeatFor(width: number): number {
  return clamp(width / 8, 90, 160);
}

export function strikeXFor(width: number): number {
  return 0.25 * width;
}

/** Horizontal position of a beat-time given the current song beat. */
export function eventX(time: number, beat: number, strikeX: number, pxPerBeat: number): number {
  return strikeX + (time - beat) * pxPerBeat;
}

/** Bounce height for a gap of `deltaBeats` between consecutive events. */
export function ballHeight(deltaBeats: number, pxPerBeat: number, height: number): number {
  return Math.min(Math.max(0.5 * deltaBeats * pxPerBeat, 24), 0.6 * height);
}

/** Lift of the ball above its baseline for bounce progress f (0 = take-off, 1 = landing). */
export function ballY(f: number, h: number): number {
  const t = clamp(f, 0, 1);
  return h * 4 * t * (1 - t);
}

/** First index whose event time is >= `time` (events are sorted by time). */
export function lowerBound(events: readonly StrumEvent[], time: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose event time is > `time`. */
export function upperBound(events: readonly StrumEvent[], time: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First bar whose startBeat is >= `beat`. */
export function firstBarAtOrAfter(bars: readonly SongBar[], beat: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].startBeat < beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Beat interval whose x falls inside [-marginPx, width + marginPx]. */
export function visibleBeatRange(
  beat: number,
  strikeX: number,
  pxPerBeat: number,
  width: number,
  marginPx = MARGIN_PX,
): { fromBeat: number; toBeat: number } {
  return {
    fromBeat: beat - (strikeX + marginPx) / pxPerBeat,
    toBeat: beat + (width - strikeX + marginPx) / pxPerBeat,
  };
}

/** Index range [from, to) of the events currently on screen (plus margin). */
export function visibleEventRange(
  events: readonly StrumEvent[],
  beat: number,
  strikeX: number,
  pxPerBeat: number,
  width: number,
  marginPx = MARGIN_PX,
): { from: number; to: number } {
  const fromBeat = beat - (strikeX + marginPx) / pxPerBeat;
  const toBeat = beat + (width - strikeX + marginPx) / pxPerBeat;
  return { from: lowerBound(events, fromBeat), to: upperBound(events, toBeat) };
}

/**
 * Beat shown while idle: one bar before the bar containing max(0, beat), so the bar the
 * session will start from sits to the right of the strike line. `maxLeadBeats` caps the lead
 * so that narrow canvases still show that bar.
 */
export function idleBeat(song: Song, beat: number, maxLeadBeats = Infinity): number {
  const b = beat > 0 ? beat : 0;
  const bars = song.bars;
  let bar: SongBar | undefined = bars[0];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].startBeat <= b) bar = bars[i];
    else break;
  }
  const start = bar ? bar.startBeat : 0;
  const lead = Math.min(bar ? bar.beats : song.timeSignature.beatsPerBar, maxLeadBeats);
  return start - Math.max(lead, 1);
}

/**
 * Start beat of the current pass during the count-in. countInBeatsLeft = ceil(start - beat)
 * and bar starts are integer beats, hence start = floor(beat) + countInBeatsLeft.
 */
export function countInStartBeat(beat: number, countInBeatsLeft: number): number {
  return Math.floor(beat) + countInBeatsLeft;
}

/** Current bounce segment of the ball, in beats. */
export interface Bounce {
  /** Beat of the last landing (segment start). */
  start: number;
  /** Beat of the next landing (segment end). */
  end: number;
  /** True during count-in / before the first event: fixed height bounce on every beat. */
  fixed: boolean;
  /** True after the last event: the ball rests on its baseline. */
  resting: boolean;
}

/**
 * Computes (into `out`, allocation-free) the bounce segment for the current beat:
 * - between consecutive events (including N.C.) while playing;
 * - during the count-in or before the first event: one bounce per beat, the last one landing
 *   on the first event of the pass;
 * - after the last event: resting.
 */
export function computeBounce(
  out: Bounce,
  events: readonly StrumEvent[],
  beat: number,
  nextEventIndex: number,
  countIn: boolean,
  countInBeatsLeft: number,
): Bounce {
  const n = events.length;
  const i = nextEventIndex < 0 ? 0 : nextEventIndex > n ? n : Math.floor(nextEventIndex);
  if (!countIn && i > 0 && i < n) {
    out.start = events[i - 1].time;
    out.end = events[i].time;
    if (!(out.end > out.start)) out.end = out.start + 1;
    out.fixed = false;
    out.resting = false;
    return out;
  }
  if (!countIn && i >= n) {
    out.start = n > 0 ? events[n - 1].time : Math.floor(beat);
    out.end = out.start;
    out.fixed = true;
    out.resting = true;
    return out;
  }
  const passStart = countIn ? countInStartBeat(beat, countInBeatsLeft) : -Infinity;
  const j = countIn ? lowerBound(events, passStart) : i;
  const firstTime = j < n ? events[j].time : Infinity;
  const segStart = Math.floor(beat);
  let segEnd = segStart + 1;
  if (firstTime > segStart && firstTime < segEnd) segEnd = firstTime;
  out.start = segStart;
  out.end = segEnd;
  out.fixed = true;
  out.resting = false;
  return out;
}

/** Floating text shown when an onset is assigned to an event. */
export function timingText(label: TimingLabel): string {
  switch (label) {
    case 'perfect':
      return '¡Perfecto!';
    case 'good':
      return '¡Bien!';
    case 'late':
      return 'Tarde';
    case 'early':
      return 'Pronto';
    default:
      return '';
  }
}

/** Label drawn under a judged event ('' when nothing is shown). */
export function verdictText(kind: VerdictKind): string {
  switch (kind) {
    case 'wrong':
      return 'Mal';
    case 'missed':
      return 'Perdido';
    default:
      return '';
  }
}

export function verdictColor(kind: VerdictKind | null | undefined): string {
  switch (kind) {
    case 'correct':
      return C.correct;
    case 'wrong':
      return C.wrong;
    case 'missed':
      return C.missed;
    default:
      return C.neutral;
  }
}

export interface HighwayLayout {
  width: number;
  height: number;
  strikeX: number;
  pxPerBeat: number;
  /** Left gutter reserved for the string names. */
  leftPad: number;
  topPad: number;
  bottomPad: number;
  /** y of screen row 0 / row 5. */
  stringsTop: number;
  stringsBottom: number;
  rowGap: number;
  /** Radius of the per-string fret circles. */
  markerR: number;
  ballR: number;
  /** y of the ball centre when resting (just below the lowest string row). */
  ballBaseline: number;
  /** Baseline y of the chord names drawn above the strings. */
  chordNameY: number;
  /** Middle y of the bar number / section header row. */
  headerY: number;
}

/** Layout in CSS px for a canvas of the given size. */
export function computeLayout(width: number, height: number): HighwayLayout {
  const topPad = clamp(0.17 * height, 46, 64);
  const bottomPad = clamp(0.16 * height, 40, 56);
  const stringsTop = topPad;
  const stringsBottom = Math.max(stringsTop + 5, height - bottomPad);
  const rowGap = (stringsBottom - stringsTop) / 5;
  const markerR = clamp(rowGap * 0.4, 6, 12);
  const ballR = clamp(0.035 * height, 7, 12);
  return {
    width,
    height,
    strikeX: strikeXFor(width),
    pxPerBeat: pxPerBeatFor(width),
    leftPad: 24,
    topPad,
    bottomPad,
    stringsTop,
    stringsBottom,
    rowGap,
    markerR,
    ballR,
    ballBaseline: stringsBottom + ballR + 2,
    chordNameY: stringsTop - markerR - 6,
    headerY: 10,
  };
}

// ------------------------------------------------------------------ renderer

/** Cached per-event feedback, keyed by event index and matched by object identity. */
interface Feedback {
  hit: Hit | undefined;
  verdict: Verdict | undefined;
  /** When the hit (or the entry) was first seen; the ring/text animate 1 s from here. */
  firstSeenMs: number;
  /** When the verdict was first seen; the marker pulses 1 s from here. */
  verdictSeenMs: number;
}

export class HighwayRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly song: Song;
  private readonly shapes: Record<string, ChordShape | null>;
  private settings: Settings;
  private layout: HighwayLayout = computeLayout(0, 0);
  private readonly feedback = new Map<number, Feedback>();
  private readonly barHeaders: string[];
  private readonly sectionStart: boolean[];
  private readonly bounce: Bounce = { start: 0, end: 1, fixed: true, resting: true };
  private ballGradient: CanvasGradient | null = null;
  private flashKind: VerdictKind | null = null;
  private flashMs = -Infinity;

  constructor(
    canvas: HTMLCanvasElement,
    song: Song,
    shapes: Record<string, ChordShape | null>,
    settings: Settings,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.canvas = canvas;
    this.ctx = ctx;
    this.song = song;
    this.shapes = shapes;
    this.settings = settings;
    this.barHeaders = [];
    this.sectionStart = [];
    for (let i = 0; i < song.bars.length; i++) {
      const bar = song.bars[i];
      const starts = bar.section !== null && (i === 0 || song.bars[i - 1].section !== bar.section);
      this.sectionStart.push(starts);
      this.barHeaders.push(starts ? `${bar.index + 1} · ${bar.section}` : String(bar.index + 1));
    }
    this.resize();
  }

  setSettings(s: Settings): void {
    this.settings = s;
  }

  /** canvas.width/height = client size × devicePixelRatio; drawing happens in CSS px. */
  resize(): void {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.layout = computeLayout(w, h);
    this.ballGradient = this.makeBallGradient(this.layout.ballR);
  }

  render(state: SessionState, nowMs: number): void {
    const canvas = this.canvas;
    if (canvas.clientWidth !== this.layout.width || canvas.clientHeight !== this.layout.height) {
      this.resize();
    }
    const L = this.layout;
    if (L.width <= 0 || L.height <= 0) return;
    const phase = state.phase;
    const countIn = phase === 'countin';
    const maxLead = Math.floor((L.width - L.strikeX - 40) / L.pxPerBeat);
    const beat = phase === 'idle' ? idleBeat(this.song, state.beat, maxLead) : state.beat;
    const countStart = countIn ? countInStartBeat(beat, state.countInBeatsLeft) : -Infinity;
    const range = visibleEventRange(this.song.events, beat, L.strikeX, L.pxPerBeat, L.width);

    this.syncFeedback(state, nowMs, range.from, range.to);
    this.drawGrid(beat, state.loop);
    this.drawStrings();
    this.drawStrikeLine();
    this.drawEvents(state, beat, range.from, range.to, countStart, nowMs);
    this.drawHitOverlays(beat, range.from, range.to, nowMs);
    if (phase !== 'idle') this.drawBall(state, beat, countIn, nowMs);
    this.ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- feedback cache

  private syncFeedback(state: SessionState, nowMs: number, from: number, to: number): void {
    const hits = state.hits;
    const verdicts = state.verdicts;
    // Drop or refresh entries whose objects no longer match (restart / seek / new session).
    for (const [i, e] of this.feedback) {
      const h = hits[i];
      const v = verdicts[i];
      if (h === e.hit && v === e.verdict) continue;
      if (h === undefined && v === undefined) {
        this.feedback.delete(i);
        continue;
      }
      if (h !== e.hit) {
        e.hit = h;
        e.firstSeenMs = nowMs;
      }
      if (v !== e.verdict) {
        e.verdict = v;
        e.verdictSeenMs = nowMs;
        this.noteVerdict(v, nowMs);
      }
    }
    // New entries for visible events.
    for (let i = from; i < to; i++) {
      if (this.feedback.has(i)) continue;
      const h = hits[i];
      const v = verdicts[i];
      if (h === undefined && v === undefined) continue;
      this.feedback.set(i, { hit: h, verdict: v, firstSeenMs: nowMs, verdictSeenMs: nowMs });
      this.noteVerdict(v, nowMs);
    }
  }

  private noteVerdict(v: Verdict | undefined, nowMs: number): void {
    if (v && v.kind !== 'skipped') {
      this.flashKind = v.kind;
      this.flashMs = nowMs;
    }
  }

  // ---------------------------------------------------------------- background

  private rowY(row: number): number {
    return this.layout.stringsTop + row * this.layout.rowGap;
  }

  private drawGrid(beat: number, loop: LoopRange | null): void {
    const L = this.layout;
    const ctx = this.ctx;
    const ppb = L.pxPerBeat;
    const sx = L.strikeX;
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, L.width, L.height);
    ctx.fillStyle = C.past;
    ctx.fillRect(0, 0, sx, L.height);

    const fromBeat = beat - (sx + MARGIN_PX) / ppb;
    const toBeat = beat + (L.width - sx + MARGIN_PX) / ppb;

    // Faint line per beat.
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.07;
    ctx.beginPath();
    for (let b = Math.ceil(fromBeat); b <= toBeat; b++) {
      const x = eventX(b, beat, sx, ppb);
      ctx.moveTo(x, L.stringsTop - 8);
      ctx.lineTo(x, L.stringsBottom + 8);
    }
    ctx.stroke();

    // Stronger line per bar (+ end of song).
    const bars = this.song.bars;
    const first = firstBarAtOrAfter(bars, fromBeat);
    ctx.globalAlpha = 0.2;
    ctx.beginPath();
    for (let i = first; i < bars.length && bars[i].startBeat <= toBeat; i++) {
      const x = eventX(bars[i].startBeat, beat, sx, ppb);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, L.height);
    }
    const total = this.song.totalBeats;
    if (total >= fromBeat && total <= toBeat) {
      const x = eventX(total, beat, sx, ppb);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, L.height);
    }
    ctx.stroke();

    // Loop boundaries in the accent colour.
    if (loop) {
      const a = bars[loop.fromBar];
      const z = bars[loop.toBar];
      if (a && z) {
        ctx.strokeStyle = C.accent;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        const x1 = eventX(a.startBeat, beat, sx, ppb);
        const x2 = eventX(z.startBeat + z.beats, beat, sx, ppb);
        if (x1 > -10 && x1 < L.width + 10) {
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, L.height);
        }
        if (x2 > -10 && x2 < L.width + 10) {
          ctx.moveTo(x2, 0);
          ctx.lineTo(x2, L.height);
        }
        ctx.stroke();
      }
    }

    // Bar numbers and section labels.
    ctx.globalAlpha = 1;
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = first; i < bars.length && bars[i].startBeat <= toBeat; i++) {
      const x = eventX(bars[i].startBeat, beat, sx, ppb);
      if (x > L.width) break;
      ctx.fillStyle = this.sectionStart[i] ? C.accent : C.textDim;
      ctx.fillText(this.barHeaders[i], x + 4, L.headerY);
    }
  }

  private drawStrings(): void {
    const L = this.layout;
    const ctx = this.ctx;
    const invert = this.settings.invertStrings;
    ctx.strokeStyle = C.string;
    ctx.globalAlpha = 0.5;
    for (let s = 0; s < 6; s++) {
      const y = this.rowY(rowOf(s, invert));
      ctx.lineWidth = 0.8 + (5 - s) * 0.3; // low strings thicker
      ctx.beginPath();
      ctx.moveTo(L.leftPad, y);
      ctx.lineTo(L.width, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.textDim;
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let s = 0; s < 6; s++) {
      ctx.fillText(STRING_NAMES[s], 6, this.rowY(rowOf(s, invert)));
    }
  }

  private drawStrikeLine(): void {
    const L = this.layout;
    const ctx = this.ctx;
    const top = L.stringsTop - 14;
    const bottom = L.height - 2;
    ctx.strokeStyle = C.accent;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(L.strikeX, top);
    ctx.lineTo(L.strikeX, bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L.strikeX, top);
    ctx.lineTo(L.strikeX, bottom);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- events

  private drawEvents(
    state: SessionState,
    beat: number,
    from: number,
    to: number,
    countStart: number,
    nowMs: number,
  ): void {
    const L = this.layout;
    const ctx = this.ctx;
    const events = this.song.events;
    for (let i = from; i < to; i++) {
      const ev = events[i];
      const x = eventX(ev.time, beat, L.strikeX, L.pxPerBeat);
      const verdict = state.verdicts[i];
      const kind = verdict ? verdict.kind : undefined;
      let alpha = 1;
      if (ev.time < countStart) alpha = 0.45; // previous bar shown during the count-in
      else if (ev.time < beat && (kind === undefined || kind === 'skipped')) alpha = 0.6;
      ctx.globalAlpha = alpha;

      if (ev.chord.quality === 'nc') {
        if (ev.chordChange) this.drawName('N.C.', x, C.textDim);
        continue;
      }

      const shape = this.shapes[ev.chord.name];
      const unknown = shape === null || shape === undefined;
      let color: string;
      let onColor: string = C.onMarkerDark;
      let nameColor: string = C.neutralText;
      if (kind === 'correct') {
        color = C.correct;
        nameColor = color;
      } else if (kind === 'wrong') {
        color = C.wrong;
        onColor = C.onMarkerLight;
        nameColor = color;
      } else if (kind === 'missed') {
        color = C.missed;
        nameColor = color;
      } else if (unknown) {
        color = C.unknown;
        nameColor = color;
      } else {
        color = C.neutral;
      }

      const fb = this.feedback.get(i);
      if (fb && fb.verdict) {
        const t = (nowMs - fb.verdictSeenMs) / HIT_ANIM_MS;
        if (t >= 0 && t < 1) this.drawPulse(x, color, t, alpha);
      }

      if (ev.muted) this.drawMutedX(x, color);
      else if (!ev.chordChange) this.drawArrowBar(x, ev.direction, color, alpha);
      else if (shape) this.drawColumn(x, shape, color, onColor);
      else this.drawUnknownMarker(x, color, onColor);

      if (ev.chordChange) this.drawName(ev.chord.name, x, nameColor);
      if (verdict && (kind === 'wrong' || kind === 'missed')) this.drawVerdictLabels(x, verdict, color);
    }
  }

  private drawName(text: string, x: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = FONT_CHORD;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(text, x, this.layout.chordNameY);
  }

  /** Translucent halo behind a marker during the first second after its verdict. */
  private drawPulse(x: number, color: string, t: number, alpha: number): void {
    const L = this.layout;
    const ctx = this.ctx;
    const hw = L.markerR * (1 + 2 * t);
    ctx.globalAlpha = alpha * 0.35 * (1 - t);
    ctx.fillStyle = color;
    ctx.fillRect(x - hw, L.stringsTop - L.markerR - 2, 2 * hw, L.stringsBottom - L.stringsTop + 2 * L.markerR + 4);
    ctx.globalAlpha = alpha;
  }

  /** Full column: one circle per string with the fret number ('0' open, nothing when muted). */
  private drawColumn(x: number, shape: ChordShape, color: string, onColor: string): void {
    const L = this.layout;
    const ctx = this.ctx;
    const invert = this.settings.invertStrings;
    const r = L.markerR;
    ctx.font = FONT_FRET;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let s = 0; s < 6; s++) {
      const fret = shape.frets[s];
      if (fret === undefined || fret < 0) continue;
      const y = this.rowY(rowOf(s, invert));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      if (fret === 0) {
        ctx.fillStyle = C.bg;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText('0', x, y + 0.5);
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = onColor;
        ctx.fillText(intText(fret), x, y + 0.5);
      }
    }
  }

  /** Single yellow marker for a chord without a known fingering. */
  private drawUnknownMarker(x: number, color: string, onColor: string): void {
    const L = this.layout;
    const ctx = this.ctx;
    const y = (L.stringsTop + L.stringsBottom) / 2;
    const r = L.markerR + 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = FONT_FRET;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = onColor;
    ctx.fillText('?', x, y + 0.5);
  }

  /** Thin bar across the six strings with a ↓/↑ arrowhead (up strums thinner and dimmer). */
  private drawArrowBar(x: number, direction: StrumDirection, color: string, alpha: number): void {
    const L = this.layout;
    const ctx = this.ctx;
    const up = direction === 'up';
    const top = L.stringsTop;
    const bottom = L.stringsBottom;
    ctx.globalAlpha = up ? alpha * 0.55 : alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = up ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(x, top - 4);
    ctx.lineTo(x, bottom + 4);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x - 5, top - 2);
      ctx.lineTo(x + 5, top - 2);
      ctx.lineTo(x, top - 9);
    } else {
      ctx.moveTo(x - 5, bottom + 2);
      ctx.lineTo(x + 5, bottom + 2);
      ctx.lineTo(x, bottom + 9);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  /** Percussive muted strum: an X across the strings. */
  private drawMutedX(x: number, color: string): void {
    const L = this.layout;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x - 8, L.stringsTop);
    ctx.lineTo(x + 8, L.stringsBottom);
    ctx.moveTo(x + 8, L.stringsTop);
    ctx.lineTo(x - 8, L.stringsBottom);
    ctx.stroke();
  }

  /** 'Mal' (+ detected chord) or 'Perdido' under the marker. */
  private drawVerdictLabels(x: number, verdict: Verdict, color: string): void {
    const L = this.layout;
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color;
    let y = L.stringsBottom + L.markerR + 3;
    if (verdict.kind === 'wrong' && verdict.detected) {
      ctx.font = FONT_LABEL;
      ctx.fillText(verdict.detected, x, y);
      y += 13;
    }
    ctx.font = FONT_SMALL_BOLD;
    ctx.fillText(verdictText(verdict.kind), x, y);
  }

  /** Phase 1 feedback: white ring + floating timing text, 1 s from the hit. */
  private drawHitOverlays(beat: number, from: number, to: number, nowMs: number): void {
    const L = this.layout;
    const ctx = this.ctx;
    const events = this.song.events;
    const midY = (L.stringsTop + L.stringsBottom) / 2;
    const textY0 = L.stringsTop + L.rowGap * 1.2;
    for (let i = from; i < to; i++) {
      const fb = this.feedback.get(i);
      if (!fb || !fb.hit) continue;
      const t = (nowMs - fb.firstSeenMs) / HIT_ANIM_MS;
      if (t < 0 || t >= 1) continue;
      const x = eventX(events[i].time, beat, L.strikeX, L.pxPerBeat);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1 + 2 * (1 - t);
      ctx.beginPath();
      ctx.arc(x, midY, L.markerR * 1.4 + 30 * t, 0, TAU);
      ctx.stroke();
      const text = timingText(fb.hit.timingLabel);
      if (text) {
        ctx.font = FONT_FLOAT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const y = textY0 - 28 * t;
        ctx.lineWidth = 4;
        ctx.strokeStyle = C.bg;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = C.white;
        ctx.fillText(text, x, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- ball

  private makeBallGradient(r: number): CanvasGradient | null {
    const ctx = this.ctx;
    if (typeof ctx.createRadialGradient !== 'function') return null;
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.15, 0, 0, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, '#cffafe');
    g.addColorStop(1, '#67e8f9');
    return g;
  }

  private drawBall(state: SessionState, beat: number, countIn: boolean, nowMs: number): void {
    const L = this.layout;
    const ctx = this.ctx;
    const events = this.song.events;
    const b = computeBounce(this.bounce, events, beat, state.nextEventIndex, countIn, state.countInBeatsLeft);
    const sx = L.strikeX;
    let y = L.ballBaseline;
    if (!b.resting) {
      const span = b.end - b.start;
      const f = span > 0 ? (beat - b.start) / span : 0;
      const h = ballHeight(b.fixed ? 1 : span, L.pxPerBeat, L.height);
      y = L.ballBaseline - ballY(f, h);
    }

    // Shockwave right after a landing.
    const since = beat - b.start;
    if (since >= 0 && since < SHOCKWAVE_BEATS) {
      const t = since / SHOCKWAVE_BEATS;
      ctx.globalAlpha = 0.8 * (1 - t);
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 3 - 2 * t;
      ctx.beginPath();
      ctx.arc(sx, L.ballBaseline, L.ballR + 26 * t, 0, TAU);
      ctx.stroke();
    }

    // The ball itself (neutral) plus a brief flash of the last verdict colour when listening.
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(sx, y);
    ctx.beginPath();
    ctx.arc(0, 0, L.ballR, 0, TAU);
    ctx.fillStyle = this.ballGradient ?? C.white;
    ctx.fill();
    if (state.live.listening && this.flashKind !== null) {
      const t = (nowMs - this.flashMs) / FLASH_MS;
      if (t >= 0 && t < 1) {
        ctx.globalAlpha = 0.9 * (1 - t);
        ctx.fillStyle = verdictColor(this.flashKind);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.strokeStyle = C.ballOutline;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Count-in number above the ball.
    if (countIn && state.countInBeatsLeft > 0) {
      const text = intText(state.countInBeatsLeft);
      ctx.font = FONT_COUNT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 5;
      ctx.strokeStyle = C.bg;
      ctx.strokeText(text, sx, y - L.ballR - 6);
      ctx.fillStyle = C.white;
      ctx.fillText(text, sx, y - L.ballR - 6);
    }
  }
}
