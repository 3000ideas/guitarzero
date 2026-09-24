/**
 * Chord simplification (SPEC.md section 13): difficulty levels, quality reduction, capo
 * suggestion, "nearest easy chord" substitution, "keep the N most frequent chords" and the
 * token-level rewriting of a song text that preserves its structure (headers, sections,
 * comments, lyrics, `x<n>` repeats, `*n` durations, `.`, `-` and `N.C.`).
 * Pure functions, no DOM, no dependencies (testable in Node).
 */
import type { ChordQuality, ChordSymbol } from '../types';
import { CHORD_LIBRARY, getChordShape } from './chords';
import {
  NOTE_NAMES_FLAT,
  NOTE_NAMES_SHARP,
  QUALITY_SUFFIX,
  chordPitchClasses,
  chordSymbolName,
  normalizeSymbolText,
  parseChordSymbol,
  pitchClassOf,
  qualityThird,
  rootNameOf,
} from './notes';
import { parseSong } from '../song/parser';

// ---------------------------------------------------------------- types

export type DifficultyLevel = 1 | 2 | 3;
export type DifficultyLabel = 'fácil' | 'medio' | 'difícil';

export interface ChordDifficulty {
  level: DifficultyLevel;
  label: DifficultyLabel;
  /** Spanish explanation ("cejilla", "acorde de séptima", "sin digitación conocida"...). */
  reason: string;
}

/** A chord name with the number of beats it is held for (aggregated over a song). */
export interface WeightedChord {
  name: string;
  beats: number;
}

export type KeyMode = 'major' | 'minor';

export interface KeyEstimate {
  root: number;
  mode: KeyMode;
  /** Spanish name, e.g. "Do mayor", "La menor", "Sib mayor". */
  name: string;
}

export type KeyHint = { root: number; mode: KeyMode } | null;

export interface NearestChordOpts {
  key: KeyHint;
  /** Include the level-2 open chords (A7, E7, Cmaj7, Asus2...) as candidates. Ignored when `candidates` is given. */
  allowSevenths: boolean;
  /** Explicit candidate names (their order breaks ties). Default: level 1 of EASY_CHORDS, plus level 2 with allowSevenths. */
  candidates?: string[];
  /** Minimum number of shared pitch classes required (default 2, never below 1). */
  minShared?: number;
}

export interface NearestChord {
  /** Candidate name exactly as listed in the candidates. */
  name: string;
  /** Number of pitch classes shared with the original chord. */
  shared: number;
  /** Weighted similarity (see nearestEasyChord). */
  score: number;
}

export interface CapoSuggestion {
  /** Proposed capo fret (total, i.e. what the `capo:` header should say). */
  capo: number;
  /** Sum of beats × difficulty level of the chords as played with this capo. */
  difficulty: number;
  /** The chord names as they would be written with this capo, one per input entry. */
  names: string[];
}

export interface SimplifyOptions {
  /** Reduce sevenths, extensions, sus/aug/5 to plain major/minor and drop slash basses. */
  removeExtensions: boolean;
  /** Replace level-3 chords (barre / unknown) by the nearest easy chord. */
  substituteHard: boolean;
  /** Keep only the N most frequent chords (null = no limit). */
  maxChords: number | null;
  /** Propose a capo when it lowers the total difficulty by at least 15 %. */
  suggestCapo: boolean;
  /** Allow the level-2 open chords (A7, E7, Cmaj7...) as substitutes. */
  allowSevenths: boolean;
}

export interface SimplifySubstitution {
  /** Chord name as written in the original text. */
  from: string;
  /** Chord name in the simplified text. */
  to: string;
  /** Beats of the song (after expanding repeats) held on `from`. */
  beats: number;
  /** Spanish explanation of every step that changed the chord, joined with "; ". */
  reason: string;
}

export interface SimplifyResult {
  /** Rewritten song text. */
  source: string;
  /** Capo of the result (total fret; equals the song's capo when none is proposed). */
  capo: number;
  /** One entry per written chord name whose text changed (including capo transpositions). */
  substitutions: SimplifySubstitution[];
  /** Distinct chord names of the original song (order of first appearance). */
  chordsBefore: string[];
  /** Distinct chord names of the result (order of first appearance). */
  chordsAfter: string[];
  /**
   * beats whose chord did not change / beats with a chord. A capo transposition is NOT a
   * change (the song sounds the same); dropping a seventh or a bass, substituting or merging
   * a chord is.
   */
  unchangedBeatsRatio: number;
}

