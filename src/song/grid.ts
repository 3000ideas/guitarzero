/**
 * Chord-grid model: the song text seen as a list of bars with one cell per beat.
 *
 * The text stays the single source of truth. `parseGrid` reads it line by line into items
 * (headers, sections, bar lines, lyrics, comments, anything else verbatim) and `serializeGrid`
 * writes it back. Bar lines the grid understands become `bars` items whose cells are the
 * beats of each bar (`''` = the previous chord keeps ringing, the `.` of the text). A bar
 * line that is not edited keeps its original text (`orig`), so opening the grid never rewrites
 * the file. Bar lines the grid cannot represent exactly (invalid, fractional chord starts)
 * stay `raw` and are written back untouched.
 *
 * Bar semantics are NOT re-implemented: every bar is read with the real parser (`parseSong`)
 * under the `time:` / `strum:` in effect, so the grid can never disagree with practice mode.
 */
import { parseSong } from './parser';
import { parseChordSymbol } from '../music/notes';

/** Bars per text line when the grid starts a new line. */
export const GRID_BARS_PER_LINE = 4;
/** Cell content of a rest. */
export const REST_CELL = '-';
/** Cell content of "no chord". */
export const NC_CELL = 'N.C.';

export interface GridBar {
  /** One entry per beat: chord name, '-' (rest), 'N.C.', or '' (hold the previous chord). */
  cells: string[];
}

export type GridHeaderKey = 'title' | 'artist' | 'tempo' | 'time' | 'strum' | 'capo';

export type GridItem =
  | { kind: 'header'; key: GridHeaderKey; value: string; comment: string; orig: string | null }
  | { kind: 'section'; label: string; repeat: number; comment: string; orig: string | null }
  | {
      kind: 'bars';
      bars: GridBar[];
      /** `| x2` at the end of the line (1 = none). */
      repeat: number;
      comment: string;
      /** Beats per bar in effect for this line. */
      beats: number;
      /** Original line text while the line is untouched, else null (rewritten on save). */
      orig: string | null;
    }
  | { kind: 'lyric'; text: string; orig: string | null }
  | { kind: 'comment'; text: string }
  | { kind: 'blank' }
  /** A line the grid does not edit (invalid or unusual bar lines): written back as is. */
  | { kind: 'raw'; text: string };

export interface GridChart {
  items: GridItem[];
  /** Line ending of the source ('\n' unless it uses '\r\n'). */
  eol: string;
}

// ---------------------------------------------------------------- reading

const COMMENT_RE = /(^|\s)#.*$/;
const HEADER_RE = /^(title|artist|tempo|time|strum|capo)\s*:\s*(.*)$/i;
const SECTION_RE = /^\[([^\]]*)\]\s*(.*)$/;
const LINE_REPEAT_RE = /\s+[x×](\d+)$/i;
const SECTION_REPEAT_RE = /^[x×]\s*(\d+)$/i;
const NC_RE = /^n\.?c\.?$/i;

/** Free text for a header, label or lyric: a `#` after whitespace would start a comment, so it is dropped. */
export function cleanText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/(^|\s)#+/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Splits `line` into its code part and the trailing comment (including the `#`). */
function splitComment(line: string): { code: string; comment: string } {
  const m = COMMENT_RE.exec(line);
  if (!m) return { code: line, comment: '' };
  return { code: line.slice(0, m.index), comment: line.slice(m.index + m[1].length) };
}

/** Beats per bar of a `time:` value, or null when unsupported. */
function beatsOfTime(value: string): { beats: number; unit: number } | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!m) return null;
  const beats = parseInt(m[1], 10);
  const unit = parseInt(m[2], 10);
  const ok = (beats === 4 && unit === 4) || (beats === 3 && unit === 4) || (beats === 2 && unit === 4) || (beats === 6 && unit === 8);
  return ok ? { beats, unit } : null;
}

