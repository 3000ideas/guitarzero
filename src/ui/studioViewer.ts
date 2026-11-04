/**
 * Studio viewer: a few bars of the song as a scrolling strip, to SEE whether what sounds is what
 * is written. While playing, the strip scrolls under a fixed playhead; paused, it shows the
 * chosen bar. Layers (top to bottom): the waveform of the audio with the attacks it seems to have
 * (orange ▲) and the strikes the text asks for (dashed lines), the beat ruler with bar numbers,
 * the chords as wide boxes and the strum arrows.
 */
import type { Song } from '../types';
import { h } from './dom';
import { beatToSec, secToBeat } from '../song/tempo';
import { barCells, barStrums } from '../song/barCheck';
import { WAVEFORM_COLORS, STRUM_MARK_COLORS, computePeaks, type Peaks } from './waveform';

export interface StudioAudio {
  offsetSec: number;
  samples: Float32Array;
  sampleRate: number;
  /** Attack times of the whole audio (seconds), computed once by the host. */
  attacks: readonly number[];
  /** Where the song starts in the audio (0 = the beginning of the file). */
  startSec: number;
}

export interface StudioViewerOpts {
  /** Beat (absolute) being heard now, or null when nothing plays. */
  getPlayBeat: () => number | null;
  /** A bar of the strip was clicked (0-based expanded bar index). */
  onPickBar: (barIndex: number) => void;
  /**
   * Right click menu: `first` = «aquí empieza el compás 1», `this` = «el compás de debajo empieza aquí».
   * `audioSec` is the audio time clicked (snapped to a strike of the audio when one is close).
   */
  onSetBarStart: (kind: 'first' | 'this' | 'song' | 'clearSong', audioSec: number, barIndex: number) => void;
  /** Count-down digit (3, 2, 1) to show over the strip, or null. */
  getCountdown: () => number | null;
}

export interface StudioViewer {
  el: HTMLElement;
  setContext(song: Song, audio: StudioAudio | null): void;
  /** Bar shown while nothing plays. */
  setFocusBar(barIndex: number): void;
  /** Position (in beats, may be negative: before bar 1) shown while nothing plays. */
  setFocusBeat(beat: number): void;
  setPlaying(playing: boolean): void;
  redraw(): void;
  dispose(): void;
}

/** Bars of the strip. */
export const VIEW_BARS = 4;
/** Where the playhead sits while playing, as a fraction of the strip width. */
export const PLAYHEAD_AT = 0.22;
// Strip geometry (CSS px). A landscape phone has barely 300 px of height, so there the strip is compact.
let HEIGHT = 236;
let TOP = 18;
let WAVE_H = 96;
let RULER_Y = TOP + WAVE_H;
let CHORD_Y = RULER_Y + 20;
let CHORD_H = 40;
let ARROW_Y = CHORD_Y + CHORD_H + 4;

function applyLayout(): void {
  const compact = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
  TOP = compact ? 14 : 18;
  WAVE_H = compact ? 40 : 96;
  RULER_Y = TOP + WAVE_H;
  CHORD_Y = RULER_Y + (compact ? 16 : 20);
  CHORD_H = compact ? 30 : 40;
  ARROW_Y = CHORD_Y + CHORD_H + 4;
  HEIGHT = compact ? ARROW_Y + 24 : 236;
}