// ---------------------------------------------------------------- constants

/** Level 1: the basic open chords. */
export const EASY_CHORDS_LEVEL1: readonly string[] = ['C', 'D', 'E', 'G', 'A', 'Am', 'Em', 'Dm'];

/** Level 2: open chords with an extension (sevenths, sus, add9). */
export const EASY_CHORDS_LEVEL2: readonly string[] = [
  'A7', 'D7', 'E7', 'G7', 'C7', 'B7', 'Am7', 'Em7', 'Dm7', 'Cmaj7', 'Fmaj7',
  'Asus2', 'Asus4', 'Dsus2', 'Dsus4', 'Esus4', 'Cadd9',
];

/** Every easy chord, level 1 first (the order breaks ties in nearestEasyChord). */
export const EASY_CHORDS: string[] = [...EASY_CHORDS_LEVEL1, ...EASY_CHORDS_LEVEL2];

/** Highest capo fret that bestCapo / simplifyChart consider. */
export const DEFAULT_MAX_CAPO = 7;

/** A capo is only proposed when it lowers the difficulty sum by at least this fraction. */
export const MIN_CAPO_IMPROVEMENT = 0.15;

export const DEFAULT_SIMPLIFY_OPTIONS: SimplifyOptions = {
  removeExtensions: true,
  substituteHard: true,
  maxChords: 4,
  suggestCapo: true,
  allowSevenths: false,
};

const EPS = 1e-9;

// ---------------------------------------------------------------- helpers

function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

function resolve(symbol: string | ChordSymbol): ChordSymbol | null {
  return typeof symbol === 'string' ? parseChordSymbol(symbol) : symbol;
}

/** A real chord (not 'nc', not invalid). */
function isChord(sym: ChordSymbol | null): sym is ChordSymbol {
  return sym !== null && sym.quality !== 'nc' && sym.root >= 0 && sym.root <= 11;
}

/** Full identity (what the parser compares for chord changes). */
function identityKey(sym: ChordSymbol): string {
  return `${sym.root}:${sym.quality}:${sym.bass === null ? '' : sym.bass}`;
}

/** Identity without the bass (what decides the difficulty level). */
function shapeKey(sym: ChordSymbol): string {
  return `${sym.root}:${sym.quality}`;
}

function identityOfName(name: string): string | null {
  const sym = parseChordSymbol(name);
  return isChord(sym) ? identityKey(sym) : null;
}

function sameIdentity(a: ChordSymbol, b: ChordSymbol): boolean {
  return a.root === b.root && a.quality === b.quality && a.bass === b.bass;
}

/** Same chord (root, quality, bass) regardless of spelling. Two invalid names never match. */
export function sameChordName(a: string, b: string): boolean {
  const ia = identityOfName(a);
  return ia !== null && ia === identityOfName(b);
}

/** Number of pitch classes two chord names have in common (0 when either is not a chord). */
export function sharedPitchClasses(a: string, b: string): number {
  const sa = parseChordSymbol(a);
  const sb = parseChordSymbol(b);
  if (!isChord(sa) || !isChord(sb)) return 0;
  const set = new Set(chordPitchClasses(sa));
  return chordPitchClasses(sb).filter((pc) => set.has(pc)).length;
}

/** Merges entries with the same chord identity (first spelling wins), keeping the order of first appearance. */
function aggregateByIdentity(chords: WeightedChord[]): WeightedChord[] {
  const out: WeightedChord[] = [];
  const index = new Map<string, number>();
  for (const c of chords) {
    const id = identityOfName(c.name);
    if (id === null) continue;
    const i = index.get(id);
    if (i === undefined) {
      index.set(id, out.length);
      out.push({ name: c.name, beats: c.beats });
    } else {
      out[i].beats += c.beats;
    }
  }
  return out;
}

// ---------------------------------------------------------------- difficulty

const LEVEL1_KEYS = new Set(EASY_CHORDS_LEVEL1.map(keyOfEasyName));
const LEVEL2_KEYS = new Set(EASY_CHORDS_LEVEL2.map(keyOfEasyName));

