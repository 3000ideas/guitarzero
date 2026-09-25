/**
 * Chord transcription -> song text (docs/SPEC.md section 2 grammar) and replacement of the chart
 * inside an existing song text. Pure functions, no DOM.
 *
 * Besides the headers and the bars (4 per line) the chart carries the tempo map and the
 * structure of the transcription (SPEC section 15): a `tempo: <bpm>` line before a bar whose
 * tracked tempo differs from the tempo in force by TEMPO_CHANGE_FRACTION or more in a sustained
 * way (the median of the next two bars differs too), at most one every TEMPO_CHANGE_MIN_BARS
 * bars and never on the last bar; and a `[Etiqueta]` line at the start of every section, whose
 * bars then go 4 per line (a repeated section is written out every time: the parser redefines
 * it). The `strum:` header is global; with `opts.sectionStrums` (SPEC section 16) a section
 * whose pattern differs from the one in force gets its own `strum:` line after its label.
 */
import type { ChordTranscription, TranscribedBar, TranscribedSection } from '../types';

/** Header lines of an existing song that `replaceChart` keeps. */
const KEPT_HEADER_RE = /^\s*(title|artist|capo)\s*:/i;
/** Bars per generated line. */
const BARS_PER_LINE = 4;
/** Tempo range accepted by the parser (song/parser.ts). */
const MIN_TEMPO = 20;
const MAX_TEMPO = 400;
/** A bar tempo this far (relative) from the tempo in force starts a new tempo segment ... */
export const TEMPO_CHANGE_FRACTION = 0.015;
/** ... when the median of the next TEMPO_CHANGE_LOOKAHEAD_BARS bars differs too ... */
const TEMPO_CHANGE_LOOKAHEAD_BARS = 2;
/** ... and at most once every this many bars. */
const TEMPO_CHANGE_MIN_BARS = 2;

export interface ChartOpts {
  title: string;
  artist?: string;
  /**
   * Strum pattern of the `strum:` header; defaults to the first section pattern (see
   * `sectionStrums`) or, without one, to one down-strum per beat (D-D-D-D- in 4/4).
   */
  strum?: string;
  /**
   * Strum pattern per section, parallel to `t.sections` (SPEC section 16). Right after the
   * `[Etiqueta]` line of section i a `strum: <patrón>` line is written when `sectionStrums[i]`
   * differs from the pattern in force (the header, then the last written line); an undefined,
   * empty or unparsable entry keeps the pattern in force. Ignored without sections.
   */
  sectionStrums?: (string | undefined)[];
}

/** Characters of a strum pattern (song grammar, section 2). */
const STRUM_RE = /^[DUx-]+$/;

/**
 * A section pattern the parser accepts for `beatsPerBar` (trimmed, D/U/x/- only, one, two or
 * four characters per beat), or undefined: an invalid pattern would make the parser report an
 * error and keep the pattern in force anyway, so it is left out here without the error.
 */
function sectionPattern(value: string | undefined, beatsPerBar: number): string | undefined {
  if (value === undefined) return undefined;
  const p = value.trim();
  if (p === '' || !STRUM_RE.test(p)) return undefined;
  const charsPerBeat = p.length / beatsPerBar;
  return charsPerBeat === 1 || charsPerBeat === 2 || charsPerBeat === 4 ? p : undefined;
}

/** Default strum pattern of the generated chart: one down-strum per beat (the safest for a transcription; the editor offers presets). */
export function defaultChartStrum(beatsPerBar: number): string {
  return 'D-'.repeat(Math.max(1, beatsPerBar));
}