/**
 * The cells of one bar text under a time signature and strum pattern, or null when the bar is
 * invalid or does not fall on whole beats. Leading dots (`. . C G`) hold the previous bar's chord.
 */
export function parseBarCells(text: string, beats: number, unit = 4, strum = ''): string[] | null {
  const seg = text.trim();
  if (seg === '' || seg.includes('|')) return null;
  const dummy = ['C', ...Array.from({ length: Math.max(0, beats - 1) }, () => '.')].join(' ');
  const lines = ['tempo: 100', `time: ${beats}/${unit}`];
  if (strum !== '') lines.push(`strum: ${strum}`);
  const firstBarLine = lines.length + 1;
  lines.push(`${dummy} |`, `${seg} |`);
  const { song, errors } = parseSong(lines.join('\n'));
  if (errors.some((e) => e.severity === 'error' && e.line >= firstBarLine)) return null;
  if (song.bars.length !== 2) return null;
  const bar = song.bars[1];
  if (bar.beats !== beats) return null;
  const leading = /^(\.\s*)+/.exec(seg);
  const leadingDots = leading ? (leading[0].match(/\./g) ?? []).length : 0;
  const cells = Array.from({ length: beats }, () => '');
  let first = true;
  for (const c of bar.chords) {
    const at = c.startBeat - bar.startBeat;
    if (!Number.isInteger(at) || !Number.isInteger(c.beats) || at < 0 || at >= beats) return null;
    const holdsPrevious = first && leadingDots > 0;
    first = false;
    if (holdsPrevious) continue;
    cells[at] = c.chord.name;
  }
  return cells;
}

/** Reads the song text into a chart. Never throws. */
export function parseGrid(source: string): GridChart {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r\n|\r|\n/);
  const items: GridItem[] = [];
  let beats = 4;
  let unit = 4;
  let strum = '';
  let seenBars = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      items.push({ kind: 'blank' });
      continue;
    }
    if (trimmed.startsWith('>')) {
      items.push({ kind: 'lyric', text: trimmed.slice(1).trim(), orig: raw });
      continue;
    }
    if (trimmed.startsWith('#')) {
      items.push({ kind: 'comment', text: raw });
      continue;
    }
    const { code, comment } = splitComment(raw);
    const stripped = code.trim();
    const header = HEADER_RE.exec(stripped);
    if (header) {
      const key = header[1].toLowerCase() as GridHeaderKey;
      const value = header[2].trim();
      if (key === 'time') {
        const t = beatsOfTime(value);
        if (t) {
          beats = t.beats;
          unit = t.unit;
          strum = '';
        }
      } else if (key === 'strum') {
        strum = value.replace(/\s+/g, '');
      }
      items.push({ kind: 'header', key, value, comment, orig: raw });
      continue;
    }
    if (stripped.startsWith('[')) {
      const m = SECTION_RE.exec(stripped);
      const rest = m ? m[2].trim() : '';
      const rep = rest === '' ? 1 : (SECTION_REPEAT_RE.exec(rest) ?? [])[1];
      if (m && m[1].trim() !== '' && rep !== undefined) {
        items.push({ kind: 'section', label: m[1].trim().replace(/\s+/g, ' '), repeat: Number(rep), comment, orig: raw });
      } else {
        items.push({ kind: 'raw', text: raw });
      }
      continue;
    }
    const bars = parseBarLine(stripped, beats, unit, strum);
    // A hold at the very start of the song has nothing to hold: the parser rejects it, so it stays text.
    const startsWithHold = !seenBars && !!bars && bars.bars[0].cells[0] === '';
    if (bars && !startsWithHold) seenBars = true;
    if (bars && !startsWithHold) items.push({ kind: 'bars', bars: bars.bars, repeat: bars.repeat, comment, beats, orig: raw });
    else items.push({ kind: 'raw', text: raw });
  }
  return { items, eol };
}

