/**
 * The graphical part of «Analizar un tramo»: the waveform of the recording with the stretch drawn as a band.
 * Drag over the wave to mark a stretch, drag the edges of the band to adjust it; both ends snap to the nearest
 * strike. The analysed bar lines are drawn on top once there is a result. Zoom is automatic: it frames the
 * stretch (or the whole track on request).
 */
import { energyAttacks } from '../song/barCheck';
import { WAVEFORM_COLORS } from './waveform';
import { h } from './dom';

export interface SpanPicker {
  el: HTMLElement;
  /** Gives the picker the decoded track. */
  setAudio(samples: Float32Array, sampleRate: number): void;
  /** Draws the stretch (audio seconds) and frames it. */
  setSelection(fromSec: number, toSec: number): void;
  getSelection(): { fromSec: number; toSec: number } | null;
  /** Bar lines (audio seconds) of the analysis, or an empty list. */
  setBars(starts: readonly number[]): void;
  /** The playing position (audio seconds), or null. */
  setPlayhead(sec: number | null): void;
  /** Shows the whole track (true) or frames the stretch (false). */
  showAll(all: boolean): void;
  redraw(): void;
  dispose(): void;
}

export interface SpanPickerOpts {
  /** The stretch changed (the user released the mouse / finger). */
  onChange(fromSec: number, toSec: number): void;
}

const MIN_SPAN_SEC = 2;
const SNAP_SEC = 0.35;
const HANDLE_PX = 14;

