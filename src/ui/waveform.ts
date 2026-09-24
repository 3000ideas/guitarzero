/**
 * WaveformView — canvas view of a backing track (SPEC.md section 11, ui/waveform.ts).
 *
 * Draws the mono waveform (min/max peaks precomputed per millisecond in `setAudio`), the beat
 * grid of the chart (faint beat lines, marked bar lines with the bar number), the start marker
 * (`offsetSec`, an accent line with a draggable handle) and the playhead. Interaction:
 *  - click            -> onSeek(sec)
 *  - Shift + click    -> sets the start marker there (onOffsetChange)
 *  - drag the marker  -> onOffsetChange during the drag and on release
 *  - wheel            -> zoom around the cursor (Shift + wheel / horizontal wheel -> scroll)
 *  - middle button or Alt + drag -> scroll
 * DPR-correct; the owner calls `resize()` from its ResizeObserver. The pure helpers
 * (`computePeaks`, `clampViewport`, `zoomViewport`, `gridBeatSec`, `rulerStepSec`) are testable
 * in Node; nothing here touches `window` at import time.
 */

export interface WaveformGrid {
  bpm: number;
  beatsPerBar: number;
  /** Seconds into the audio where beat 0 (start of bar 1) falls; may be negative. */
  offsetSec: number;
  totalBeats: number;
}

export interface WaveformViewOpts {
  onOffsetChange: (sec: number) => void;
  onSeek?: (sec: number) => void;
}

export interface Viewport {
  startSec: number;
  seconds: number;
}

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  bucketsPerSec: number;
  durationSec: number;
}

/** One min/max bucket per millisecond. */
export const PEAK_BUCKETS_PER_SEC = 1000;
/** Narrowest visible span (zoom-in limit). */
export const MIN_VIEW_SEC = 0.05;
/** A click that moves further than this becomes a (cancelled) drag. */
export const DRAG_THRESHOLD_PX = 4;
/** Horizontal distance from the start marker that grabs it. */
export const HANDLE_HIT_PX = 8;
export const HANDLE_W = 12;
export const HANDLE_H = 14;
/** Height of the time ruler at the bottom (CSS px). */
export const RULER_H = 16;
/** Wheel sensitivity: zoom factor = exp(-deltaY * WHEEL_ZOOM). */
export const WHEEL_ZOOM = 0.002;

export const WAVEFORM_COLORS = {
  bg: '#12151c',
  axis: 'rgba(255, 255, 255, 0.07)',
  wave: '#3d7fb0',
  beat: 'rgba(255, 255, 255, 0.09)',
  bar: 'rgba(255, 255, 255, 0.28)',
  barText: '#aab2c0',
  offset: '#22d3ee',
  playhead: '#ffffff',
  ruler: '#0d1016',
  rulerTick: 'rgba(255, 255, 255, 0.25)',
  rulerText: '#8b93a1',
  empty: '#8b93a1',
} as const;

const RULER_STEPS_SEC: readonly number[] = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