function parseBarLine(text: string, beats: number, unit: number, strum: string): { bars: GridBar[]; repeat: number } | null {
  let body = text;
  let repeat = 1;
  const rm = LINE_REPEAT_RE.exec(text);
  if (rm) {
    repeat = parseInt(rm[1], 10);
    if (repeat < 1 || repeat > 32) return null;
    body = text.slice(0, rm.index);
  }
  if (!body.includes('|')) return null; // a line without bars: lyric typed without ">" and the like
  const segments = body.split('|').map((s) => s.trim()).filter((s) => s !== '');
  if (segments.length === 0) return null;
  const bars: GridBar[] = [];
  for (const seg of segments) {
    const cells = parseBarCells(seg, beats, unit, strum);
    if (!cells) return null;
    bars.push({ cells });
  }
  return { bars, repeat };
}

// ---------------------------------------------------------------- writing

/** The text of one bar: chords and `.` holds, e.g. "C . G .". */
export function barText(bar: GridBar): string {
  return bar.cells.map((c) => (c === '' ? '.' : c)).join(' ');
}

function withComment(code: string, comment: string): string {
  return comment === '' ? code : `${code}  ${comment}`;
}

/** One line of the song text for an item. */
export function itemLine(item: GridItem): string {
  switch (item.kind) {
    case 'blank':
      return '';
    case 'comment':
    case 'raw':
      return item.text;
    case 'lyric':
      return item.orig ?? `> ${item.text}`;
    case 'header':
      return item.orig ?? withComment(`${item.key}: ${item.value}`, item.comment);
    case 'section':
      return item.orig ?? withComment(`[${item.label}]${item.repeat > 1 ? ` x${item.repeat}` : ''}`, item.comment);
    case 'bars': {
      if (item.orig !== null) return item.orig;
      const code = `${item.bars.map(barText).join(' | ')} |${item.repeat > 1 ? ` x${item.repeat}` : ''}`;
      return withComment(code, item.comment);
    }
  }
}

/** The whole chart as song text. */
export function serializeGrid(chart: GridChart): string {
  return chart.items.map(itemLine).join(chart.eol);
}

// ---------------------------------------------------------------- queries

/** Beats per bar of the chart at its start (first `time:` header, default 4). */
export function chartBeatsPerBar(chart: GridChart): number {
  for (const it of chart.items) {
    if (it.kind === 'header' && it.key === 'time') return beatsOfTime(it.value)?.beats ?? 4;
    if (it.kind === 'bars') break;
  }
  return 4;
}

/** 1-based number of the first bar of every `bars` item, counting repeats like the parser. */
export function barNumbers(chart: GridChart): number[] {
  const out: number[] = [];
  let n = 1;
  for (const it of chart.items) {
    out.push(n);
    if (it.kind === 'bars') n += it.bars.length * it.repeat;
  }
  return out;
}

/** True when `name` can be written in a cell: a chord, a rest or N.C. */
export function isCellValue(name: string): boolean {
  const t = name.trim();
  if (t === '' || /[\s|*]/.test(t) || t.startsWith('#')) return false;
  if (t === REST_CELL || NC_RE.test(t)) return true;
  return parseChordSymbol(t) !== null;
}

/** The text a user typed as a cell value: trimmed, `nc` → "N.C."; null when not allowed. */
export function normalizeCellValue(input: string): string | null {
  const t = input.trim();
  if (t === '') return '';
  if (NC_RE.test(t)) return NC_CELL;
  return isCellValue(t) ? t : null;
}

// ---------------------------------------------------------------- editing (mutates the chart)

function touch(item: GridItem): void {
  if (item.kind === 'bars' || item.kind === 'header' || item.kind === 'section' || item.kind === 'lyric') item.orig = null;
}

export function emptyBar(beats: number, firstChord = ''): GridBar {
  const cells = Array.from({ length: Math.max(1, beats) }, () => '');
  cells[0] = firstChord;
  return { cells };
}

