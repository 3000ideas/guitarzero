/**
 * Chord transcription -> song text (docs/SPEC.md section 2 grammar) and replacement of the chart
 * inside an existing song text. Pure functions, no DOM.
 */
import type { ChordTranscription, TranscribedBar } from '../types';

/** Header lines of an existing song that `replaceChart` keeps. */
const KEPT_HEADER_RE = /^\s*(title|artist|capo)\s*:/i;
/** Bars per generated line. */
const BARS_PER_LINE = 4;
/** Tempo range accepted by the parser (song/parser.ts). */
const MIN_TEMPO = 20;
const MAX_TEMPO = 400;

export interface ChartOpts {
  title: string;
  artist?: string;
  /** Strum pattern; defaults to D-DU-UDU in 4/4 and D-DUDU in 3/4 (one down-strum per beat otherwise). */
  strum?: string;
}

/** Default strum pattern of the generated chart for a number of beats per bar. */
export function defaultChartStrum(beatsPerBar: number): string {
  if (beatsPerBar === 4) return 'D-DU-UDU';
  if (beatsPerBar === 3) return 'D-DUDU';
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

/**
 * Song text for a transcription: `title`, `artist` (when given), `tempo` (rounded), `time`,
 * `strum`, a comment line with the key, then the bars four per line, e.g.
 * `C . . . | G . Am . | N.C. . . . | F#m . . D |`.
 */
export function chartFromTranscription(t: ChordTranscription, opts: ChartOpts): string {
  const beatsPerBar = Math.max(1, Math.round(t.beatsPerBar));
  const tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(t.bpm)));
  const lines: string[] = [];
  lines.push(`title: ${singleLine(opts.title)}`);
  const artist = opts.artist === undefined ? '' : singleLine(opts.artist);
  if (artist !== '') lines.push(`artist: ${artist}`);
  lines.push(`tempo: ${tempo}`);
  lines.push(`time: ${beatsPerBar}/4`);
  lines.push(`strum: ${opts.strum !== undefined && opts.strum.trim() !== '' ? opts.strum.trim() : defaultChartStrum(beatsPerBar)}`);
  lines.push(`# Acordes detectados automáticamente: revisa y corrige. Tonalidad: ${t.key.name}`);
  for (let i = 0; i < t.bars.length; i += BARS_PER_LINE) {
    const group = t.bars.slice(i, i + BARS_PER_LINE);
    lines.push(group.map((bar) => barText(bar, beatsPerBar)).join(' | ') + ' |');
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