// ---------------------------------------------------------------- pure helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Min/max of the samples per bucket (default: one bucket per millisecond). */
export function computePeaks(samples: Float32Array, sampleRate: number, bucketsPerSec: number = PEAK_BUCKETS_PER_SEC): Peaks {
  const n = samples.length;
  if (!(sampleRate > 0) || !(bucketsPerSec > 0) || n === 0) {
    return { min: new Float32Array(0), max: new Float32Array(0), bucketsPerSec, durationSec: 0 };
  }
  const durationSec = n / sampleRate;
  const perBucket = sampleRate / bucketsPerSec;
  const buckets = Math.ceil(n / perBucket);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const s0 = Math.floor(b * perBucket);
    const s1 = Math.min(n, Math.max(s0 + 1, Math.floor((b + 1) * perBucket)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = s0; i < s1; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) {
      lo = 0;
      hi = 0;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, bucketsPerSec, durationSec };
}

/** Keeps a viewport inside the audio: span within [MIN_VIEW_SEC, duration], start within [0, duration - span]. */
export function clampViewport(startSec: number, seconds: number, durationSec: number): Viewport {
  const total = Math.max(Number.isFinite(durationSec) ? durationSec : 0, MIN_VIEW_SEC);
  let span = Number.isFinite(seconds) && seconds > 0 ? seconds : total;
  span = clamp(span, MIN_VIEW_SEC, total);
  const start = clamp(Number.isFinite(startSec) ? startSec : 0, 0, total - span);
  return { startSec: start, seconds: span };
}

/** Zooms `view` by `factor` (> 1 zooms in) keeping `aroundSec` at the same pixel. */
export function zoomViewport(view: Viewport, factor: number, aroundSec: number, durationSec: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return clampViewport(view.startSec, view.seconds, durationSec);
  const span = view.seconds / factor;
  const frac = view.seconds > 0 ? (aroundSec - view.startSec) / view.seconds : 0;
  return clampViewport(aroundSec - frac * span, span, durationSec);
}

/** Audio time of beat `k` of the grid (k may be negative or fractional). */
export function gridBeatSec(grid: Pick<WaveformGrid, 'bpm' | 'offsetSec'>, k: number): number {
  return grid.offsetSec + (k * 60) / grid.bpm;
}

/** Ruler tick spacing (seconds) so that labels are at least `minPx` apart. */
export function rulerStepSec(pxPerSec: number, minPx = 72): number {
  for (const step of RULER_STEPS_SEC) if (step * pxPerSec >= minPx) return step;
  return RULER_STEPS_SEC[RULER_STEPS_SEC.length - 1];
}

/** "1:05" for coarse steps, "1:05.25" for sub-second ones. */
export function formatRulerSec(sec: number, stepSec: number): string {
  const s = Math.max(0, sec);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  if (stepSec >= 1) return `${minutes}:${String(Math.round(rest)).padStart(2, '0')}`;
  const fixed = rest.toFixed(stepSec >= 0.1 ? 1 : 2);
  return `${minutes}:${rest < 10 ? '0' : ''}${fixed}`;
}

// ---------------------------------------------------------------- view

type DragMode = 'offset' | 'pan' | 'click' | 'cancelled';

interface DragState {
  mode: DragMode;
  pointerId: number;
  downX: number;
  viewStartAtDown: number;
  /** Pixels between the pointer and the marker when the drag started (the marker must not jump). */
  grabDx: number;
  shift: boolean;
}

export class WaveformView {
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: WaveformViewOpts;

  private samples: Float32Array | null = null;
  private sampleRate = 0;
  private peaks: Peaks | null = null;
  private grid: WaveformGrid | null = null;
  private playheadSec: number | null = null;
  private view: Viewport = { startSec: 0, seconds: MIN_VIEW_SEC };

  private width = 0;
  private height = 0;
  private dpr = 1;
  private renderPending = 0;
  private drag: DragState | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: WaveformViewOpts) {
    this.canvas = canvas;
    this.opts = opts;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    this.resize();
  }

  // ---------------------------------------------------------------- public API

  /** Replaces the audio; precomputes the peaks and shows the whole file. */
  setAudio(samples: Float32Array, sampleRate: number): void {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.peaks = computePeaks(samples, sampleRate);
    this.view = clampViewport(0, this.peaks.durationSec, this.peaks.durationSec);
    this.playheadSec = null;
    this.requestRender();
  }

  setGrid(grid: WaveformGrid | null): void {
    this.grid = grid ? { ...grid } : null;
    this.requestRender();
  }

  /** Playhead position in audio seconds (null hides it). Scrolls the view to keep it visible. */
  setPlayhead(sec: number | null): void {
    if (sec === this.playheadSec) return;
    this.playheadSec = sec;
    if (sec !== null && this.peaks) {
      const { startSec, seconds } = this.view;
      if (sec < startSec || sec > startSec + seconds) this.view = clampViewport(sec - seconds * 0.1, seconds, this.durationSec());
    }
    this.requestRender();
  }

  setViewport(startSec: number, seconds: number): void {
    this.view = clampViewport(startSec, seconds, this.durationSec());
    this.requestRender();
  }

  getViewport(): Viewport {
    return { ...this.view };
  }

  /** factor > 1 zooms in. Defaults to zooming around the centre of the view. */
  zoomBy(factor: number, aroundSec?: number): void {
    const around = aroundSec ?? this.view.startSec + this.view.seconds / 2;
    this.view = zoomViewport(this.view, factor, around, this.durationSec());
    this.requestRender();
  }

  scrollBy(sec: number): void {
    this.setViewport(this.view.startSec + sec, this.view.seconds);
  }

  /** Matches the backing store to the CSS size × devicePixelRatio and redraws. No-op while hidden. */
  resize(): void {
    if (this.disposed) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    if (this.renderPending) {
      cancelAnimationFrame(this.renderPending);
      this.renderPending = 0;
    }
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = WAVEFORM_COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const waveH = Math.max(1, h - RULER_H);
    const mid = waveH / 2;
    ctx.fillStyle = WAVEFORM_COLORS.axis;
    ctx.fillRect(0, Math.round(mid), w, 1);

    if (!this.peaks || this.peaks.durationSec <= 0) {
      ctx.fillStyle = WAVEFORM_COLORS.empty;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Sin audio', w / 2, mid);
      return;
    }

    const pxPerSec = w / this.view.seconds;
    this.drawWave(ctx, w, mid, mid - 2, pxPerSec);
    this.drawGrid(ctx, waveH, pxPerSec);
    this.drawRuler(ctx, w, waveH, pxPerSec);
    this.drawOffsetMarker(ctx, waveH);
    this.drawPlayhead(ctx, waveH);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renderPending) {
      cancelAnimationFrame(this.renderPending);
      this.renderPending = 0;
    }
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('mousedown', this.onMouseDown);
    c.removeEventListener('contextmenu', this.onContextMenu);
    this.drag = null;
    this.samples = null;
    this.peaks = null;
  }

  // ---------------------------------------------------------------- drawing

  private drawWave(ctx: CanvasRenderingContext2D, w: number, mid: number, amp: number, pxPerSec: number): void {
    const peaks = this.peaks;
    if (!peaks) return;
    const samples = this.samples;
    const sr = this.sampleRate;
    const useSamples = samples !== null && sr > 0 && pxPerSec > peaks.bucketsPerSec * 2;
    const bps = peaks.bucketsPerSec;
    const buckets = peaks.min.length;
    ctx.fillStyle = WAVEFORM_COLORS.wave;
    for (let x = 0; x < w; x++) {
      const t0 = this.view.startSec + x / pxPerSec;
      const t1 = t0 + 1 / pxPerSec;
      if (t1 <= 0 || t0 >= peaks.durationSec) continue;
      let lo = Infinity;
      let hi = -Infinity;
      if (useSamples && samples) {
        const s0 = Math.max(0, Math.floor(t0 * sr));
        const s1 = Math.min(samples.length, Math.max(s0 + 1, Math.ceil(t1 * sr)));
        for (let i = s0; i < s1; i++) {
          const v = samples[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      } else {
        const b0 = Math.max(0, Math.floor(t0 * bps));
        const b1 = Math.min(buckets, Math.max(b0 + 1, Math.ceil(t1 * bps)));
        for (let b = b0; b < b1; b++) {
          const mn = peaks.min[b];
          const mx = peaks.max[b];
          if (mn < lo) lo = mn;
          if (mx > hi) hi = mx;
        }
      }
      if (lo === Infinity) continue;
      const yTop = mid - clamp(hi, -1, 1) * amp;
      const yBot = mid - clamp(lo, -1, 1) * amp;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, waveH: number, pxPerSec: number): void {
    const grid = this.grid;
    if (!grid || !(grid.bpm > 0) || !(grid.beatsPerBar > 0) || !(grid.totalBeats > 0)) return;
    const beatSec = 60 / grid.bpm;
    const pxPerBeat = beatSec * pxPerSec;
    const pxPerBar = pxPerBeat * grid.beatsPerBar;
    const drawBeats = pxPerBeat >= 6;
    const drawBars = pxPerBar >= 3;
    const drawLabels = pxPerBar >= 26;
    if (!drawBeats && !drawBars) return;
    const { startSec, seconds } = this.view;
    const kFirst = Math.max(0, Math.floor((startSec - grid.offsetSec) / beatSec));
    const kLast = Math.min(grid.totalBeats, Math.ceil((startSec + seconds - grid.offsetSec) / beatSec));
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let k = kFirst; k <= kLast; k++) {
      const isBar = k % grid.beatsPerBar === 0;
      if (isBar ? !drawBars : !drawBeats) continue;
      const x = Math.round(this.secToX(gridBeatSec(grid, k)));
      if (x < -1 || x > this.width + 1) continue;
      ctx.fillStyle = isBar ? WAVEFORM_COLORS.bar : WAVEFORM_COLORS.beat;
      ctx.fillRect(x, 0, 1, waveH);
      if (isBar && drawLabels && k < grid.totalBeats) {
        ctx.fillStyle = WAVEFORM_COLORS.barText;
        ctx.fillText(String(k / grid.beatsPerBar + 1), x + 3, 2);
      }
    }
  }

  private drawRuler(ctx: CanvasRenderingContext2D, w: number, waveH: number, pxPerSec: number): void {
    ctx.fillStyle = WAVEFORM_COLORS.ruler;
    ctx.fillRect(0, waveH, w, this.height - waveH);
    const step = rulerStepSec(pxPerSec);
    const { startSec, seconds } = this.view;
    const first = Math.ceil(startSec / step) * step;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let t = first; t <= startSec + seconds + 1e-9; t += step) {
      const x = Math.round(this.secToX(t));
      ctx.fillStyle = WAVEFORM_COLORS.rulerTick;
      ctx.fillRect(x, waveH, 1, 4);
      ctx.fillStyle = WAVEFORM_COLORS.rulerText;
      ctx.fillText(formatRulerSec(t, step), x + 3, waveH + 3);
    }
  }

  private drawOffsetMarker(ctx: CanvasRenderingContext2D, waveH: number): void {
    const grid = this.grid;
    if (!grid) return;
    const x = this.secToX(grid.offsetSec);
    if (x < -HANDLE_W || x > this.width + HANDLE_W) return;
    ctx.fillStyle = WAVEFORM_COLORS.offset;
    ctx.fillRect(Math.round(x) - 1, 0, 2, waveH);
    ctx.beginPath();
    ctx.moveTo(x - HANDLE_W / 2, 0);
    ctx.lineTo(x + HANDLE_W / 2, 0);
    ctx.lineTo(x + HANDLE_W / 2, HANDLE_H - 5);
    ctx.lineTo(x, HANDLE_H);
    ctx.lineTo(x - HANDLE_W / 2, HANDLE_H - 5);
    ctx.closePath();
    ctx.fill();
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, waveH: number): void {
    const sec = this.playheadSec;
    if (sec === null) return;
    const x = Math.round(this.secToX(sec));
    if (x < 0 || x > this.width) return;
    ctx.fillStyle = WAVEFORM_COLORS.playhead;
    ctx.fillRect(x, 0, 1, waveH);
  }

  // ---------------------------------------------------------------- geometry

  private durationSec(): number {
    return this.peaks ? this.peaks.durationSec : 0;
  }

  private pxPerSec(): number {
    return this.width > 0 ? this.width / this.view.seconds : 1;
  }

  private secToX(sec: number): number {
    return (sec - this.view.startSec) * this.pxPerSec();
  }

  private xToSec(x: number): number {
    return this.view.startSec + x / this.pxPerSec();
  }

  private localX(e: MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  private hitsOffset(x: number): boolean {
    return this.grid !== null && Math.abs(x - this.secToX(this.grid.offsetSec)) <= HANDLE_HIT_PX;
  }

  private applyOffset(sec: number): void {
    const duration = this.durationSec();
    const v = Math.round(clamp(sec, -duration, duration) * 1000) / 1000;
    if (this.grid) this.grid = { ...this.grid, offsetSec: v };
    this.requestRender();
    this.opts.onOffsetChange(v);
  }

  private requestRender(): void {
    if (this.renderPending || this.disposed) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.render();
      return;
    }
    this.renderPending = requestAnimationFrame(() => {
      this.renderPending = 0;
      this.render();
    });
  }

  // ---------------------------------------------------------------- pointer events

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.disposed || !this.peaks) return;
    const x = this.localX(e);
    let mode: DragMode;
    if (e.button === 1 || (e.button === 0 && e.altKey)) mode = 'pan';
    else if (e.button === 0 && !e.shiftKey && this.hitsOffset(x)) mode = 'offset';
    else if (e.button === 0) mode = 'click';
    else return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not supported */
    }
    const grabDx = mode === 'offset' && this.grid ? x - this.secToX(this.grid.offsetSec) : 0;
    this.drag = { mode, pointerId: e.pointerId, downX: x, viewStartAtDown: this.view.startSec, grabDx, shift: e.shiftKey };
    this.canvas.style.cursor = mode === 'pan' ? 'grabbing' : mode === 'offset' ? 'ew-resize' : 'crosshair';
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.disposed) return;
    const x = this.localX(e);
    const drag = this.drag;
    if (!drag) {
      this.canvas.style.cursor = this.hitsOffset(x) ? 'ew-resize' : e.altKey ? 'grab' : 'crosshair';
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    switch (drag.mode) {
      case 'pan':
        this.setViewport(drag.viewStartAtDown - (x - drag.downX) / this.pxPerSec(), this.view.seconds);
        break;
      case 'offset':
        this.applyOffset(this.xToSec(x - drag.grabDx));
        break;
      case 'click':
        if (Math.abs(x - drag.downX) > DRAG_THRESHOLD_PX) drag.mode = 'cancelled';
        break;
      default:
        break;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = 'crosshair';
    if (this.disposed) return;
    const x = this.localX(e);
    if (drag.mode === 'offset') {
      this.applyOffset(this.xToSec(x - drag.grabDx));
    } else if (drag.mode === 'click') {
      const sec = Math.round(clamp(this.xToSec(x), 0, this.durationSec()) * 1000) / 1000;
      if (drag.shift || e.shiftKey) this.applyOffset(sec);
      else this.opts.onSeek?.(sec);
    }
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.drag = null;
    this.canvas.style.cursor = 'crosshair';
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.disposed || !this.peaks) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.width : 1;
    const dy = e.deltaY * scale;
    const dx = e.deltaX * scale;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      this.scrollBy((e.shiftKey ? dy : dx) / this.pxPerSec());
      return;
    }
    this.zoomBy(Math.exp(-dy * WHEEL_ZOOM), this.xToSec(this.localX(e)));
  };

  /** Middle-button autoscroll would fight the pan drag. */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.drag) e.preventDefault();
  };
}