function keyOfEasyName(name: string): string {
  const sym = parseChordSymbol(name);
  if (!isChord(sym)) throw new Error(`invalid easy chord: ${name}`);
  return shapeKey(sym);
}

function qualityReason(quality: ChordQuality): string {
  switch (quality) {
    case '7': case 'maj7': case 'm7': case '7sus4': case '9': case 'dim7': case 'm7b5':
      return 'acorde de séptima';
    case 'sus2': case 'sus4':
      return 'acorde suspendido';
    case 'add9': case '6': case 'm6':
      return 'acorde con extensión';
    case '5':
      return 'acorde de quinta (power chord)';
    case 'dim':
      return 'acorde disminuido';
    case 'aug':
      return 'acorde aumentado';
    default:
      return 'forma abierta de la biblioteca';
  }
}

/**
 * Difficulty of a chord (the slash bass is ignored: `G/B` is as easy as `G`):
 *  - level 1 ("fácil"): root + quality in EASY_CHORDS level 1;
 *  - level 2 ("medio"): in level 2, or the library has a barre-free voicing with at most 4 fretted strings;
 *  - level 3 ("difícil"): the voicing has a barre, is generated, or does not exist.
 * 'N.C.' is level 1 ("sin acorde"); invalid syntax is level 3 ("símbolo no reconocido").
 */
export function chordDifficulty(symbol: string | ChordSymbol): ChordDifficulty {
  const sym = resolve(symbol);
  if (!sym) return { level: 3, label: 'difícil', reason: 'símbolo no reconocido' };
  if (!isChord(sym)) return { level: 1, label: 'fácil', reason: 'sin acorde' };
  const key = shapeKey(sym);
  if (LEVEL1_KEYS.has(key)) return { level: 1, label: 'fácil', reason: 'acorde abierto básico' };
  if (LEVEL2_KEYS.has(key)) return { level: 2, label: 'medio', reason: qualityReason(sym.quality) };
  const shape = getChordShape(chordSymbolName(sym.root, sym.quality));
  if (!shape) return { level: 3, label: 'difícil', reason: 'sin digitación conocida' };
  if (shape.generated) return { level: 3, label: 'difícil', reason: 'cejilla (forma generada)' };
  if (shape.barre) return { level: 3, label: 'difícil', reason: 'cejilla' };
  const fretted = shape.fingers.filter((f) => f > 0).length;
  if (fretted > 4) return { level: 3, label: 'difícil', reason: `digitación con ${fretted} cuerdas pisadas` };
  return { level: 2, label: 'medio', reason: qualityReason(sym.quality) };
}

// ---------------------------------------------------------------- spelling / transposition

