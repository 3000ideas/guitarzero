/**
 * Song text parser (SPEC.md section 2): text -> Song (bars, repeats, sections, lyrics,
 * strum events, tempo map). Only the syntax is validated here; unknown chords are fine.
 *
 * Recognition order per line: empty -> lyric (`>`) -> comment (`#` at line start or after
 * whitespace) -> header (`key: value`) -> section (`[Name]`, optional `x<n>`) -> bar line.
 *
 * Notes on the data produced:
 *  - `SongBar.chords[].startBeat` is ABSOLUTE (same base as `SongBar.startBeat`).
 *  - `song.title` / `song.artist` default to '' when the header is missing.
 *  - Errors: at most one per line (the first invalid token); bars with an error are dropped,
 *    the other bars of the same line are kept. Warnings never drop anything.
 */
import type {
  ChordSymbol,
  LyricLine,
  ParseError,
  ParseResult,
  Song,
  SongBar,
  StrumEvent,
  TempoSegment,
} from '../types';
import { parseChordSymbol } from '../music/notes';

export const DEFAULT_TEMPO = 80;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 400;
export const MAX_CAPO = 12;
/** Maximum `x<n>` repeat count for bar lines and sections. */
export const MAX_REPEAT = 32;

/** Supported time signatures as [beatsPerBar, beatUnit]. */
export const SUPPORTED_TIME_SIGNATURES: ReadonlyArray<readonly [number, number]> = [
  [4, 4],
  [3, 4],
  [2, 4],
  [6, 8],
];

/** Default strum pattern for a time signature: one down-strum on every beat. */
export function defaultStrum(beatsPerBar: number): string {
  return 'D-'.repeat(beatsPerBar);
}

/** A pattern must have beatsPerBar, 2·beatsPerBar or 4·beatsPerBar characters. */
export function isValidStrumLength(length: number, beatsPerBar: number): boolean {
  return length === beatsPerBar || length === 2 * beatsPerBar || length === 4 * beatsPerBar;
}

/** Chord identity used for chord-change detection: root, quality and bass (never the text). */
export function sameChord(a: ChordSymbol, b: ChordSymbol): boolean {
  return a.root === b.root && a.quality === b.quality && a.bass === b.bass;
}

/** The symbol stored in `SongBar.chords` for a rest (`-`). */
export function restChord(): ChordSymbol {
  return { name: '-', root: -1, quality: 'nc', bass: null };
}

function noChord(name: string): ChordSymbol {
  return { name, root: -1, quality: 'nc', bass: null };
}

// ---------------------------------------------------------------- internal model

/** A chord (or rest) held for `beats` inside a bar. `implicit` = bare chord, not yet sized. */
interface Group {
  chord: ChordSymbol;
  beats: number;
  rest: boolean;
  implicit: boolean;
}

/** A bar as defined in the text, with the header values in effect when it was defined. */
interface DefBar {
  section: string | null;
  beats: number;
  beatUnit: number;
  bpm: number;
  strum: string;
  charsPerBeat: number;
  groups: Group[];
}

interface SectionDef {
  label: string;
  bars: DefBar[];
  /** Lyric lines of the definition, as offsets from the section's first bar. */
  lyrics: Array<{ offset: number; text: string }>;
}

interface OpenSection {
  key: string;
  label: string;
  line: number;
  repeat: number;
  /** Index in `bars` where this section started. */
  startIndex: number;
  /** Index in `lyrics` where this section's lyric lines started. */
  lyricStart: number;
  /** True once a bar line (even an invalid one) appeared under this header. */
  sawBarLine: boolean;
}

const COMMENT_RE = /(^|\s)#.*$/;
const HEADER_RE = /^(title|artist|tempo|time|strum|capo)\s*:\s*(.*)$/i;
const SECTION_RE = /^\[([^\]]*)\]\s*(.*)$/;
const LINE_REPEAT_RE = /\s+[x×](\d+)$/i;
const ONLY_REPEAT_RE = /^[x×]\d+$/i;
const NC_RE = /^n\.?c\.?$/i;
const UNKNOWN_HEADER_RE = /^([A-Za-zÀ-ÿ][\wÀ-ÿ]*)\s*:/;

const LYRIC_HINT = '; si es letra, empieza la línea con ">"';

// ---------------------------------------------------------------- parser

class SongParser {
  private readonly errors: ParseError[] = [];
  private readonly errorLines = new Set<number>();
  private readonly bars: DefBar[] = [];
  private readonly lyrics: LyricLine[] = [];
  private readonly sections = new Map<string, SectionDef>();
  private current: OpenSection | null = null;

