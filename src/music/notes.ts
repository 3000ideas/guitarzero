/**
 * Note names, pitch classes, MIDI <-> Hz conversion and chord-symbol parsing.
 * Pure functions, no DOM, no dependencies (testable in Node).
 */
import type { ChordQuality, ChordSymbol } from '../types';

// ---------------------------------------------------------------- note names

export const NOTE_NAMES_SHARP: string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT: string[] = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Maps the unicode variants users type (♯ ♭ ∆ △ º ˚ Ø) to their ASCII / canonical forms. */
export function normalizeSymbolText(text: string): string {
  return text
    .replace(/♯/g, '#') // ♯
    .replace(/♭/g, 'b') // ♭
    .replace(/[∆△]/g, 'Δ') // ∆ △ -> Δ
    .replace(/[º˚]/g, '°') // º ˚ -> °
    .replace(/Ø/g, 'ø'); // Ø -> ø
}

const NOTE_RE = /^([A-Ga-g])([#b♯♭]*)$/;

/**
 * Pitch class (0..11, C = 0) of a note name such as "F#", "Bb", "F♯", "B♭", "Cb" (= 11) or "E#" (= 5).
 * Returns -1 when the text is not a note name.
 */
export function pitchClassOf(name: string): number {
  const m = NOTE_RE.exec(name.trim());
  if (!m) return -1;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

/** Name of a pitch class without octave, e.g. 10 -> "A#" (or "Bb" with flats). */
export function pitchClassName(pc: number, flats = false): string {
  const i = ((Math.round(pc) % 12) + 12) % 12;
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[i];
}

// ---------------------------------------------------------------- midi / frequency

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Fractional MIDI number (round it yourself when you need a note). */
export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Scientific pitch name of a MIDI note, e.g. 60 -> "C4", 40 -> "E2", 61 -> "C#4" / "Db4". */
export function noteName(midi: number, flats = false): string {
  const m = Math.round(midi);
  const octave = Math.floor(m / 12) - 1;
  return pitchClassName(m, flats) + String(octave);
}

// ---------------------------------------------------------------- chord qualities

/** Semitones from the root for every quality (chord tones only, no octave information). */
export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 2],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 2],
  '5': [0, 7],
  nc: [],
};

/** Canonical display suffix per quality (what `chordSymbolName` and the barre generator use). */
export const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  dim: 'dim',
  dim7: 'dim7',
  m7b5: 'm7b5',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '7sus4': '7sus4',
  add9: 'add9',
  '6': '6',
  m6: 'm6',
  '9': '9',
  '5': '5',
  nc: '',
};

/**
 * Accepted quality spellings (after `normalizeSymbolText`). Case matters for single letters
 * (`M` = major, `m` = minor); multi-letter words are also accepted case-insensitively.
 */
const QUALITY_ALIASES: Record<string, ChordQuality> = {
  '': 'maj', maj: 'maj', M: 'maj', major: 'maj',
  m: 'min', min: 'min', mi: 'min', '-': 'min', minor: 'min',
  '7': '7', dom7: '7',
  maj7: 'maj7', M7: 'maj7', 'Δ7': 'maj7', 'Δ': 'maj7', // Δ7 Δ
  m7: 'm7', min7: 'm7', mi7: 'm7', '-7': 'm7',
  dim: 'dim', '°': 'dim', o: 'dim', // °
  dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
  m7b5: 'm7b5', min7b5: 'm7b5', '-7b5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', // ø ø7
  aug: 'aug', '+': 'aug',
  sus2: 'sus2',
  sus4: 'sus4', sus: 'sus4',
  '7sus4': '7sus4', '7sus': '7sus4',
  add9: 'add9',
  '6': '6', maj6: '6', M6: '6',
  m6: 'm6', min6: 'm6', '-6': 'm6',
  '9': '9', dom9: '9',
  '5': '5',
};

function lookupQuality(suffix: string): ChordQuality | undefined {
  const q = QUALITY_ALIASES[suffix];
  if (q !== undefined) return q;
  // Case-insensitive fallback only for word-based spellings ("Maj7", "MIN", "Sus4"...).
  if (/^(maj|min|mi|dim|aug|sus|add|dom)/i.test(suffix)) return QUALITY_ALIASES[suffix.toLowerCase()];
  return undefined;
}

// ---------------------------------------------------------------- chord symbols