/** A new bar needs a chord of its own when no bar comes before it (a hold would have nothing to hold). */
function firstChordFor(chart: GridChart, itemIndex: number): string {
  for (let i = 0; i < itemIndex && i < chart.items.length; i++) if (chart.items[i].kind === 'bars') return '';
  return 'C';
}

export function barsItem(chart: GridChart, index: number): Extract<GridItem, { kind: 'bars' }> | null {
  const it = chart.items[index];
  return it && it.kind === 'bars' ? it : null;
}

/** Writes a chord / rest / N.C. (or '' to hold) into one cell. Returns false for an invalid value. */
export function setCell(chart: GridChart, itemIndex: number, barIndex: number, cell: number, value: string): boolean {
  const item = barsItem(chart, itemIndex);
  const bar = item?.bars[barIndex];
  if (!item || !bar || cell < 0 || cell >= bar.cells.length) return false;
  const v = normalizeCellValue(value);
  if (v === null) return false;
  if (bar.cells[cell] === v) return true;
  bar.cells[cell] = v;
  touch(item);
  return true;
}

/** Inserts an empty bar (all holds) after `barIndex` (-1 = at the start of the line). */
export function insertBar(chart: GridChart, itemIndex: number, barIndex: number): void {
  const item = barsItem(chart, itemIndex);
  if (!item) return;
  item.bars.splice(barIndex + 1, 0, emptyBar(item.beats, barIndex < 0 ? firstChordFor(chart, itemIndex) : ''));
  touch(item);
}

/** Duplicates a bar right after itself. */
export function duplicateBar(chart: GridChart, itemIndex: number, barIndex: number): void {
  const item = barsItem(chart, itemIndex);
  const bar = item?.bars[barIndex];
  if (!item || !bar) return;
  item.bars.splice(barIndex + 1, 0, { cells: [...bar.cells] });
  touch(item);
}

/** Removes a bar; a line left without bars disappears. Returns true when the whole line went. */
export function deleteBar(chart: GridChart, itemIndex: number, barIndex: number): boolean {
  const item = barsItem(chart, itemIndex);
  if (!item || !item.bars[barIndex]) return false;
  item.bars.splice(barIndex, 1);
  touch(item);
  if (item.bars.length > 0) return false;
  let count = 1;
  if (chart.items[itemIndex + 1]?.kind === 'lyric') count++;
  chart.items.splice(itemIndex, count);
  // A section left without bars would turn into a recall of an earlier section of the same name.
  const head = chart.items[itemIndex - 1];
  const after = chart.items[itemIndex];
  if (head && head.kind === 'section' && !(after && after.kind === 'bars')) chart.items.splice(itemIndex - 1, 1);
  return true;
}

/** Moves a bar one place left (-1) or right (+1) inside its line. */
export function moveBar(chart: GridChart, itemIndex: number, barIndex: number, delta: -1 | 1): number {
  const item = barsItem(chart, itemIndex);
  const to = barIndex + delta;
  if (!item || !item.bars[barIndex] || to < 0 || to >= item.bars.length) return barIndex;
  const [bar] = item.bars.splice(barIndex, 1);
  item.bars.splice(to, 0, bar);
  touch(item);
  return to;
}

/** Sets the `x<n>` of a bar line (1..32). */
export function setLineRepeat(chart: GridChart, itemIndex: number, repeat: number): void {
  const item = barsItem(chart, itemIndex);
  if (!item) return;
  item.repeat = Math.min(32, Math.max(1, Math.round(repeat)));
  touch(item);
}

/** Beats per bar in effect at `itemIndex` (the last `time:` header before it). */
export function beatsAt(chart: GridChart, itemIndex: number): number {
  let beats = 4;
  for (let i = 0; i < itemIndex && i < chart.items.length; i++) {
    const it = chart.items[i];
    if (it.kind === 'header' && it.key === 'time') beats = beatsOfTime(it.value)?.beats ?? beats;
  }
  return beats;
}