export function createSpanPicker(opts: SpanPickerOpts): SpanPicker {
  const canvas = h('canvas.span-canvas', { 'aria-label': 'Onda de la canción: arrastra para marcar el tramo' }) as HTMLCanvasElement;
  const hint = h('div.span-hint.muted.small', null, 'Arrastra sobre la onda para marcar el tramo; arrastra los bordes para ajustarlo.');
  const allBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => api.showAll(!viewAll) }, 'Ver toda la canción') as HTMLButtonElement;
  const el = h('div.span-picker', null, canvas, h('div.span-picker-bar', null, hint, allBtn));

  let samples: Float32Array | null = null;
  let sampleRate = 44100;
  let attacks: number[] = [];
  let sel: { fromSec: number; toSec: number } | null = null;
  let bars: readonly number[] = [];
  let viewAll = false;
  let playhead: number | null = null;
  let view = { t0: 0, t1: 1 };
  let drag: { kind: 'new' | 'from' | 'to'; anchorSec: number } | null = null;
  let disposed = false;

  const total = (): number => (samples ? samples.length / sampleRate : 1);

  function frame(): void {
    const dur = total();
    if (drag) {
      // While dragging the view stays where it was: the band follows the finger.
    } else if (viewAll || !sel) {
      view = { t0: 0, t1: dur };
    } else {
      const pad = Math.max(0.5, (sel.toSec - sel.fromSec) * 0.12);
      view = { t0: Math.max(0, sel.fromSec - pad), t1: Math.min(dur, sel.toSec + pad) };
    }
    allBtn.textContent = viewAll ? 'Acercar al tramo' : 'Ver toda la canción';
    allBtn.disabled = !sel;
  }

  const xOf = (t: number, w: number): number => ((t - view.t0) / (view.t1 - view.t0)) * w;
  const tOf = (x: number, w: number): number => view.t0 + (x / w) * (view.t1 - view.t0);

  function snap(t: number): number {
    let best = t;
    let bestD = SNAP_SEC;
    for (const a of attacks) {
      const d = Math.abs(a - t);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  function draw(): void {
    if (disposed) return;
    const w = Math.max(200, Math.floor(el.clientWidth || 600));
    const compact = window.matchMedia?.('(orientation: landscape) and (max-height: 520px)').matches ?? false;
    const hgt = compact ? 110 : 150;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = WAVEFORM_COLORS.bg;
    ctx.fillRect(0, 0, w, hgt);
    if (!samples) {
      ctx.fillStyle = WAVEFORM_COLORS.empty;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Carga el audio de la canción para marcar un tramo', w / 2, hgt / 2);
      return;
    }
    frame();
    const axisH = 16;
    const waveH = hgt - axisH;
    const mid = waveH / 2;
    // The wave: per pixel column, the min/max of a bounded sample of its samples.
    ctx.fillStyle = WAVEFORM_COLORS.wave;
    const perPx = ((view.t1 - view.t0) * sampleRate) / w;
    const step = Math.max(1, Math.floor(perPx / 64));
    for (let x = 0; x < w; x++) {
      const a = Math.floor((view.t0 * sampleRate) + x * perPx);
      const b = Math.min(samples.length, Math.floor(a + perPx));
      let lo = 0;
      let hi = 0;
      for (let i = Math.max(0, a); i < b; i += step) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const y1 = mid - hi * (mid - 3);
      const y2 = mid - lo * (mid - 3);
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    // Time axis.
    ctx.fillStyle = WAVEFORM_COLORS.ruler;
    ctx.fillRect(0, waveH, w, axisH);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = WAVEFORM_COLORS.rulerText;
    const span = view.t1 - view.t0;
    const tickStep = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => span / s <= w / 70) ?? 120;
    for (let t = Math.ceil(view.t0 / tickStep) * tickStep; t < view.t1; t += tickStep) {
      const x = xOf(t, w);
      ctx.fillStyle = WAVEFORM_COLORS.rulerTick;
      ctx.fillRect(Math.round(x), waveH, 1, 4);
      ctx.fillStyle = WAVEFORM_COLORS.rulerText;
      const m = Math.floor(t / 60);
      ctx.fillText(`${m}:${String(Math.floor(t % 60)).padStart(2, '0')}${tickStep < 1 ? `.${Math.round((t % 1) * 10)}` : ''}`, x + 3, waveH + 12);
    }
    // Strikes (what the ends snap to).
    ctx.fillStyle = '#f59e0b';
    for (const a of attacks) {
      if (a < view.t0 || a > view.t1) continue;
      const x = xOf(a, w);
      ctx.beginPath();
      ctx.moveTo(x - 3, 1);
      ctx.lineTo(x + 3, 1);
      ctx.lineTo(x, 8);
      ctx.closePath();
      ctx.fill();
    }
    // The stretch.
    if (sel) {
      const x0 = xOf(sel.fromSec, w);
      const x1 = xOf(sel.toSec, w);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.16)';
      ctx.fillRect(x0, 0, x1 - x0, waveH);
      ctx.fillStyle = WAVEFORM_COLORS.offset;
      for (const x of [x0, x1]) {
        ctx.fillRect(Math.round(x) - 1, 0, 3, waveH);
        ctx.fillRect(Math.round(x) - 5, waveH / 2 - 14, 11, 28); // grip
      }
      ctx.fillStyle = '#04210f';
      for (const x of [x0, x1]) {
        ctx.fillRect(Math.round(x) - 1, waveH / 2 - 8, 1, 16);
        ctx.fillRect(Math.round(x) + 1, waveH / 2 - 8, 1, 16);
      }
    }
    if (playhead !== null && playhead >= view.t0 && playhead <= view.t1) {
      const x = xOf(playhead, w);
      ctx.fillStyle = WAVEFORM_COLORS.playhead;
      ctx.fillRect(Math.round(x) - 1, 0, 2, waveH);
    }
    // The bars of the analysis.
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px system-ui, sans-serif';
    bars.forEach((t, i) => {
      if (t < view.t0 || t > view.t1) return;
      const x = xOf(t, w);
      ctx.fillStyle = WAVEFORM_COLORS.bar;
      ctx.fillRect(Math.round(x), 10, 1, waveH - 10);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(String(i + 1), x + 3, 22);
    });
  }

  const widthPx = (): number => Math.max(200, Math.floor(el.clientWidth || 600));
  const pointerT = (ev: PointerEvent): number => {
    const r = canvas.getBoundingClientRect();
    return tOf(Math.max(0, Math.min(r.width, ev.clientX - r.left)), r.width || widthPx());
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!samples) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    canvas.setPointerCapture?.(ev.pointerId);
    if (sel) {
      const w = r.width || widthPx();
      if (Math.abs(x - xOf(sel.fromSec, w)) <= HANDLE_PX) {
        drag = { kind: 'from', anchorSec: sel.toSec };
        return;
      }
      if (Math.abs(x - xOf(sel.toSec, w)) <= HANDLE_PX) {
        drag = { kind: 'to', anchorSec: sel.fromSec };
        return;
      }
    }
    const t = pointerT(ev);
    drag = { kind: 'new', anchorSec: t };
    sel = { fromSec: t, toSec: t };
    bars = [];
    draw();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag || !sel) return;
    const t = pointerT(ev);
    if (drag.kind === 'new') sel = { fromSec: Math.min(drag.anchorSec, t), toSec: Math.max(drag.anchorSec, t) };
    else if (drag.kind === 'from') sel = { fromSec: Math.min(t, drag.anchorSec - 0.05), toSec: drag.anchorSec };
    else sel = { fromSec: drag.anchorSec, toSec: Math.max(t, drag.anchorSec + 0.05) };
    draw();
  });

  const finish = (): void => {
    if (!drag || !sel) {
      drag = null;
      return;
    }
    drag = null;
    viewAll = false; // after marking on the whole track, zoom in to refine
    let from = snap(sel.fromSec);
    let to = snap(sel.toSec);
    if (to - from < MIN_SPAN_SEC) {
      // A click or a tiny drag: keep the previous idea of the stretch rather than an empty band.
      to = Math.min(total(), from + MIN_SPAN_SEC);
      if (to - from < MIN_SPAN_SEC) from = Math.max(0, to - MIN_SPAN_SEC);
    }
    sel = { fromSec: from, toSec: to };
    bars = [];
    draw();
    opts.onChange(from, to);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const api: SpanPicker = {
    el,
    setAudio(s, sr) {
      samples = s;
      sampleRate = sr;
      attacks = energyAttacks(s, sr, 0, s.length / sr);
      sel = null;
      bars = [];
      viewAll = false;
      draw();
    },
    setSelection(fromSec, toSec) {
      sel = { fromSec, toSec };
      bars = [];
      draw();
    },
    getSelection() {
      return sel ? { ...sel } : null;
    },
    setBars(starts) {
      bars = starts;
      draw();
    },
    setPlayhead(sec) {
      playhead = sec;
      draw();
    },
    showAll(all) {
      viewAll = all;
      draw();
    },
    redraw: draw,
    dispose() {
      disposed = true;
    },
  };
  return api;
}