  private title = '';
  private artist = '';
  private tempo = DEFAULT_TEMPO;
  /** A `tempo:` header (valid or not) appeared before the first bar. */
  private tempoIndicated = false;
  private beatsPerBar = 4;
  private beatUnit = 4;
  private strum = defaultStrum(4);
  private strumExplicit = false;
  private capo = 0;
  /** Index of the first bar of the last bar line that produced bars (lyrics attach here). */
  private lastBarLineFirstIndex = 0;

  parse(source: string, id: string): ParseResult {
    const lines = source.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i];
      const ts = raw.trimStart();
      if (ts === '') continue;
      if (ts.startsWith('>')) {
        const text = ts.slice(1).replace(COMMENT_RE, '').trim();
        this.lyrics.push({ barIndex: this.lastBarLineFirstIndex, text });
        continue;
      }
      const stripped = raw.replace(COMMENT_RE, '').trim();
      if (stripped === '') continue;
      const header = HEADER_RE.exec(stripped);
      if (header) {
        this.handleHeader(header[1].toLowerCase(), header[2].trim(), lineNo);
        continue;
      }
      if (stripped.startsWith('[')) {
        this.handleSection(stripped, lineNo);
        continue;
      }
      const unknown = UNKNOWN_HEADER_RE.exec(stripped);
      if (unknown && !stripped.includes('|')) {
        this.error(
          lineNo,
          `cabecera desconocida "${unknown[1]}" (usa title, artist, tempo, time, strum o capo)${LYRIC_HINT}`,
        );
        continue;
      }
      this.parseBarLine(stripped, lineNo);
    }
    return this.build(source, id);
  }

  // ------------------------------------------------------------ diagnostics

  /** At most one error per line: later errors on the same line are dropped. */
  private error(line: number, message: string): void {
    if (this.errorLines.has(line)) return;
    this.errorLines.add(line);
    this.errors.push({ line, message, severity: 'error' });
  }

  private warn(line: number, message: string): void {
    this.errors.push({ line, message, severity: 'warning' });
  }

  // ------------------------------------------------------------ headers

  private handleHeader(key: string, value: string, line: number): void {
    switch (key) {
      case 'title':
        this.title = value;
        break;
      case 'artist':
        this.artist = value;
        break;
      case 'tempo':
        this.setTempo(value, line);
        break;
      case 'time':
        this.setTime(value, line);
        break;
      case 'strum':
        this.setStrum(value, line);
        break;
      case 'capo':
        this.setCapo(value, line);
        break;
    }
  }

  private setTempo(value: string, line: number): void {
    if (this.bars.length === 0) this.tempoIndicated = true;
    const m = /^(\d+(?:[.,]\d+)?)\s*(?:bpm)?$/i.exec(value);
    if (!m) {
      this.error(
        line,
        `tempo inválido: "${value}" (usa un número entre ${MIN_TEMPO} y ${MAX_TEMPO}); se mantiene ${this.tempo}`,
      );
      return;
    }
    const bpm = parseFloat(m[1].replace(',', '.'));
    if (bpm < MIN_TEMPO || bpm > MAX_TEMPO) {
      this.error(
        line,
        `tempo fuera de rango: ${m[1]} (debe estar entre ${MIN_TEMPO} y ${MAX_TEMPO}); se mantiene ${this.tempo}`,
      );
      return;
    }
    this.tempo = bpm;
  }

  private setTime(value: string, line: number): void {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(value);
    const sig = m
      ? SUPPORTED_TIME_SIGNATURES.find(([n, d]) => n === parseInt(m[1], 10) && d === parseInt(m[2], 10))
      : undefined;
    if (!sig) {
      this.error(line, `compás no soportado: "${value}" (usa 4/4, 3/4, 2/4 o 6/8)`);
      return;
    }
    this.beatsPerBar = sig[0];
    this.beatUnit = sig[1];
    if (!this.strumExplicit) {
      // The default pattern is defined by the time signature (one down-strum per beat), so it
      // always follows a `time:` change, silently — even when the old default happened to fit.
      this.strum = defaultStrum(this.beatsPerBar);
      return;
    }
    if (!isValidStrumLength(this.strum.length, this.beatsPerBar)) {
      const def = defaultStrum(this.beatsPerBar);
      this.warn(
        line,
        `el patrón de rasgueo "${this.strum}" no encaja en ${sig[0]}/${sig[1]}; se usa el patrón por defecto "${def}"`,
      );
      this.strum = def;
      this.strumExplicit = false;
    }
  }

  private setStrum(value: string, line: number): void {
    const compact = value.replace(/\s+/g, '');
    if (compact === '') {
      this.error(line, 'patrón de rasgueo vacío (usa D, U, x y -)');
      return;
    }
    if (!/^[DUX-]+$/i.test(compact)) {
      this.error(line, `patrón de rasgueo inválido: "${value}" (solo D, U, x y -)`);
      return;
    }
    const pattern = compact.replace(/d/g, 'D').replace(/u/g, 'U').replace(/X/g, 'x');
    const m = this.beatsPerBar;
    if (!isValidStrumLength(pattern.length, m)) {
      this.error(
        line,
        `patrón de ${pattern.length} caracteres; se esperaban ${m}, ${2 * m} o ${4 * m} para ${m}/${this.beatUnit}`,
      );
      return;
    }
    this.strum = pattern;
    this.strumExplicit = true;
  }

  private setCapo(value: string, line: number): void {
    if (!/^\d+$/.test(value) || parseInt(value, 10) > MAX_CAPO) {
      this.error(line, `cejilla inválida: "${value}" (entero entre 0 y ${MAX_CAPO})`);
      return;
    }
    this.capo = parseInt(value, 10);
  }

  // ------------------------------------------------------------ sections

  private handleSection(text: string, line: number): void {
    const m = SECTION_RE.exec(text);
    if (!m) {
      this.error(line, `cabecera de sección inválida: "${text}" (formato: [Nombre] o [Nombre] x2)`);
      return;
    }
    const label = m[1].trim().replace(/\s+/g, ' ');
    if (label === '') {
      this.error(line, 'nombre de sección vacío (formato: [Nombre])');
      return;
    }
    let repeat = 1;
    const rest = m[2].trim();
    if (rest !== '') {
      const r = /^[x×]\s*(\d+)$/i.exec(rest);
      if (!r) {
        this.error(line, `texto inesperado tras la sección [${label}]: "${rest}" (solo se admite x<n>)`);
      } else {
        repeat = parseInt(r[1], 10);
        if (repeat < 1 || repeat > MAX_REPEAT) {
          this.error(line, `repetición x${r[1]} fuera de rango (1..${MAX_REPEAT})`);
          repeat = 1;
        }
      }
    }
    this.closeSection();
    this.current = {
      key: label.toLowerCase(),
      label,
      line,
      repeat,
      startIndex: this.bars.length,
      lyricStart: this.lyrics.length,
      sawBarLine: false,
    };
  }

  /**
   * Called when the next section header (or the end of the text) is reached. A section with
   * bars defines/redefines its name (and is appended repeat-1 more times); a section without
   * any bar line recalls the last definition with that name, `repeat` times.
   */
  private closeSection(): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    const end = this.bars.length;
    if (end > s.startIndex) {
      const def: SectionDef = {
        label: s.label,
        bars: this.bars.slice(s.startIndex, end),
        lyrics: this.lyrics
          .filter((l) => l.barIndex >= s.startIndex && l.barIndex < end)
          .map((l) => ({ offset: l.barIndex - s.startIndex, text: l.text })),
      };
      this.sections.set(s.key, def);
      for (let r = 1; r < s.repeat; r++) this.insertSection(def);
      return;
    }
    if (s.sawBarLine) return; // every bar was invalid: already reported, nothing to recall
    const def = this.sections.get(s.key);
    if (!def) {
      this.error(s.line, `sección [${s.label}] vacía y no definida antes`);
      return;
    }
    // Lyric lines written under the recall attach to the first inserted bar, after the copies' own.
    const pending = this.lyrics.splice(s.lyricStart);
    const first = this.bars.length;
    for (let r = 0; r < s.repeat; r++) this.insertSection(def);
    for (const l of pending) this.lyrics.push({ barIndex: first, text: l.text });
  }

  /** Appends a copy of a section (bars keep their own strum/time/tempo; lyrics are re-based). */
  private insertSection(def: SectionDef): void {
    const base = this.bars.length;
    for (const b of def.bars) this.bars.push(b);
    for (const l of def.lyrics) this.lyrics.push({ barIndex: base + l.offset, text: l.text });
  }

  // ------------------------------------------------------------ bar lines

  private parseBarLine(text: string, line: number): void {
    if (this.current) this.current.sawBarLine = true;
    const hasPipe = text.includes('|');
    let body = text;
    let repeat = 1;
    const rm = LINE_REPEAT_RE.exec(text);
    if (rm) {
      repeat = parseInt(rm[1], 10);
      if (repeat < 1 || repeat > MAX_REPEAT) {
        this.error(line, `repetición x${rm[1]} fuera de rango (1..${MAX_REPEAT}); se descarta la línea`);
        return;
      }
      body = text.slice(0, rm.index);
    } else if (ONLY_REPEAT_RE.test(text)) {
      this.error(line, `"${text}" sin compases: la repetición x<n> va al final de una línea de compases`);
      return;
    }
    const segments = body
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (segments.length === 0) {
      if (repeat > 1) {
        this.error(line, `"x${repeat}" sin compases: la repetición x<n> va al final de una línea de compases`);
      }
      return;
    }
    const parsed: DefBar[] = [];
    let firstError: string | null = null;
    for (const seg of segments) {
      const prev = parsed.length > 0 ? parsed[parsed.length - 1] : this.bars[this.bars.length - 1] ?? null;
      const r = this.parseBar(seg, prev);
      if (typeof r === 'string') {
        if (firstError === null) firstError = r;
      } else {
        parsed.push(r);
      }
    }
    if (firstError !== null) this.error(line, hasPipe ? firstError : firstError + LYRIC_HINT);
    if (parsed.length === 0) return;
    const first = this.bars.length;
    for (let r = 0; r < repeat; r++) {
      for (const b of parsed) this.bars.push(b);
    }
    this.lastBarLineFirstIndex = first;
  }

  /** Parses one bar. Returns the bar, or the (Spanish) error message of its first invalid token. */
  private parseBar(text: string, prev: DefBar | null): DefBar | string {
    const tokens = text.split(/\s+/);
    const groups: Group[] = [];
    let i = 0;
    let leadingDots = 0;
    while (i < tokens.length && tokens[i] === '.') {
      leadingDots++;
      i++;
    }
    if (leadingDots > 0) {
      if (!prev) return 'el compás empieza con "." pero no hay un compás anterior que prolongar';
      const last = prev.groups[prev.groups.length - 1];
      groups.push({ chord: last.chord, beats: leadingDots, rest: last.rest, implicit: false });
    }
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === '.') {
        const g = groups[groups.length - 1];
        g.beats += 1;
        g.implicit = false;
        continue;
      }
      if (ONLY_REPEAT_RE.test(tok)) {
        return `símbolo inválido "${tok}": la repetición x<n> va al final de la línea`;
      }
      let base = tok;
      let beats = 1;
      let explicit = false;
      const star = tok.lastIndexOf('*');
      if (star >= 0) {
        base = tok.slice(0, star);
        const n = tok.slice(star + 1);
        if (base === '' || !/^\d+$/.test(n) || parseInt(n, 10) < 1) {
          return `duración inválida "${tok}": usa X*n con n entero ≥ 1`;
        }
        beats = parseInt(n, 10);
        explicit = true;
      }
      if (base === '-') {
        groups.push({ chord: restChord(), beats, rest: true, implicit: false });
        continue;
      }
      let chord: ChordSymbol;
      if (NC_RE.test(base)) {
        chord = noChord(base);
      } else {
        const sym = parseChordSymbol(base);
        if (!sym) return `símbolo de acorde inválido: "${tok}"`;
        chord = { name: base, root: sym.root, quality: sym.quality, bass: sym.bass };
      }
      groups.push({ chord, beats, rest: false, implicit: !explicit });
    }

    const beatsPerBar = this.beatsPerBar;
    const charsPerBeat = this.strum.length / beatsPerBar;
    let explicitSum = 0;
    const implicit: Group[] = [];
    for (const g of groups) {
      if (g.implicit) implicit.push(g);
      else explicitSum += g.beats;
    }
    const remaining = beatsPerBar - explicitSum;
    if (remaining < 0) return `compás sobrepasado: ${explicitSum} beats en un compás de ${beatsPerBar}`;
    if (implicit.length > 0) {
      if (remaining === 0) return `compás lleno, ${implicit[0].chord.name} no cabe`;
      const units = remaining * charsPerBeat;
      if (units % implicit.length !== 0) {
        return `no se pueden repartir ${remaining} beats entre ${implicit.length} acordes; usa "." o "*n"`;
      }
      const part = units / implicit.length / charsPerBeat;
      for (const g of implicit) {
        g.beats = part;
        g.implicit = false;
      }
    } else if (remaining > 0) {
      return `compás incompleto: ${explicitSum} de ${beatsPerBar} beats`;
    }
    return {
      section: this.current ? this.current.label : null,
      beats: beatsPerBar,
      beatUnit: this.beatUnit,
      bpm: this.tempo,
      strum: this.strum,
      charsPerBeat,
      groups,
    };
  }

  // ------------------------------------------------------------ assembly

  private build(source: string, id: string): ParseResult {
    this.closeSection();
    if (!this.tempoIndicated) this.warn(1, `tempo no indicado, se usa ${DEFAULT_TEMPO}`);

    const bars: SongBar[] = [];
    let cursor = 0;
    for (const b of this.bars) {
      const chords: SongBar['chords'] = [];
      let s = cursor;
      for (const g of b.groups) {
        chords.push({ chord: g.chord, startBeat: s, beats: g.beats });
        s += g.beats;
      }
      bars.push({ index: bars.length, startBeat: cursor, beats: b.beats, section: b.section, chords });
      cursor += b.beats;
    }

    const events = this.buildEvents(bars);

    const tempoSegments: TempoSegment[] = [];
    for (let i = 0; i < this.bars.length; i++) {
      const bpm = this.bars[i].bpm;
      if (tempoSegments.length === 0 || tempoSegments[tempoSegments.length - 1].bpm !== bpm) {
        tempoSegments.push({ fromBeat: bars[i].startBeat, bpm });
      }
    }
    if (tempoSegments.length === 0) tempoSegments.push({ fromBeat: 0, bpm: this.tempo });

    const chordNames: string[] = [];
    for (const bar of bars) {
      for (const c of bar.chords) {
        if (c.chord.quality !== 'nc' && !chordNames.includes(c.chord.name)) chordNames.push(c.chord.name);
      }
    }

    const first = this.bars[0];
    const timeSignature = first
      ? { beatsPerBar: first.beats, beatUnit: first.beatUnit }
      : { beatsPerBar: this.beatsPerBar, beatUnit: this.beatUnit };

    const lyricLines = this.lyrics.slice().sort((a, b) => a.barIndex - b.barIndex);
    this.errors.sort((a, b) => a.line - b.line);

    const song: Song = {
      id,
      title: this.title,
      artist: this.artist,
      tempo: tempoSegments[0].bpm,
      tempoSegments,
      timeSignature,
      capo: this.capo,
      bars,
      events,
      totalBeats: cursor,
      chordNames,
      lyricLines,
      source,
    };
    return { song, errors: this.errors };
  }

  /**
   * One StrumEvent per D/U/x character of the bar's pattern while a chord (or N.C.) is held;
   * an extra down-strum when a chord starts on a `-` of the pattern; nothing during rests.
   */
  private buildEvents(bars: SongBar[]): StrumEvent[] {
    const events: StrumEvent[] = [];
    let lastEventChord: ChordSymbol | null = null;
    let restSinceLastEvent = false;
    let prevGroupChord: ChordSymbol | null = null;

    for (let bi = 0; bi < this.bars.length; bi++) {
      const def = this.bars[bi];
      const bar = bars[bi];
      const cpb = def.charsPerBeat;
      let start = 0;
      for (const g of def.groups) {
        const end = start + g.beats;
        if (g.rest) {
          prevGroupChord = null;
          restSinceLastEvent = true;
          start = end;
          continue;
        }
        const kFrom = Math.round(start * cpb);
        const kTo = Math.min(Math.round(end * cpb), def.strum.length);
        for (let k = kFrom; k < kTo; k++) {
          const c = def.strum[k];
          const t = k / cpb;
          let direction: StrumEvent['direction'];
          let muted = false;
          if (c === 'D') {
            direction = 'down';
          } else if (c === 'U') {
            direction = 'up';
          } else if (c === 'x') {
            direction = 'down';
            muted = true;
          } else {
            // '-': only when a (different) chord starts exactly here, or it follows a rest / the song start.
            const changes = t === start && (prevGroupChord === null || !sameChord(prevGroupChord, g.chord));
            if (!changes) continue;
            direction = 'down';
          }
          const chordChange =
            lastEventChord === null || restSinceLastEvent || !sameChord(lastEventChord, g.chord);
          events.push({
            index: events.length,
            time: bar.startBeat + t,
            chord: g.chord,
            direction,
            muted,
            barIndex: bi,
            beatInBar: t,
            chordChange,
          });
          lastEventChord = g.chord;
          restSinceLastEvent = false;
        }
        prevGroupChord = g.chord;
        start = end;
      }
    }
    return events;
  }
}

/** Parses song text. Never throws; `song` always exists (see the file header for the rules). */
export function parseSong(source: string, opts?: { id?: string }): ParseResult {
  return new SongParser().parse(source, opts?.id ?? '');
}