/**
 * Appends an empty bar at the end of the line `itemIndex`, or in a new line right after it when
 * the line already has GRID_BARS_PER_LINE bars. Returns the item index and bar index of the new bar.
 */
export function appendBar(chart: GridChart, itemIndex: number): { item: number; bar: number } | null {
  const item = barsItem(chart, itemIndex);
  if (!item) return null;
  if (item.bars.length < GRID_BARS_PER_LINE) {
    item.bars.push(emptyBar(item.beats));
    touch(item);
    return { item: itemIndex, bar: item.bars.length - 1 };
  }
  const next: GridItem = { kind: 'bars', bars: [emptyBar(item.beats)], repeat: 1, comment: '', beats: item.beats, orig: null };
  // The new line goes after the lyric that belongs to this one.
  const at = chart.items[itemIndex + 1]?.kind === 'lyric' ? itemIndex + 2 : itemIndex + 1;
  chart.items.splice(at, 0, next);
  return { item: at, bar: 0 };
}

/** True when the last thing in the chart is a section header without bars (a recall of an earlier section). */
export function endsWithRecall(chart: GridChart): boolean {
  for (let i = chart.items.length - 1; i >= 0; i--) {
    const k = chart.items[i].kind;
    if (k === 'blank' || k === 'comment') continue;
    return k === 'section';
  }
  return false;
}

/**
 * Splits a bar line around one bar so a header can apply to that bar only: `before` goes right
 * before the bar, `after` (when not null) right after it. Refuses a line that repeats (`x2`).
 */
function isolateBar(chart: GridChart, itemIndex: number, barIndex: number, before: GridItem, after: GridItem | null): boolean {
  const item = barsItem(chart, itemIndex);
  if (!item || item.repeat !== 1 || !item.bars[barIndex]) return false;
  const part = (bars: GridBar[], comment: string): GridItem => ({ kind: 'bars', bars, repeat: 1, comment, beats: item.beats, orig: null });
  const head = item.bars.slice(0, barIndex);
  const tail = item.bars.slice(barIndex + 1);
  const pieces: GridItem[] = [];
  if (head.length > 0) pieces.push(part(head, ''));
  pieces.push(before, part([item.bars[barIndex]], tail.length === 0 ? item.comment : ''));
  if (tail.length > 0) {
    if (after) pieces.push(after);
    pieces.push(part(tail, item.comment));
  } else if (after) {
    pieces.push(after);
  }
  chart.items.splice(itemIndex, 1, ...pieces);
  return true;
}

/**
 * Gives ONE bar its own tempo: `tempo: bpm` right before the bar and `tempo: restoreBpm` right
 * after it (null = nothing follows, no restore). Used when the audio's bar lasts longer or shorter
 * than the text says. Refuses a line that repeats (`x2`).
 */
export function retimeBar(chart: GridChart, itemIndex: number, barIndex: number, bpm: number, restoreBpm: number | null): boolean {
  if (!(bpm >= 20 && bpm <= 400)) return false;
  const header = (v: number): GridItem => ({ kind: 'header', key: 'tempo', value: String(Math.round(v * 100) / 100), comment: '', orig: null });
  return isolateBar(chart, itemIndex, barIndex, header(bpm), restoreBpm === null ? null : header(restoreBpm));
}

/** The strum pattern in effect at item `itemIndex` (the last `strum:` header before it), or null when none was written (the default applies). */
export function strumAt(chart: GridChart, itemIndex: number): string | null {
  let value: string | null = null;
  for (let i = 0; i < itemIndex && i < chart.items.length; i++) {
    const it = chart.items[i];
    if (it.kind === 'header' && it.key === 'strum') value = it.value.replace(/\s+/g, '');
    if (it.kind === 'header' && it.key === 'time') value = null; // a new meter resets the default
  }
  return value;
}

