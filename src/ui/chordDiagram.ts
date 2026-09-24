/**
 * drawChordDiagram — standard vertical chord box on a Canvas 2D context: 6th string on the
 * left, nut on top (or an "Nfr" label when baseFret > 1), X/O markers above the strings,
 * barre as a rounded bar, finger numbers inside the dots and the title above.
 * All coordinates are CSS px inside `box`; the context state is restored afterwards.
 * With baseFret > 1 the left padding widens to the measured label width so "6fr" is never
 * clipped, even in the 96 px "Siguiente" canvas of the practice screen.
 */
import type { ChordShape } from '../types';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

export interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramOpts {
  /** Defaults to shape.name. */
  title?: string;
  /** Default true. */
  showFingers?: boolean;
  /** Draw a big X over the diagram (percussive muted strum). */
  muted?: boolean;
}

export const DIAGRAM_COLORS = {
  line: '#94a3b8',
  nut: '#f8fafc',
  dot: '#22d3ee',
  dotText: '#0b1220',
  title: '#f1f5f9',
  marker: '#e2e8f0',
  missing: '#facc15',
  frame: '#475569',
  mutedX: '#f87171',
} as const;

const C = DIAGRAM_COLORS;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Number of fret rows to draw: at least 4, more when the shape spans further. */
export function diagramFretCount(shape: ChordShape): number {
  let maxFret = 0;
  for (const f of shape.frets) if (f > maxFret) maxFret = f;
  if (shape.barre && shape.barre.fret > maxFret) maxFret = shape.barre.fret;
  return Math.max(4, maxFret - shape.baseFret + 1);
}

/** Gap between the "Nfr" label and the nearest dot on the 6th string, CSS px. */
export const FRET_LABEL_GAP = 3;
/** Inset of the label from the left edge of the box, CSS px. */
export const FRET_LABEL_INSET = 2;

/** "3fr" — label shown left of the first row when the diagram does not start at the nut. */
export function fretLabelText(baseFret: number): string {
  return `${baseFret}fr`;
}

/**
 * Left padding that fits a fret label of `labelWidth` px: the default `padX`, or more when
 * the label + gap + a dot radius would not fit between the box edge and the 6th string.
 */
export function fretLabelPadding(padX: number, labelWidth: number, dotR: number): number {
  return Math.max(padX, FRET_LABEL_INSET + labelWidth + FRET_LABEL_GAP + dotR + 1);
}

/** Width of `text` at `font`; falls back to an estimate when measureText is unavailable / returns 0. */
function measureLabel(ctx: CanvasRenderingContext2D, font: string, text: string, px: number): number {
  ctx.font = font;
  let w = 0;
  try {
    w = ctx.measureText(text).width;
  } catch {
    w = 0;
  }
  if (!Number.isFinite(w) || w <= 0) w = text.length * px * 0.6;
  return w;
}