/** Header values are single-line: collapse any line break / run of whitespace. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Text of one bar: each chord followed by a '.' per additional beat, `N.C.` for null. */
function barText(bar: TranscribedBar, beatsPerBar: number): string {
  const chords = bar.chords.filter((c) => c.beats > 0);
  if (chords.length === 0) return 'N.C.' + ' .'.repeat(beatsPerBar - 1);
  let total = 0;
  for (const c of chords) total += c.beats;
  const parts = chords.map((c, i) => {
    let beats = Math.round(c.beats);
    // Pad a short bar with its last chord so the parser never sees an incomplete bar.
    if (i === chords.length - 1 && total < beatsPerBar) beats += beatsPerBar - total;
    return (c.chord ?? 'N.C.') + ' .'.repeat(Math.max(0, beats - 1));
  });
  return parts.join(' ');
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/** Tempo value as written in a `tempo:` line: clamped to the parser's range, at most one decimal. */
function tempoText(bpm: number): string {
  const v = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(bpm * 10) / 10));
  return String(v);
}

/**
 * Bars before which a `tempo:` line goes, with the bpm to write: the tracked bar tempo differs
 * from the tempo in force by TEMPO_CHANGE_FRACTION or more and so does the median of the next
 * TEMPO_CHANGE_LOOKAHEAD_BARS bars (a sustained change, not a glitch); the written value is the
 * median of the bar and those next bars. Never on the last bar, at most one every
 * TEMPO_CHANGE_MIN_BARS bars. A change on bar 0 is allowed: the parser then takes it as the
 * initial tempo (the header keeps the song's median tempo).
 */
export function tempoChanges(t: ChordTranscription, initialTempo: number): Map<number, string> {
  const out = new Map<number, string>();
  const bt = t.barTempos;
  if (!bt || bt.length < 2) return out;
  const n = Math.min(bt.length, t.bars.length);
  let current = initialTempo;
  let lastChange = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n - 1; i++) {
    const v = bt[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    if (i - lastChange < TEMPO_CHANGE_MIN_BARS) continue;
    if (Math.abs(v - current) < TEMPO_CHANGE_FRACTION * current) continue;
    const next: number[] = [];
    for (let j = i + 1; j <= i + TEMPO_CHANGE_LOOKAHEAD_BARS && j < n; j++) {
      if (Number.isFinite(bt[j]) && bt[j] > 0) next.push(bt[j]);
    }
    if (next.length === 0) continue;
    if (Math.abs(median(next) - current) < TEMPO_CHANGE_FRACTION * current) continue;
    const value = median([v, ...next]);
    out.set(i, tempoText(value));
    current = parseFloat(tempoText(value));
    lastChange = i;
  }
  return out;
}

/** Section label as written between brackets: one line, no brackets; null when nothing is left. */
function labelText(label: string): string | null {
  const s = singleLine(label.replace(/[[\]]/g, ' '));
  return s === '' ? null : s;
}

/** A run of bars written together: its bar range, the label line (if any) and the index of its section in `t.sections`. */
interface BarGroup {
  start: number;
  end: number;
  label: string | null;
  /** Index into the transcription's `sections`, or null for bars no section covers. */
  section: number | null;
}

/**
 * Contiguous bar groups with the label to write before each: the sections of the transcription
 * (sorted, clamped to the bars, gaps and overlaps resolved by the first section that covers a
 * bar), or a single unlabelled group when there are none.
 */
function barGroups(sections: TranscribedSection[] | undefined, bars: number): BarGroup[] {
  const groups: BarGroup[] = [];
  if (bars === 0) return groups;
  const sorted = (sections ?? [])
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => Number.isFinite(s.startBar) && Number.isFinite(s.endBar))
    .sort((a, b) => a.s.startBar - b.s.startBar);
  let current: { s: TranscribedSection; index: number } | null | undefined;
  for (let i = 0; i < bars; i++) {
    const found = sorted.find(({ s }) => i >= Math.floor(s.startBar) && i <= Math.floor(s.endBar)) ?? null;
    if (groups.length === 0 || found !== current) {
      groups.push({ start: i, end: i, label: found ? labelText(found.s.label) : null, section: found ? found.index : null });
      current = found;
    } else {
      groups[groups.length - 1].end = i;
    }
  }
  return groups;
}