export function createStudioViewer(opts: StudioViewerOpts): StudioViewer {
  let song: Song | null = null;
  let audio: StudioAudio | null = null;
  let focusBeat = 0;
  let playing = false;
  let raf = 0;
  let disposed = false;
  let lastClickMap: Array<{ x0: number; x1: number; bar: number }> = [];
  /** Peaks of the whole audio, computed once per track: the strip only reads them, so scrolling never shimmers. */
  let peaksCache: { samples: Float32Array; peaks: Peaks } | null = null;
  let lastView = { w0: 0, span: 1, W: 1 };

  const canvas = h('canvas', { class: 'studio-canvas', 'aria-label': 'Onda de los compases con los acordes y los golpes' }) as HTMLCanvasElement;
  const menu = h('div.studio-menu', { role: 'menu' });
  menu.hidden = true;
  const el = h('div.studio-viewer', null, canvas, menu);
  function closeMenu(): void {
    menu.hidden = true;
  }
  document.addEventListener('pointerdown', (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (!song || !audio) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const beat = lastView.w0 + (x / lastView.W) * lastView.span;
    const songSec = beatToSec(song.tempoSegments, Math.max(0, beat));
    let audioSec = audio.offsetSec + songSec;
    // Snap to the nearest strike of the audio when one is within ~0.1 s (the user points at a strum).
    let best = 0.1;
    for (const a of audio.attacks) {
      const d = Math.abs(a - audioSec);
      if (d < best) {
        best = d;
        audioSec = a;
      }
    }
    const barIndex = barAt(Math.max(0, beat));
    const entries: Array<HTMLElement | null> = [
      h('div.studio-menu-title', null, `Aquí: ${audioSec.toFixed(2)} s`),
      h('button.studio-menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); opts.onSetBarStart('song', audioSec, barIndex); } }, 'Aquí empieza la canción (lo de antes no suena)'),
      h('button.studio-menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); opts.onSetBarStart('first', audioSec, barIndex); } }, 'Aquí empieza el compás 1'),
      beat >= 0 ? h('button.studio-menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); opts.onSetBarStart('this', audioSec, barIndex); } }, `Aquí empieza el compás ${barIndex + 1} (ajusta toda la cuadrícula)`) : null,
    ];
    menu.replaceChildren(...entries.filter((x): x is HTMLElement => x !== null));
    if (audio.startSec > 0) {
      menu.appendChild(h('button.studio-menu-item', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); opts.onSetBarStart('clearSong', audioSec, barIndex); } }, 'Que suene desde el principio del audio'));
    }
    menu.style.left = `${Math.min(x, Math.max(0, lastView.W - 300))}px`;
    menu.style.top = `${Math.max(8, ev.clientY - rect.top - 8)}px`;
    menu.hidden = false;
  });

  /** Index of the last bar that starts at or before `beat`. */
  function barAt(beat: number): number {
    if (!song || song.bars.length === 0) return 0;
    let lo = 0;
    let hi = song.bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (song.bars[mid].startBeat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function draw(): void {
    if (disposed || !song || song.bars.length === 0) return;
    applyLayout();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = Math.max(320, Math.floor(el.clientWidth || 640));
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${HEIGHT}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const beatsPerBar = song.bars[0].beats;
    const span = beatsPerBar * VIEW_BARS;
    const playBeat = opts.getPlayBeat();
    const cur = playBeat !== null ? playBeat : focusBeat;
    // Playing: the strip scrolls under a fixed playhead. Paused: the chosen bar starts near the left edge.
    const w0 = playBeat !== null ? cur - PLAYHEAD_AT * span : cur - 0.12 * span;
    const w1 = w0 + span;
    const xOf = (beat: number): number => ((beat - w0) / span) * W;
    lastView = { w0, span, W };

    ctx.fillStyle = WAVEFORM_COLORS.bg;
    ctx.fillRect(0, 0, W, HEIGHT);

    // Bars as clear blocks: every other bar a little lighter, the one being heard lighter still.
    const curBar = barAt(Math.max(0, cur));
    const first = Math.max(0, barAt(w0) - 0);
    lastClickMap = [];
    for (let i = first; i < song.bars.length; i++) {
      const b = song.bars[i];
      if (b.startBeat >= w1) break;
      const x0 = xOf(b.startBeat);
      const x1 = xOf(b.startBeat + b.beats);
      lastClickMap.push({ x0, x1, bar: i });
      ctx.fillStyle = i === curBar ? 'rgba(255,255,255,0.10)' : i % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0)';
      ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
    }

    // Waveform.
    const midY = TOP + WAVE_H / 2;
    if (audio) {
      if (!peaksCache || peaksCache.samples !== audio.samples) peaksCache = { samples: audio.samples, peaks: computePeaks(audio.samples, audio.sampleRate, 1000) };
      const pk = peaksCache.peaks;
      const linear = song.tempoSegments.length === 1;
      const tStart = audio.offsetSec + beatToSec(song.tempoSegments, w0);
      const tEnd = audio.offsetSec + beatToSec(song.tempoSegments, w1);
      const segs = song.tempoSegments;
      const off = audio.offsetSec;
      const timeAt = (x: number): number => (linear ? tStart + ((tEnd - tStart) * x) / W : off + beatToSec(segs, w0 + (span * x) / W));
      const lo = new Float32Array(W);
      const hi = new Float32Array(W);
      let top = 0;
      for (let x = 0; x < W; x++) {
        const b0 = Math.floor(timeAt(x) * pk.bucketsPerSec);
        const b1 = Math.max(b0 + 1, Math.ceil(timeAt(x + 1) * pk.bucketsPerSec));
        let mn = 0;
        let mx = 0;
        for (let b = Math.max(0, b0); b < b1 && b < pk.max.length; b++) {
          if (pk.min[b] < mn) mn = pk.min[b];
          if (pk.max[b] > mx) mx = pk.max[b];
        }
        lo[x] = mn;
        hi[x] = mx;
        top = Math.max(top, mx, -mn);
      }
      // One fixed scale for the whole track (not per window), so the picture does not breathe while it moves.
      let peak = 0;
      for (let b = 0; b < pk.max.length; b += 7) peak = Math.max(peak, pk.max[b], -pk.min[b]);
      const gain = peak > 0.001 ? 1 / peak : top > 0.001 ? 1 / top : 1;
      ctx.fillStyle = WAVEFORM_COLORS.wave;
      for (let x = 0; x < W; x++) {
        const y1 = midY - hi[x] * gain * (WAVE_H / 2 - 2);
        const y2 = midY - lo[x] * gain * (WAVE_H / 2 - 2);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } else {
      ctx.fillStyle = WAVEFORM_COLORS.empty;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Carga un audio en «Pista de audio» para ver su onda aquí', W / 2, midY + 4);
    }
    ctx.strokeStyle = WAVEFORM_COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(W, midY + 0.5);
    ctx.stroke();

    // Beat lines, bar lines and numbers.
    ctx.textAlign = 'center';
    for (let k = Math.ceil(w0); k <= w1; k++) {
      const bi = barAt(k);
      const bar = song.bars[bi];
      const isBarStart = bar && Math.abs(bar.startBeat - k) < 1e-9;
      const x = Math.round(xOf(k)) + 0.5;
      ctx.strokeStyle = isBarStart ? WAVEFORM_COLORS.bar : WAVEFORM_COLORS.beat;
      ctx.lineWidth = isBarStart ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, TOP);
      ctx.lineTo(x, HEIGHT - 4);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (bar && k >= 0 && k < song.totalBeats) {
        const n = k - bar.startBeat + 1;
        ctx.fillStyle = WAVEFORM_COLORS.barText;
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(String(n), xOf(k + 0.5), RULER_Y + 14);
        if (isBarStart) {
          ctx.textAlign = 'left';
          ctx.font = 'bold 12px system-ui, sans-serif';
          ctx.fillStyle = '#e6edf7';
          ctx.fillText(`${bi + 1}${bar.section ? ` · ${bar.section}` : ''}`, x + 4, 13);
          ctx.textAlign = 'center';
        }
      }
    }

    // Chords: ONE box per bar (so a bar never looks cut), the chords written inside it with a divider where one changes.
    ctx.textBaseline = 'middle';
    for (let i = first; i < song.bars.length; i++) {
      const b = song.bars[i];
      if (b.startBeat >= w1) break;
      const x0 = xOf(b.startBeat) + 3;
      const x1 = xOf(b.startBeat + b.beats) - 3;
      const cells = barCells(song, i);
      ctx.fillStyle = i === curBar ? 'rgba(34,211,238,0.20)' : 'rgba(34,211,238,0.10)';
      ctx.strokeStyle = i === curBar ? 'rgba(34,211,238,0.95)' : 'rgba(34,211,238,0.5)';
      ctx.lineWidth = i === curBar ? 2 : 1.5;
      ctx.beginPath();
      ctx.roundRect(x0, CHORD_Y, x1 - x0, CHORD_H, 8);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      const starts = cells.map((c, idx) => (c.chord !== null ? idx : -1)).filter((idx) => idx >= 0);
      if (starts.length === 0) {
        ctx.fillStyle = WAVEFORM_COLORS.empty;
        ctx.font = '16px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('·', (x0 + x1) / 2, CHORD_Y + CHORD_H / 2);
        continue;
      }
      // A bar that holds the previous chord at its start leaves that part of the box empty.
      starts.forEach((idx, n) => {
        const to = n + 1 < starts.length ? starts[n + 1] : cells.length;
        const sx0 = n === 0 ? (idx > 0 ? xOf(b.startBeat + idx) : x0) : xOf(b.startBeat + idx);
        const sx1 = n + 1 < starts.length ? xOf(b.startBeat + to) : x1;
        const cell = cells[idx];
        if (n > 0 || idx > 0) {
          ctx.strokeStyle = 'rgba(34,211,238,0.6)';
          ctx.beginPath();
          ctx.moveTo(Math.round(sx0) + 0.5, CHORD_Y + 7);
          ctx.lineTo(Math.round(sx0) + 0.5, CHORD_Y + CHORD_H - 7);
          ctx.stroke();
        }
        ctx.fillStyle = cell.rest ? WAVEFORM_COLORS.empty : '#e6edf7';
        ctx.font = cell.rest ? '16px system-ui, sans-serif' : 'bold 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(cell.rest ? '–' : cell.chord ?? '', (sx0 + sx1) / 2, CHORD_Y + CHORD_H / 2);
      });
    }
    ctx.textBaseline = 'alphabetic';

    // Strikes the text asks for.
    for (let i = first; i < song.bars.length; i++) {
      const b = song.bars[i];
      if (b.startBeat >= w1) break;
      for (const s of barStrums(song, i)) {
        const x = Math.round(xOf(s.beat)) + 0.5;
        if (x < -4 || x > W + 4) continue;
        const color = STRUM_MARK_COLORS[s.kind === 'down' ? 'down' : s.kind === 'up' ? 'up' : 'muted'];
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, RULER_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillText(s.kind === 'down' ? '↓' : s.kind === 'up' ? '↑' : '✕', x, ARROW_Y + 20);
      }
    }

    // What the audio seems to do.
    if (audio) {
      ctx.fillStyle = '#fb923c';
      for (const sec of audio.attacks) {
        const beat = secToBeat(song.tempoSegments, sec - audio.offsetSec);
        if (beat < w0 || beat > w1) continue;
        const x = xOf(beat);
        ctx.beginPath();
        ctx.moveTo(x, TOP + 1);
        ctx.lineTo(x - 5, TOP + 11);
        ctx.lineTo(x + 5, TOP + 11);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Where the song starts: the audio before it is skipped when playing (dimmed), with a marker.
    if (audio && audio.startSec > 0) {
      const sb = secToBeat(song.tempoSegments, audio.startSec - audio.offsetSec);
      const sx = xOf(sb);
      if (sx > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.fillRect(0, 0, Math.min(W, sx), HEIGHT);
      }
      if (sx > -2 && sx < W + 2) {
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, HEIGHT);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#4ade80';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('▶ empieza la canción', Math.round(sx) + 5, HEIGHT - 6);
      }
    }

    // Count-down over the strip.
    const countdown = opts.getCountdown();
    if (countdown !== null) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, HEIGHT);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(countdown), W * 0.5, HEIGHT * 0.5);
      ctx.textBaseline = 'alphabetic';
    }

    // Playhead (while paused it marks the start of the chosen bar).
    const px = Math.round(xOf(cur)) + 0.5;
    ctx.strokeStyle = playBeat !== null ? WAVEFORM_COLORS.playhead : WAVEFORM_COLORS.offset;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, HEIGHT);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function loop(): void {
    raf = 0;
    if (disposed) return;
    draw();
    if (playing) raf = requestAnimationFrame(loop);
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const hit = lastClickMap.find((m) => x >= m.x0 && x < m.x1);
    if (hit) opts.onPickBar(hit.bar);
  });

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  observer?.observe(el);

  return {
    el,
    setContext(nextSong, nextAudio) {
      song = nextSong;
      audio = nextAudio;
      draw();
    },
    setFocusBar(i) {
      const b = song ? song.bars[Math.max(0, Math.min(song.bars.length - 1, Math.round(i)))] : null;
      focusBeat = b ? b.startBeat : 0;
      if (!playing) draw();
    },
    setFocusBeat(beat) {
      focusBeat = beat;
      if (!playing) draw();
    },
    setPlaying(p) {
      playing = p;
      if (p && !raf) raf = requestAnimationFrame(loop);
      if (!p) draw();
    },
    redraw: draw,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    },
  };
}