/** root (letter + accidentals), textual quality, optional slash bass. Mirrors notes.ts CHORD_RE. */
const NAME_SPLIT_RE = /^([A-G][#b]{0,2})([^/]*)(?:\/([A-G][#b]{0,2}))?$/;

/** Pitch classes usually spelled with a flat (Eb, Ab, Bb) unless the library spells them sharp. */
const FLAT_ROOTS = new Set([3, 8, 10]);

/** `${sharpRoot}:${quality}` of every library shape spelled with a sharp root (e.g. "G#:min"). */
const SHARP_SPELLED = new Set<string>();
for (const shape of CHORD_LIBRARY) {
  const m = NAME_SPLIT_RE.exec(shape.name);
  const sym = parseChordSymbol(shape.name);
  if (m && isChord(sym) && m[1].includes('#')) SHARP_SPELLED.add(`${m[1]}:${sym.quality}`);
}

/**
 * Name of a pitch class as a chord root: sharps (`C#`, `F#`), except `Eb`/`Ab`/`Bb`, which keep
 * the flat unless the chord library spells that root + quality with a sharp (`G#m`).
 * With `quality` null (a bass note) the flat is always used for those three.
 */
export function spellPitchClass(pc: number, quality: ChordQuality | null = null): string {
  const i = mod12(Math.round(pc));
  const sharp = NOTE_NAMES_SHARP[i];
  if (!FLAT_ROOTS.has(i)) return sharp;
  if (quality !== null && SHARP_SPELLED.has(`${sharp}:${quality}`)) return sharp;
  return NOTE_NAMES_FLAT[i];
}

/**
 * Transposes the root (and the slash bass) of a chord name, keeping the quality text as written
 * (`Bbmaj7` + 2 -> `Cmaj7`, `CM7` + 1 -> `C#M7`). 'N.C.', '-' and invalid names are returned unchanged.
 */
export function transposeName(name: string, semitones: number): string {
  const trimmed = name.trim();
  const sym = parseChordSymbol(trimmed);
  if (!isChord(sym)) return name;
  const m = NAME_SPLIT_RE.exec(normalizeSymbolText(trimmed));
  if (!m) return name;
  const root = spellPitchClass(sym.root + semitones, sym.quality);
  const bass = m[3] === undefined ? '' : '/' + spellPitchClass(pitchClassOf(m[3]) + semitones);
  return root + m[2] + bass;
}

// ---------------------------------------------------------------- quality reduction

const REDUCE_TO_MAJ: ReadonlySet<ChordQuality> = new Set<ChordQuality>([
  'maj7', '7', 'add9', '6', '9', 'sus2', 'sus4', '7sus4', 'aug', '5',
]);
const REDUCE_TO_MIN: ReadonlySet<ChordQuality> = new Set<ChordQuality>(['m7', 'm6', 'dim', 'dim7', 'm7b5']);

/** The plain triad quality a chord reduces to (`maj7` -> `maj`, `dim` -> `min`, `maj`/`min`/`nc` unchanged). */
export function reducedQuality(quality: ChordQuality): ChordQuality {
  if (REDUCE_TO_MAJ.has(quality)) return 'maj';
  if (REDUCE_TO_MIN.has(quality)) return 'min';
  return quality;
}

/**
 * Reduces a chord to its plain triad and drops the slash bass. The name is regenerated with the
 * root spelled as the user wrote it (`Bb7` -> `Bb`, `Am7/G` -> `Am`). 'nc' symbols are copied unchanged.
 */
export function reduceQuality(sym: ChordSymbol): ChordSymbol {
  if (sym.quality === 'nc' || sym.root < 0 || sym.root > 11) return { ...sym };
  const quality = reducedQuality(sym.quality);
  return { name: rootNameOf(sym) + QUALITY_SUFFIX[quality], root: sym.root, quality, bass: null };
}

// ---------------------------------------------------------------- key estimation

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** True when every pitch class belongs to the key's scale (major / natural minor). */
export function isDiatonic(pcs: number[], key: { root: number; mode: KeyMode }): boolean {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  return pcs.every((pc) => scale.includes(mod12(pc - key.root)));
}

/** Whether a chord quality can act as the tonic of a mode (no third counts for both). */
function fitsMode(quality: ChordQuality, mode: KeyMode): boolean {
  const third = qualityThird(quality);
  return third === null || third === (mode === 'major' ? 4 : 3);
}

const SOLFEGE: Record<string, string> = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };

/** Spanish key name: (0, 'major') -> "Do mayor", (10, 'major') -> "Sib mayor", (8, 'minor') -> "Sol# menor". */
export function keyName(root: number, mode: KeyMode): string {
  const spelled = spellPitchClass(root, mode === 'major' ? 'maj' : 'min');
  return SOLFEGE[spelled[0]] + spelled.slice(1) + (mode === 'major' ? ' mayor' : ' menor');
}

/**
 * The key (root + mode) whose scale contains the most beats of chords. Ties: the key whose tonic
 * chord has the most beats, then the key whose tonic is the first chord, then major, then the
 * lowest root. null when there is no chord with beats > 0.
 */
export function estimateKeyFromChords(chords: WeightedChord[]): KeyEstimate | null {
  const parsed: Array<{ sym: ChordSymbol; pcs: number[]; beats: number }> = [];
  for (const c of chords) {
    const sym = parseChordSymbol(c.name);
    if (!isChord(sym) || !(c.beats > 0)) continue;
    parsed.push({ sym, pcs: chordPitchClasses(sym), beats: c.beats });
  }
  if (parsed.length === 0) return null;
  let best: { root: number; mode: KeyMode; diatonic: number; tonic: number; first: number } | null = null;
  for (const mode of ['major', 'minor'] as const) {
    for (let root = 0; root < 12; root++) {
      const key = { root, mode };
      let diatonic = 0;
      let tonic = 0;
      for (const p of parsed) {
        if (isDiatonic(p.pcs, key)) diatonic += p.beats;
        if (p.sym.root === root && fitsMode(p.sym.quality, mode)) tonic += p.beats;
      }
      const first = parsed[0].sym.root === root && fitsMode(parsed[0].sym.quality, mode) ? 1 : 0;
      const better =
        best === null ||
        diatonic > best.diatonic + EPS ||
        (Math.abs(diatonic - best.diatonic) <= EPS &&
          (tonic > best.tonic + EPS || (Math.abs(tonic - best.tonic) <= EPS && first > best.first)));
      if (better) best = { root, mode, diatonic, tonic, first };
    }
  }
  const b = best as { root: number; mode: KeyMode };
  return { root: b.root, mode: b.mode, name: keyName(b.root, b.mode) };
}

// ---------------------------------------------------------------- nearest easy chord

/** Weight (in tenths) of each pitch class of a chord by its role: root 1.5, third 1.0, fifth 0.5, others 0.5. */
function toneWeights(sym: ChordSymbol): Map<number, number> {
  const third = qualityThird(sym.quality);
  const weights = new Map<number, number>();
  for (const pc of chordPitchClasses(sym)) {
    if (pc === sym.root) weights.set(pc, 15);
    else if (third !== null && pc === mod12(sym.root + third)) weights.set(pc, 10);
    else weights.set(pc, 5);
  }
  return weights;
}

/**
 * The easy chord closest to `symbol`. Candidates: EASY_CHORDS level 1 (+ level 2 with
 * `allowSevenths`) or `opts.candidates`. Score = shared notes weighted by their role in the
 * original chord (root 1.5, third 1.0, fifth 0.5, others 0.5) + 0.5 when the candidate is
 * diatonic in `key` − 0.3 when the third changes (major <-> minor). At least `minShared`
 * (default 2) notes must be shared; ties go to the lower difficulty level, then to the
 * candidate listed first. null when no candidate qualifies.
 */
export function nearestEasyChord(symbol: string | ChordSymbol, opts: NearestChordOpts): NearestChord | null {
  const sym = resolve(symbol);
  if (!isChord(sym)) return null;
  const candidates = opts.candidates ?? (opts.allowSevenths ? EASY_CHORDS : [...EASY_CHORDS_LEVEL1]);
  const minShared = Math.max(1, opts.minShared ?? 2);
  const weights = toneWeights(sym);
  const third = qualityThird(sym.quality);
  let best: { name: string; shared: number; tenths: number; level: number } | null = null;
  for (const name of candidates) {
    const cand = parseChordSymbol(name);
    if (!isChord(cand)) continue;
    const pcs = chordPitchClasses(cand);
    let shared = 0;
    let tenths = 0;
    for (const pc of pcs) {
      const w = weights.get(pc);
      if (w !== undefined) {
        shared++;
        tenths += w;
      }
    }
    if (shared < minShared) continue;
    if (opts.key && isDiatonic(pcs, opts.key)) tenths += 5;
    const candThird = qualityThird(cand.quality);
    if (third !== null && candThird !== null && third !== candThird) tenths -= 3;
    const level = chordDifficulty(cand).level;
    if (best === null || tenths > best.tenths || (tenths === best.tenths && level < best.level)) {
      best = { name, shared, tenths, level };
    }
  }
  return best === null ? null : { name: best.name, shared: best.shared, score: best.tenths / 10 };
}

// ---------------------------------------------------------------- capo

/**
 * Capo that minimises Σ beats × difficulty level over `chords` (written for `fromCapo`).
 * Every total capo 0..maxCapo is tried, transposing the names by `fromCapo − capo`; ties go to
 * the lowest capo. The current capo is kept unless the best one lowers the sum by at least
 * `minImprovement` (15 %). `names` are the chord names as they would be written.
 */
export function bestCapo(
  chords: WeightedChord[],
  maxCapo = DEFAULT_MAX_CAPO,
  fromCapo = 0,
  minImprovement = MIN_CAPO_IMPROVEMENT,
): CapoSuggestion {
  const evaluate = (capo: number): CapoSuggestion => {
    const delta = fromCapo - capo;
    let difficulty = 0;
    const names = chords.map((c) => {
      if (!isChord(parseChordSymbol(c.name))) return c.name;
      const name = delta === 0 ? c.name : transposeName(c.name, delta);
      difficulty += c.beats * chordDifficulty(name).level;
      return name;
    });
    return { capo, difficulty, names };
  };
  const baseline = evaluate(fromCapo);
  const top = Math.max(0, Math.min(12, Math.floor(maxCapo)));
  let best: CapoSuggestion | null = null;
  for (let capo = 0; capo <= top; capo++) {
    const r = capo === fromCapo ? baseline : evaluate(capo);
    if (best === null || r.difficulty < best.difficulty - EPS) best = r;
  }
  if (best === null || best.capo === fromCapo) return baseline;
  if (best.difficulty > baseline.difficulty * (1 - minImprovement) + EPS) return baseline;
  return best;
}

// ---------------------------------------------------------------- keep the N most frequent

/**
 * Keeps the `n` chords with the most beats (ties: first to appear) and maps every other chord
 * to the closest kept one (`nearestEasyChord` with the kept names as candidates, at least one
 * shared note; none shared -> the most frequent kept chord). Kept chords map to themselves.
 * `n <= 0` or `n >= number of chords` -> identity map.
 */
export function keepTopChords(chords: WeightedChord[], n: number, key: KeyHint): Map<string, string> {
  const totals = new Map<string, number>();
  for (const c of chords) {
    if (!isChord(parseChordSymbol(c.name))) continue;
    totals.set(c.name, (totals.get(c.name) ?? 0) + c.beats);
  }
  const names = [...totals.keys()];
  const map = new Map<string, string>();
  if (n <= 0 || n >= names.length) {
    for (const name of names) map.set(name, name);
    return map;
  }
  const ranked = names
    .map((name, index) => ({ name, index, beats: totals.get(name) ?? 0 }))
    .sort((a, b) => b.beats - a.beats || a.index - b.index)
    .map((r) => r.name);
  const kept = ranked.slice(0, Math.floor(n));
  for (const name of kept) map.set(name, name);
  for (const name of names) {
    if (map.has(name)) continue;
    const near = nearestEasyChord(name, { key, allowSevenths: true, candidates: kept, minShared: 1 });
    map.set(name, near ? near.name : kept[0]);
  }
  return map;
}

// ---------------------------------------------------------------- text rewriting

// These mirror the line classification of song/parser.ts (kept in sync by hand).
const COMMENT_RE = /(^|\s)#.*$/;
const HEADER_RE = /^(title|artist|tempo|time|strum|capo)\s*:\s*(.*)$/i;
const UNKNOWN_HEADER_RE = /^([A-Za-zÀ-ÿ][\wÀ-ÿ]*)\s*:/;
const CAPO_VALUE_RE = /^(\s*capo\s*:\s*)([^\s#]*)(.*)$/i;
/** A chord token of a bar line: name, optional slash bass, optional `*n` duration. */
const CHORD_TOKEN_RE = /^([A-G][#b]?[^\s|*/]*)(\/[A-G][#b]?)?(\*\d+)?$/;

/** Rewrites the chord tokens of one bar line (the trailing comment, `.`, `-`, `N.C.`, `x<n>` and `*n` are kept). */
function rewriteBarLine(raw: string, map: (name: string) => string): string {
  const cm = COMMENT_RE.exec(raw);
  const body = cm ? raw.slice(0, cm.index) : raw;
  const comment = cm ? raw.slice(cm.index) : '';
  const rewritten = body.replace(/[^\s|]+/g, (tok) => {
    const m = CHORD_TOKEN_RE.exec(tok);
    if (!m) return tok;
    const base = m[1] + (m[2] ?? '');
    if (!isChord(parseChordSymbol(base))) return tok;
    const to = map(base);
    return to === base ? tok : to + (m[3] ?? '');
  });
  return rewritten + comment;
}

/**
 * Rewrites only the chord tokens of the bar lines of a song text through `map(name) -> name`
 * (name = the token without its `*n`, e.g. "Am7", "G/B"). Headers, sections, comments,
 * lyric lines, `x<n>` repeats, `.`, `-` and `N.C.` are preserved byte for byte. With `capo`
 * non-null the `capo:` header is updated, or added after the last header when missing.
 */
export function rewriteChordTokens(source: string, map: (name: string) => string, capo: number | null = null): string {
  const parts = source.split(/(\r\n|\r|\n)/); // even = lines, odd = separators
  const newline = parts.length > 1 ? parts[1] : '\n';
  const out: string[] = [];
  let capoWritten = capo === null;
  let lastHeaderIndex = -1;
  let sawBody = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out.push(parts[i]);
      continue;
    }
    const raw = parts[i];
    const ts = raw.trimStart();
    if (ts === '' || ts.startsWith('>')) {
      out.push(raw);
      continue;
    }
    const stripped = raw.replace(COMMENT_RE, '').trim();
    if (stripped === '') {
      out.push(raw);
      continue;
    }
    const header = HEADER_RE.exec(stripped);
    if (header) {
      if (capo !== null && header[1].toLowerCase() === 'capo') {
        out.push(raw.replace(CAPO_VALUE_RE, `$1${capo}$3`));
        capoWritten = true;
      } else {
        out.push(raw);
      }
      if (!sawBody) lastHeaderIndex = out.length - 1;
      continue;
    }
    sawBody = true;
    if (stripped.startsWith('[')) {
      out.push(raw);
      continue;
    }
    const unknown = UNKNOWN_HEADER_RE.exec(stripped);
    if (unknown && !stripped.includes('|')) {
      out.push(raw);
      continue;
    }
    out.push(rewriteBarLine(raw, map));
  }
  if (!capoWritten && capo !== null && capo > 0) {
    const line = `capo: ${capo}`;
    if (lastHeaderIndex >= 0) out.splice(lastHeaderIndex + 1, 0, newline, line);
    else out.unshift(line, newline);
  }
  return out.join('');
}

// ---------------------------------------------------------------- simplifyChart

function reductionReason(name: string): string {
  const sym = parseChordSymbol(name);
  if (!isChord(sym)) return 'simplificado';
  const parts: string[] = [];
  if (reducedQuality(sym.quality) !== sym.quality) {
    switch (sym.quality) {
      case '7': case 'maj7': case 'm7': case '7sus4': case '9': case 'dim7': case 'm7b5':
        parts.push('séptima eliminada');
        break;
      case 'sus2': case 'sus4':
        parts.push('suspensión eliminada');
        break;
      case 'add9': case '6': case 'm6':
        parts.push('extensión eliminada');
        break;
      case 'dim':
        parts.push('disminuido → menor');
        break;
      case 'aug':
        parts.push('aumentado → mayor');
        break;
      case '5':
        parts.push('quinta → mayor');
        break;
      default:
        parts.push('cualidad simplificada');
    }
  }
  if (sym.bass !== null) parts.push('bajo alternativo eliminado');
  return parts.join(', ') || 'simplificado';
}

/**
 * Simplifies a song text (SPEC section 13). Pipeline over the distinct written chord names,
 * weighted by their beats in `song.bars` (repeats expanded):
 *  1. `removeExtensions` -> reduceQuality;
 *  2. `suggestCapo` -> bestCapo (from the song's current capo; the result's capo is the total
 *     fret, the `capo:` header is updated or added and every name is transposed);
 *  3. `substituteHard` -> every level-3 chord -> nearestEasyChord in the estimated key;
 *  4. `maxChords` -> keepTopChords.
 * Only the chord tokens of the bar lines are rewritten; the slash bass disappears only when
 * the chord changes. Chord names that the parser dropped (bars with errors) go through the same
 * per-name pipeline. Missing options take DEFAULT_SIMPLIFY_OPTIONS.
 */
export function simplifyChart(source: string, options: Partial<SimplifyOptions> = {}): SimplifyResult {
  const opts: SimplifyOptions = { ...DEFAULT_SIMPLIFY_OPTIONS, ...options };
  const { song } = parseSong(source);

  const beatsByName = new Map<string, number>();
  for (const bar of song.bars) {
    for (const held of bar.chords) {
      if (held.chord.quality === 'nc') continue;
      beatsByName.set(held.chord.name, (beatsByName.get(held.chord.name) ?? 0) + held.beats);
    }
  }
  const written: WeightedChord[] = [...beatsByName].map(([name, beats]) => ({ name, beats }));

  // (1) sevenths, extensions and slash basses
  const reduce = (name: string): string => {
    if (!opts.removeExtensions) return name;
    const sym = parseChordSymbol(name);
    if (!isChord(sym)) return name;
    const reduced = reduceQuality(sym);
    return sameIdentity(sym, reduced) ? name : reduced.name;
  };
  const afterReduce = aggregateByIdentity(written.map((c) => ({ name: reduce(c.name), beats: c.beats })));

  // (2) capo
  const capo = opts.suggestCapo ? bestCapo(afterReduce, DEFAULT_MAX_CAPO, song.capo).capo : song.capo;
  const delta = song.capo - capo;
  const transpose = (name: string): string => (delta === 0 ? name : transposeName(name, delta));
  const afterCapo = aggregateByIdentity(afterReduce.map((c) => ({ name: transpose(c.name), beats: c.beats })));

  // (3) hard chords -> nearest easy chord in the estimated key
  const key = estimateKeyFromChords(afterCapo);
  const substitute = (name: string): { name: string; reason: string | null } => {
    if (!opts.substituteHard) return { name, reason: null };
    const d = chordDifficulty(name);
    if (d.level !== 3) return { name, reason: null };
    const near = nearestEasyChord(name, { key, allowSevenths: opts.allowSevenths });
    if (!near) return { name, reason: null };
    return { name: near.name, reason: `${d.label}: ${d.reason} (comparte ${near.shared} notas)` };
  };
  const afterSubstitute = aggregateByIdentity(
    afterCapo.map((c) => ({ name: substitute(c.name).name, beats: c.beats })),
  );

  // (4) keep the N most frequent chords
  const limit = opts.maxChords !== null && opts.maxChords > 0 ? Math.floor(opts.maxChords) : null;
  const keptByIdentity = new Map<string, string>();
  const keptNames: string[] = [];
  if (limit !== null) {
    for (const [from, to] of keepTopChords(afterSubstitute, limit, key)) {
      const id = identityOfName(from);
      if (id !== null) keptByIdentity.set(id, to);
      if (!keptNames.includes(to)) keptNames.push(to);
    }
  }
  const keep = (name: string): string => {
    if (keptNames.length === 0) return name;
    const id = identityOfName(name);
    if (id === null) return name;
    const mapped = keptByIdentity.get(id);
    if (mapped !== undefined) return mapped;
    // A name the parser never saw (bar with an error): closest kept chord, else the most frequent.
    const near = nearestEasyChord(name, { key, allowSevenths: true, candidates: keptNames, minShared: 1 });
    return near ? near.name : keptNames[0];
  };

  const memo = new Map<string, { name: string; reasons: string[] }>();
  const transform = (name: string): { name: string; reasons: string[] } => {
    const cached = memo.get(name);
    if (cached) return cached;
    const reasons: string[] = [];
    let cur = name;
    const r1 = reduce(cur);
    if (r1 !== cur) {
      reasons.push(reductionReason(cur));
      cur = r1;
    }
    const r2 = transpose(cur);
    if (r2 !== cur) {
      reasons.push(capo > 0 ? `cejilla en el traste ${capo}` : 'sin cejilla');
      cur = r2;
    }
    const r3 = substitute(cur);
    if (r3.name !== cur) {
      reasons.push(r3.reason ?? 'acorde difícil sustituido');
      cur = r3.name;
    }
    const r4 = keep(cur);
    if (r4 !== cur) {
      reasons.push(
        sameChordName(cur, r4)
          ? 'notación unificada'
          : `fuera de los ${limit} acordes más frecuentes (comparte ${sharedPitchClasses(cur, r4)} notas)`,
      );
      cur = r4;
    }
    const out = { name: cur, reasons };
    memo.set(name, out);
    return out;
  };

  const substitutions: SimplifySubstitution[] = [];
  const chordsAfter: string[] = [];
  let unchangedBeats = 0;
  let totalBeats = 0;
  for (const c of written) {
    const t = transform(c.name);
    totalBeats += c.beats;
    if (sameChordName(t.name, transpose(c.name))) unchangedBeats += c.beats;
    if (!chordsAfter.includes(t.name)) chordsAfter.push(t.name);
    if (t.name !== c.name) {
      substitutions.push({ from: c.name, to: t.name, beats: c.beats, reason: t.reasons.join('; ') });
    }
  }

  const rewritten = rewriteChordTokens(source, (name) => transform(name).name, capo !== song.capo ? capo : null);
  return {
    source: rewritten,
    capo,
    substitutions,
    chordsBefore: song.chordNames.slice(),
    chordsAfter,
    unchangedBeatsRatio: totalBeats > 0 ? unchangedBeats / totalBeats : 1,
  };
}