/**
 * Gives ONE bar its own strum pattern (`strum: pattern` before it, the previous pattern after it;
 * `restore` null = write no restore: the bar is the last of the song). Refuses a line that repeats.
 */
export function restrumBar(chart: GridChart, itemIndex: number, barIndex: number, pattern: string, restore: string | null): boolean {
  if (!/^[DUx-]+$/.test(pattern)) return false;
  const header = (v: string): GridItem => ({ kind: 'header', key: 'strum', value: v, comment: '', orig: null });
  return isolateBar(chart, itemIndex, barIndex, header(pattern), restore === null ? null : header(restore));
}

/**
 * Writes every repetition out: `x<n>` on a line becomes n lines, a section with `x<n>` or recalled by
 * its name (`[Estrofa]` with no bars) becomes its full block each time. The music does not change,
 * but every bar now has its own line, so each can take its own tempo («Seguir el audio»).
 * Returns false (chart untouched) when it cannot be done safely: lines the grid cannot read, a
 * recall of a section that was never defined, or `time:` / `strum:` changes in the middle of the
 * song (a copy would be read under different headers).
 */
export function expandRepeats(chart: GridChart): boolean {
  const items = chart.items;
  const firstContent = items.findIndex((it) => it.kind === 'section' || it.kind === 'bars' || it.kind === 'raw');
  if (firstContent < 0) return true;
  for (let i = firstContent; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'raw') return false;
    if (it.kind === 'header' && (it.key === 'time' || it.key === 'strum')) return false;
  }
  const clone = (it: GridItem): GridItem => {
    if (it.kind === 'bars') return { ...it, bars: it.bars.map((b) => ({ cells: [...b.cells] })), repeat: 1, orig: null };
    return { ...it } as GridItem;
  };
  /** A block of items with its `x<n>` lines written out. */
  const unrollLines = (block: readonly GridItem[]): GridItem[] => {
    const out: GridItem[] = [];
    for (const it of block) {
      if (it.kind === 'bars' && it.repeat > 1) {
        for (let r = 0; r < it.repeat; r++) out.push({ ...clone(it), orig: r === 0 ? null : null } as GridItem);
      } else out.push(clone(it));
    }
    return out;
  };
  const out: GridItem[] = items.slice(0, firstContent);
  const defs = new Map<string, GridItem[]>();
  let i = firstContent;
  while (i < items.length) {
    const it = items[i];
    if (it.kind !== 'section') {
      out.push(...unrollLines([it]));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < items.length && items[j].kind !== 'section') j++;
    const block = items.slice(i + 1, j);
    const key = it.label.toLowerCase();
    const defines = block.some((b) => b.kind === 'bars');
    let body: GridItem[];
    if (defines) {
      body = unrollLines(block);
      defs.set(key, body);
    } else {
      const def = defs.get(key);
      if (!def) return false;
      body = def;
    }
    for (let r = 0; r < it.repeat; r++) {
      out.push({ kind: 'section', label: it.label, repeat: 1, comment: r === 0 ? it.comment : '', orig: r === 0 && it.repeat === 1 ? it.orig : null });
      out.push(...body.map(clone));
      if (!defines && r === 0) {
        // Lines written under a recall (none, by construction) would have been the section's own: nothing to add.
      }
    }
    i = j;
  }
  chart.items = out;
  return true;
}

/** Tempo changes smaller than this (bpm) are not written between stretches: they would add noise, not accuracy. */
export const TEMPO_MAP_MIN_CHANGE = 0.15;

/**
 * Writes a tempo for every stretch of the song: the mid-song `tempo:` headers are replaced by one
 * header before each line (`entries[].item`) whose tempo differs from the one in effect, and the
 * leading `tempo:` takes the first stretch. `entries` are in text order. Returns the number of
 * headers written.
 */
