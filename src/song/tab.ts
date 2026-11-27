/**
 * Guitar tablature (the plain-text kind: six lines of dashes and fret numbers) read into notes with a position in
 * time, so a screen can walk along it. Pure and testable in Node.
 *
 * A tab line is `|---14--12---|` (an optional string name before the first bar). Six consecutive lines make one
 * block (a «frase»); the top line is the thinnest string. The column of a number is its place in time: the
 * distance between two numbers is the distance between the two notes. Numbers glued together without dashes
 * (`171916171916`) are split into two-digit frets.
 */

export interface TabNote {
  /** Character column inside the block where the number starts. */
  col: number;
  /** 0 = top line (thinnest string) .. 5 = bottom line (thickest). */
  row: number;
  fret: number;
  /** A slide («/») leaves this note towards the next one. */
  slide: boolean;
  /** A vibrato («~») follows the note. */
  vib: boolean;
}

export interface TabBlock {
  /** Width of the block in character columns. */
  cols: number;
  notes: TabNote[];
  /** The raw six lines, bars removed (what the user wrote). */
  rows: string[];
}

export interface TabEvent {
  block: number;
  /** Column of the notes that sound together. */
  col: number;
  notes: TabNote[];
  /** Seconds from the start at 100 % speed. */
  atSec: number;
  durSec: number;
}

export interface ParsedTab {
  blocks: TabBlock[];
  events: TabEvent[];
  /** Start / end second of every block. */
  blockStartSec: number[];
  blockEndSec: number[];
  totalSec: number;
}

/** Seconds one character column lasts at 100 % speed (a gap of four dashes is a fifth of a second). */
export const TAB_COL_SEC = 0.05;
export const TAB_STRING_NAMES = ['e', 'B', 'G', 'D', 'A', 'E'] as const;

const TAB_LINE = /^\s*(?:[A-Ga-g][#b]?)?\|[-0-9/\\~^hpbrx().|*\s]+\|\s*$/;
const MAX_FRET = 24;

/** Splits a run of digits into frets: «12» is one fret, a long run is read in pairs («171916» → 17 19 16). */
export function splitFrets(digits: string): string[] {
  if (digits.length <= 2) return [digits];
  const out: string[] = [];
  let i = 0;
  while (i < digits.length) {
    const two = digits.slice(i, i + 2);
    const n = Number(two);
    if (two.length === 2 && n >= 10 && n <= MAX_FRET) {
      out.push(two);
      i += 2;
    } else {
      out.push(digits[i]);
      i += 1;
    }
  }
  return out;
}

function parseRow(inner: string, row: number): TabNote[] {
  const notes: TabNote[] = [];
  const re = /\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    let col = m.index;
    for (const part of splitFrets(m[0])) {
      const fret = Number(part);
      const after = inner[col + part.length] ?? '';
      notes.push({ col, row, fret, slide: after === '/' || after === '\\', vib: after === '~' });
      col += part.length;
    }
  }
  return notes;
}

function innerOf(line: string): string {
  const t = line.trim();
  const first = t.indexOf('|');
  const last = t.lastIndexOf('|');
  return t.slice(first + 1, last > first ? last : t.length);
}

/** Reads the tablature text. Lines that are not tab lines (blank lines, notes, «^^» marks, code fences) are ignored. */
export function parseTab(text: string): ParsedTab {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (TAB_LINE.test(raw)) current.push(innerOf(raw));
    else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const blocks: TabBlock[] = [];
  for (const g of groups) {
    for (let at = 0; at + 6 <= g.length; at += 6) {
      const rows = g.slice(at, at + 6);
      const notes = rows.flatMap((r, i) => parseRow(r, i));
      blocks.push({ cols: Math.max(...rows.map((r) => r.length)), notes, rows });
    }
  }

  const events: TabEvent[] = [];
  const blockStartSec: number[] = [];
  const blockEndSec: number[] = [];
  let base = 0;
  blocks.forEach((b, bi) => {
    const cols = [...new Set(b.notes.map((n) => n.col))].sort((x, y) => x - y);
    cols.forEach((col, k) => {
      const next = k + 1 < cols.length ? cols[k + 1] : b.cols;
      events.push({ block: bi, col, notes: b.notes.filter((n) => n.col === col), atSec: base + col * TAB_COL_SEC, durSec: Math.max(1, next - col) * TAB_COL_SEC });
    });
    blockStartSec.push(base);
    base += Math.max(1, b.cols) * TAB_COL_SEC;
    blockEndSec.push(base);
  });
  return { blocks, events, blockStartSec, blockEndSec, totalSec: base };
}

/** Index of the event that sounds at `sec` (the last one that has started), or -1 before the first. */
export function eventAt(tab: ParsedTab, sec: number): number {
  let lo = 0;
  let hi = tab.events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tab.events[mid].atSec <= sec + 1e-9) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