/**
 * Song text for a transcription: `title`, `artist` (when given), `tempo` (rounded), `time`,
 * `strum`, a comment line with the key, then the bars four per line, e.g.
 * `C . . . | G . Am . | N.C. . . . | F#m . . D |`, with `tempo:` lines where the tracked tempo
 * changes (see tempoChanges), `[Etiqueta]` lines at the start of every section and, after a
 * label, a `strum:` line when that section's pattern (`opts.sectionStrums`) differs from the
 * pattern in force.
 */
export function chartFromTranscription(t: ChordTranscription, opts: ChartOpts): string {
  const beatsPerBar = Math.max(1, Math.round(t.beatsPerBar));
  const tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(t.bpm)));
  const groups = barGroups(t.sections, t.bars.length);
  /** Pattern of each group, from `sectionStrums` (chart order), or undefined. */
  const groupStrums = groups.map((g) => (g.section === null ? undefined : sectionPattern(opts.sectionStrums?.[g.section], beatsPerBar)));
  const explicitStrum = opts.strum !== undefined && opts.strum.trim() !== '' ? opts.strum.trim() : undefined;
  const headerStrum = explicitStrum ?? groupStrums.find((p) => p !== undefined) ?? defaultChartStrum(beatsPerBar);
  const lines: string[] = [];
  lines.push(`title: ${singleLine(opts.title)}`);
  const artist = opts.artist === undefined ? '' : singleLine(opts.artist);
  if (artist !== '') lines.push(`artist: ${artist}`);
  lines.push(`tempo: ${tempo}`);
  lines.push(`time: ${beatsPerBar}/4`);
  lines.push(`strum: ${headerStrum}`);
  lines.push(`# Acordes detectados automáticamente: revisa y corrige. Tonalidad: ${t.key.name}`);
  const changes = tempoChanges(t, tempo);
  let strumInForce = headerStrum;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.label !== null) lines.push(`[${group.label}]`);
    const sectionStrum = groupStrums[g];
    if (sectionStrum !== undefined && sectionStrum !== strumInForce) {
      lines.push(`strum: ${sectionStrum}`);
      strumInForce = sectionStrum;
    }
    let line: string[] = [];
    const flush = (): void => {
      if (line.length > 0) lines.push(line.join(' | ') + ' |');
      line = [];
    };
    for (let i = group.start; i <= group.end; i++) {
      const change = changes.get(i);
      if (change !== undefined) {
        flush();
        lines.push(`tempo: ${change}`);
      }
      line.push(barText(t.bars[i], beatsPerBar));
      // Lines break every BARS_PER_LINE bars of the group (phrase aligned, whatever the tempo lines).
      if ((i - group.start + 1) % BARS_PER_LINE === 0) flush();
    }
    flush();
  }
  return lines.join('\n') + '\n';
}

/**
 * Replaces everything in an existing song text by the new chart, keeping the original's
 * `title:`, `artist:` and `capo:` header lines when present (the chart's own title / artist are
 * used only when the original lacks them). The kept headers go first, then the chart.
 */
export function replaceChart(source: string, chart: string): string {
  const kept = new Map<string, string>();
  for (const line of source.split(/\r\n|\r|\n/)) {
    const m = KEPT_HEADER_RE.exec(line);
    // Last occurrence wins, like the parser.
    if (m) kept.set(m[1].toLowerCase(), line.trimEnd());
  }
  const chartHeaders = new Map<string, string>();
  const rest: string[] = [];
  for (const line of chart.split(/\r\n|\r|\n/)) {
    const m = KEPT_HEADER_RE.exec(line);
    if (m) {
      chartHeaders.set(m[1].toLowerCase(), line.trimEnd());
      continue;
    }
    rest.push(line);
  }
  const out: string[] = [];
  for (const key of ['title', 'artist', 'capo']) {
    const line = kept.get(key) ?? chartHeaders.get(key);
    if (line !== undefined) out.push(line);
  }
  out.push(...rest);
  return out.join('\n');
}