export function applyTempoMap(chart: GridChart, entries: ReadonlyArray<{ item: number; bpm: number }>): number {
  if (entries.length === 0) return 0;
  const firstContent = chart.items.findIndex((it) => it.kind === 'section' || it.kind === 'bars' || it.kind === 'raw');
  const start = firstContent < 0 ? chart.items.length : firstContent;
  // Drop the mid-song tempo headers, remembering where every old item lands.
  const newIndex: number[] = [];
  const kept: GridItem[] = [];
  chart.items.forEach((it, i) => {
    const drop = i > start && it.kind === 'header' && it.key === 'tempo';
    newIndex[i] = kept.length;
    if (!drop) kept.push(it);
  });
  chart.items = kept;
  const fmt = (v: number): string => String(Math.round(v * 100) / 100);
  setHeader(chart, 'tempo', fmt(entries[0].bpm));
  // setHeader may have inserted a leading header: shift by the difference in the leading block.
  const shift = chart.items.findIndex((it) => it.kind === 'section' || it.kind === 'bars' || it.kind === 'raw') - newIndex[start];
  let last = entries[0].bpm;
  const inserts: Array<{ at: number; bpm: number }> = [];
  for (let n = 1; n < entries.length; n++) {
    const e = entries[n];
    if (Math.abs(e.bpm - last) < TEMPO_MAP_MIN_CHANGE) continue;
    inserts.push({ at: newIndex[e.item] + (Number.isFinite(shift) ? shift : 0), bpm: e.bpm });
    last = e.bpm;
  }
  for (let k = inserts.length - 1; k >= 0; k--) {
    chart.items.splice(inserts[k].at, 0, { kind: 'header', key: 'tempo', value: fmt(inserts[k].bpm), comment: '', orig: null });
  }
  return inserts.length + 1;
}

/** Index of the last bar line of the chart, or -1. */
export function lastBarsIndex(chart: GridChart): number {
  for (let i = chart.items.length - 1; i >= 0; i--) if (chart.items[i].kind === 'bars') return i;
  return -1;
}

/**
 * Adds a new line with one empty bar after item `afterIndex` (or at the end of the chart when
 * omitted). Returns its item index. The new line holds the previous chord until it is filled in.
 */
export function addBarLine(chart: GridChart, afterIndex?: number): number {
  if (afterIndex === undefined && endsWithRecall(chart)) return -1;
  const at = afterIndex === undefined ? chart.items.length : afterIndex + 1;
  const beats = beatsAt(chart, Math.min(at, chart.items.length));
  const item: GridItem = { kind: 'bars', bars: [emptyBar(beats, firstChordFor(chart, at))], repeat: 1, comment: '', beats, orig: null };
  // Trailing blank lines (a final newline) stay last.
  let pos = at;
  if (afterIndex === undefined) while (pos > 0 && chart.items[pos - 1].kind === 'blank') pos--;
  chart.items.splice(pos, 0, item);
  return pos;
}

/** Adds an empty section header (named `label`) followed by a bar line at the end of the chart. Returns the section's item index. */
export function addSection(chart: GridChart, label: string): number {
  label = cleanText(label.replace(/[\][]/g, '')) || 'Sección';
  let pos = chart.items.length;
  while (pos > 0 && chart.items[pos - 1].kind === 'blank') pos--;
  const beats = beatsAt(chart, pos);
  chart.items.splice(
    pos,
    0,
    { kind: 'section', label, repeat: 1, comment: '', orig: null },
    { kind: 'bars', bars: [emptyBar(beats, firstChordFor(chart, pos))], repeat: 1, comment: '', beats, orig: null },
  );
  return pos;
}

export function setSectionLabel(chart: GridChart, itemIndex: number, label: string): void {
  const it = chart.items[itemIndex];
  if (!it || it.kind !== 'section') return;
  const clean = cleanText(label.replace(/[\][]/g, ''));
  it.label = clean === '' ? it.label : clean;
  touch(it);
}