interface GridGeometry {
  gridLeft: number;
  gw: number;
  cellW: number;
  markerH: number;
  gridTop: number;
  cellH: number;
  dotR: number;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawBigX(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = C.mutedX;
  ctx.lineWidth = clamp(Math.min(w, h) * 0.08, 3, 8);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawMissing(ctx: CanvasRenderingContext2D, box: DiagramBox, title: string): void {
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, box.x + 1.5, box.y + 1.5, box.w - 3, box.h - 3, 8);
  ctx.stroke();
  ctx.setLineDash([]);
  const cx = box.x + box.w / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (title) {
    const titlePx = clamp(Math.min(box.h * 0.18, box.w * 0.2), 12, 28);
    ctx.font = `bold ${Math.round(titlePx)}px ${FONT_FAMILY}`;
    ctx.fillStyle = C.missing;
    ctx.fillText(title, cx, box.y + box.h * 0.4);
  }
  const notePx = clamp(Math.min(box.h * 0.09, box.w * 0.12), 10, 16);
  ctx.font = `${Math.round(notePx)}px ${FONT_FAMILY}`;
  ctx.fillStyle = C.missing;
  ctx.fillText('sin digitación', cx, box.y + box.h * 0.62);
}

export function drawChordDiagram(
  ctx: CanvasRenderingContext2D,
  shape: ChordShape | null,
  box: { x: number; y: number; w: number; h: number },
  opts?: { title?: string; showFingers?: boolean; muted?: boolean },
): void {
  const o = opts ?? {};
  const title = o.title ?? (shape ? shape.name : '');
  const showFingers = o.showFingers !== false;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';

  if (!shape) {
    drawMissing(ctx, box, title);
    if (o.muted) drawBigX(ctx, box.x + box.w * 0.2, box.y + box.h * 0.2, box.w * 0.6, box.h * 0.6);
    ctx.restore();
    return;
  }

  // Title.
  const cx = box.x + box.w / 2;
  let titleH = 0;
  if (title) {
    const titlePx = clamp(Math.min(box.h * 0.13, box.w * 0.2), 11, 26);
    ctx.font = `bold ${Math.round(titlePx)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.title;
    ctx.fillText(title, cx, box.y + titlePx * 0.2);
    titleH = titlePx * 1.45;
  }

  // Grid geometry. The padding is symmetric by default; when the diagram does not start at the
  // nut, ONLY the left padding grows so that the "Nfr" label (measured at its font) fits inside
  // the box next to the first row. Strings and dots follow the same rules in both cases.
  const padX = box.w * 0.15;
  const gridBottom = box.y + box.h - box.h * 0.06;
  const nFrets = diagramFretCount(shape);
  const geometry = (padLeft: number): GridGeometry => {
    const gridLeft = box.x + padLeft;
    const gw = box.w - padLeft - padX;
    const cellW = gw / 5;
    const markerH = clamp(cellW * 0.8, 8, 20);
    const gridTop = box.y + titleH + markerH + 5;
    const cellH = (gridBottom - gridTop) / nFrets;
    const dotR = Math.min(cellW, cellH) * 0.36;
    return { gridLeft, gw, cellW, markerH, gridTop, cellH, dotR };
  };
  let g = geometry(padX);
  let fretLabel: { text: string; font: string; width: number } | null = null;
  if (shape.baseFret > 1) {
    const px = clamp(g.cellH * 0.45, 9, 14);
    const font = `${Math.round(px)}px ${FONT_FAMILY}`;
    const text = fretLabelText(shape.baseFret);
    const width = measureLabel(ctx, font, text, px);
    fretLabel = { text, font, width };
    const padLeft = fretLabelPadding(padX, width, g.dotR);
    if (padLeft > padX) g = geometry(padLeft);
  }
  const { gridLeft, gw, cellW, markerH, gridTop, cellH, dotR } = g;
  if (cellH <= 1 || cellW <= 1) {
    ctx.restore();
    return;
  }
  const nutH = clamp(cellH * 0.12, 3, 6);
  const gridRight = gridLeft + gw;

  if (o.muted) ctx.globalAlpha = 0.35;

  // Frets (horizontal). The first line is the nut for open-position shapes.
  for (let k = 0; k <= nFrets; k++) {
    const y = gridTop + k * cellH;
    const isNut = k === 0 && shape.baseFret === 1;
    ctx.strokeStyle = isNut ? C.nut : C.line;
    ctx.lineWidth = isNut ? nutH : 1.5;
    ctx.lineCap = isNut ? 'square' : 'butt';
    ctx.beginPath();
    ctx.moveTo(gridLeft, y);
    ctx.lineTo(gridRight, y);
    ctx.stroke();
  }

  // Strings (vertical): index 0 = 6th string on the left, thicker.
  ctx.strokeStyle = C.line;
  ctx.lineCap = 'butt';
  for (let s = 0; s < 6; s++) {
    const x = gridLeft + s * cellW;
    ctx.lineWidth = 1.7 - s * 0.15;
    ctx.beginPath();
    ctx.moveTo(x, gridTop);
    ctx.lineTo(x, gridBottom);
    ctx.stroke();
  }

  // "3fr" label when the diagram does not start at the nut: right-aligned just left of the
  // 6th string's dot, never starting before box.x + FRET_LABEL_INSET (the padding made room).
  if (fretLabel) {
    ctx.font = fretLabel.font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.marker;
    const right = Math.max(gridLeft - dotR - FRET_LABEL_GAP, box.x + FRET_LABEL_INSET + fretLabel.width);
    ctx.fillText(fretLabel.text, right, gridTop + cellH / 2);
  }

  // X / O markers above the nut.
  const markerCy = gridTop - nutH / 2 - 4 - markerH / 2;
  ctx.strokeStyle = C.marker;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let s = 0; s < 6; s++) {
    const fret = shape.frets[s];
    const x = gridLeft + s * cellW;
    if (fret === -1) {
      const half = markerH * 0.32;
      ctx.beginPath();
      ctx.moveTo(x - half, markerCy - half);
      ctx.lineTo(x + half, markerCy + half);
      ctx.moveTo(x + half, markerCy - half);
      ctx.lineTo(x - half, markerCy + half);
      ctx.stroke();
    } else if (fret === 0) {
      ctx.beginPath();
      ctx.arc(x, markerCy, markerH * 0.3, 0, TAU);
      ctx.stroke();
    }
  }

  // Barre as a rounded bar.
  const fingerFont = `bold ${Math.round(dotR * 1.25)}px ${FONT_FAMILY}`;
  const barre = shape.barre;
  let barreFrom = -1;
  let barreTo = -1;
  if (barre) {
    barreFrom = clamp(Math.min(barre.fromString, barre.toString), 0, 5);
    barreTo = clamp(Math.max(barre.fromString, barre.toString), 0, 5);
    const row = barre.fret - shape.baseFret;
    if (row >= 0 && row < nFrets) {
      const cy = gridTop + (row + 0.5) * cellH;
      const xa = gridLeft + barreFrom * cellW;
      const xb = gridLeft + barreTo * cellW;
      ctx.fillStyle = C.dot;
      roundedRectPath(ctx, xa - dotR, cy - dotR * 0.85, xb - xa + 2 * dotR, dotR * 1.7, dotR * 0.85);
      ctx.fill();
      if (showFingers) {
        let finger = 0;
        for (let s = barreFrom; s <= barreTo; s++) {
          if (shape.frets[s] === barre.fret && shape.fingers[s] > 0) {
            finger = shape.fingers[s];
            break;
          }
        }
        if (finger === 0) finger = 1;
        ctx.font = fingerFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = C.dotText;
        ctx.fillText(String(finger), (xa + xb) / 2, cy + 0.5);
      }
    }
  }

  // Dots with finger numbers.
  for (let s = 0; s < 6; s++) {
    const fret = shape.frets[s];
    if (fret === undefined || fret <= 0) continue;
    if (barre && fret === barre.fret && s >= barreFrom && s <= barreTo) continue; // covered by the bar
    const row = fret - shape.baseFret;
    if (row < 0 || row >= nFrets) continue;
    const x = gridLeft + s * cellW;
    const cy = gridTop + (row + 0.5) * cellH;
    ctx.beginPath();
    ctx.arc(x, cy, dotR, 0, TAU);
    ctx.fillStyle = C.dot;
    ctx.fill();
    const finger = shape.fingers[s];
    if (showFingers && finger > 0) {
      ctx.font = fingerFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.dotText;
      ctx.fillText(String(finger), x, cy + 0.5);
    }
  }

  if (o.muted) {
    ctx.globalAlpha = 1;
    drawBigX(ctx, gridLeft, gridTop, gw, gridBottom - gridTop);
  }
  ctx.restore();
}