const NC_RE = /^n\.?c\.?$/i;
/** root (letter + up to two accidentals), quality suffix (anything but '/'), optional slash bass. */
const CHORD_RE = /^([A-G][#b]{0,2})([^/]*)(?:\/([A-G][#b]{0,2}))?$/;

/**
 * Parses a chord symbol ("C", "F#m7", "Bb", "G/B", "CM7", "C-7", "Cø", "N.C.", "-").
 * Returns null for invalid syntax. `name` keeps the text as written (trimmed).
 * A slash bass equal to the root is dropped (`C/C` -> bass null).
 */
export function parseChordSymbol(text: string): ChordSymbol | null {
  const name = text.trim();
  if (name === '') return null;
  if (name === '-' || NC_RE.test(name)) return { name, root: -1, quality: 'nc', bass: null };
  const m = CHORD_RE.exec(normalizeSymbolText(name));
  if (!m) return null;
  const root = pitchClassOf(m[1]);
  const quality = lookupQuality(m[2]);
  if (root < 0 || quality === undefined) return null;
  let bass: number | null = null;
  if (m[3] !== undefined) {
    bass = pitchClassOf(m[3]);
    if (bass < 0) return null;
    if (bass === root) bass = null;
  }
  return { name, root, quality, bass };
}

/** Canonical name for a root/quality/bass, e.g. (6, 'min') -> "F#m", (7, 'maj', 11) -> "G/B". */
export function chordSymbolName(root: number, quality: ChordQuality, bass: number | null = null, flats = false): string {
  if (quality === 'nc' || root < 0) return 'N.C.';
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const b = bass !== null && bass !== root ? '/' + names[((bass % 12) + 12) % 12] : '';
  return names[((root % 12) + 12) % 12] + QUALITY_SUFFIX[quality] + b;
}

/** Builds a ChordSymbol with its canonical name. */
export function makeChordSymbol(root: number, quality: ChordQuality, bass: number | null = null, flats = false): ChordSymbol {
  if (quality === 'nc' || root < 0) return { name: 'N.C.', root: -1, quality: 'nc', bass: null };
  const r = ((root % 12) + 12) % 12;
  const b = bass === null ? null : ((bass % 12) + 12) % 12;
  return { name: chordSymbolName(r, quality, b, flats), root: r, quality, bass: b === r ? null : b };
}

/** Unique ascending pitch classes of the chord, including the slash bass. `[]` for 'nc'. */
export function chordPitchClasses(sym: ChordSymbol): number[] {
  if (sym.quality === 'nc' || sym.root < 0 || sym.root > 11) return [];
  const set = new Set<number>();
  for (const i of QUALITY_INTERVALS[sym.quality]) set.add((sym.root + i) % 12);
  if (sym.bass !== null && sym.bass >= 0) set.add(sym.bass % 12);
  return [...set].sort((a, b) => a - b);
}

/** The third of the quality in semitones (4 major, 3 minor) or null when it has none (sus, 5, aug, nc). */
export function qualityThird(q: ChordQuality): 3 | 4 | null {
  switch (q) {
    case 'maj': case '7': case 'maj7': case 'add9': case '6': case '9':
      return 4;
    case 'min': case 'm7': case 'm6': case 'dim': case 'dim7': case 'm7b5':
      return 3;
    default:
      return null;
  }
}

/** Suffix of the "other third" chord: natural pairs first, else plain `<root>m` / `<root>`. */
const SWAP_SUFFIX: Record<ChordQuality, string> = {
  maj: 'm', min: '',
  '7': 'm7', m7: '7',
  '6': 'm6', m6: '6',
  maj7: 'm', add9: 'm', '9': 'm',
  dim: '', dim7: '', m7b5: '',
  aug: '', sus2: '', sus4: '', '7sus4': '', '5': '',
  nc: '',
};

const NAME_PARTS_RE = /^([A-G][#b]{0,2})[^/]*(?:\/([A-G][#b]{0,2}))?$/;

function spelledParts(sym: ChordSymbol): { root: string | null; bass: string | null } {
  const m = NAME_PARTS_RE.exec(normalizeSymbolText(sym.name.trim()));
  if (!m) return { root: null, bass: null };
  return { root: m[1], bass: m[2] ?? null };
}

/** Root name as the user spelled it ("Bb" stays "Bb"), falling back to sharps. '' for 'nc'. */
export function rootNameOf(sym: ChordSymbol): string {
  if (sym.quality === 'nc' || sym.root < 0 || sym.root > 11) return '';
  const spelled = spelledParts(sym).root;
  if (spelled !== null && pitchClassOf(spelled) === sym.root) return spelled;
  return NOTE_NAMES_SHARP[sym.root];
}

/** Bass name as the user spelled it, falling back to sharps. null when the chord has no slash bass. */
export function bassNameOf(sym: ChordSymbol): string | null {
  if (sym.bass === null || sym.bass < 0) return null;
  const spelled = spelledParts(sym).bass;
  if (spelled !== null && pitchClassOf(spelled) === sym.bass) return spelled;
  return NOTE_NAMES_SHARP[sym.bass % 12];
}

/**
 * Name of the chord with the same root and the other third: `A` <-> `Am`, `C7` -> `Cm7`,
 * `Am7` -> `A7`, `C6` <-> `Cm6`; qualities without a natural pair give `<root>m` / `<root>`.
 * Keeps the user's spelling of the root and any slash bass. Returns the name unchanged for 'nc'.
 */
export function swapThirdName(sym: ChordSymbol): string {
  if (sym.quality === 'nc' || sym.root < 0 || sym.root > 11) return sym.name;
  const bass = bassNameOf(sym);
  return rootNameOf(sym) + SWAP_SUFFIX[sym.quality] + (bass === null ? '' : '/' + bass);
}