export function setSectionRepeat(chart: GridChart, itemIndex: number, repeat: number): void {
  const it = chart.items[itemIndex];
  if (!it || it.kind !== 'section') return;
  it.repeat = Math.min(32, Math.max(1, Math.round(repeat)));
  touch(it);
}

/** Sets the lyric text under a bar line (a `>` line directly after it); empty text removes it. Returns the lyric's item index or -1. */
export function setLyric(chart: GridChart, barsIndex: number, text: string): number {
  const next = chart.items[barsIndex + 1];
  const clean = cleanText(text);
  if (next && next.kind === 'lyric') {
    if (clean === '') {
      chart.items.splice(barsIndex + 1, 1);
      return -1;
    }
    next.text = clean;
    next.orig = null;
    return barsIndex + 1;
  }
  if (clean === '') return -1;
  chart.items.splice(barsIndex + 1, 0, { kind: 'lyric', text: clean, orig: null });
  return barsIndex + 1;
}

/** The lyric attached to a bar line (the `>` line right after it), or ''. */
export function lyricOf(chart: GridChart, barsIndex: number): string {
  const next = chart.items[barsIndex + 1];
  return next && next.kind === 'lyric' ? next.text : '';
}

/** Value of the first `key:` header of the chart, or ''. */
export function headerValue(chart: GridChart, key: GridHeaderKey): string {
  for (const it of chart.items) if (it.kind === 'header' && it.key === key) return it.value;
  return '';
}

/**
 * Sets the first `key:` header (inserted after the leading headers, or at the top, when missing).
 * Changing `time:` also rewrites every bar line before the next `time:` to the new number of
 * beats (cells are cut or padded with holds), so the grid always stays rectangular.
 */
export function setHeader(chart: GridChart, key: GridHeaderKey, value: string): void {
  const v = key === 'title' || key === 'artist' ? cleanText(value) : value.trim();
  const existing = chart.items.findIndex((it) => it.kind === 'header' && it.key === key);
  if (existing >= 0) {
    const it = chart.items[existing];
    if (v === '') {
      chart.items.splice(existing, 1); // an empty `key:` is invalid text: drop the header
    } else if (it.kind === 'header') {
      it.value = v;
      it.orig = null;
    }
  } else if (v !== '') {
    let at = 0;
    while (at < chart.items.length && chart.items[at].kind === 'header') at++;
    chart.items.splice(at, 0, { kind: 'header', key, value: v, comment: '', orig: null });
  }
  if (key === 'time') {
    const at = chart.items.findIndex((it) => it.kind === 'header' && it.key === 'time');
    relayoutBars(chart, at); // at = -1 (header removed): back to 4 beats from the top
  }
}

/** Re-fits the bars after a `time:` header at `from` to the beats in effect there. */
function relayoutBars(chart: GridChart, from: number): void {
  let beats = beatsAt(chart, from);
  const head = chart.items[from];
  if (head && head.kind === 'header' && head.key === 'time') beats = beatsOfTime(head.value)?.beats ?? beats;
  for (let i = from + 1; i < chart.items.length; i++) {
    const it = chart.items[i];
    if (it.kind === 'header' && it.key === 'time') break;
    if (it.kind !== 'bars') continue;
    it.beats = beats;
    for (const bar of it.bars) {
      if (bar.cells.length > beats) bar.cells.length = beats;
      while (bar.cells.length < beats) bar.cells.push('');
    }
    it.orig = null;
  }
}

/** Distinct chord names written in the cells, in order of first appearance (rests and N.C. excluded). */
export function chartChords(chart: GridChart): string[] {
  const out: string[] = [];
  for (const it of chart.items) {
    if (it.kind !== 'bars') continue;
    for (const bar of it.bars) {
      for (const c of bar.cells) if (c !== '' && c !== REST_CELL && !NC_RE.test(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/** 1-based text line of every item (items map to exactly one line each). */
export function lineOfItem(itemIndex: number): number {
  return itemIndex + 1;
}
