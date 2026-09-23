/**
 * Chord fingering library + barre-chord generator.
 * String index convention (types.ts): 0 = 6th string (low E) ... 5 = 1st string (high e).
 * `frets` are absolute fret numbers (-1 muted, 0 open); `baseFret` is only a display hint.
 */
import type { Barre, ChordQuality, ChordShape, ChordSymbol } from '../types';
import { QUALITY_SUFFIX, parseChordSymbol, rootNameOf } from './notes';

/** Standard tuning E2 A2 D3 G3 B3 E4, index 0 = 6th string. */
export const STANDARD_TUNING_MIDI: number[] = [40, 45, 50, 55, 59, 64];

// ---------------------------------------------------------------- helpers

function minFrettedFret(frets: number[]): number {
  let min = Infinity;
  for (const f of frets) if (f > 0 && f < min) min = f;
  return min === Infinity ? 0 : min;
}

function maxFret(frets: number[]): number {
  let max = 0;
  for (const f of frets) if (f > max) max = f;
  return max;
}

/**
 * Display base fret: 1 (nut shown) unless the shape starts above the 3rd fret or would not fit
 * in a 5-fret window from the nut; then the lowest fretted fret ("4fr", "6fr"...).
 */
export function computeBaseFret(frets: number[]): number {
  const min = minFrettedFret(frets);
  if (min === 0) return 1;
  return min > 3 || maxFret(frets) > 5 ? min : 1;
}

/** Parses "x32010" (one char per string, 6th string first) into absolute frets. */
function parseFretString(s: string): number[] {
  if (s.length !== 6) throw new Error(`fret string must have 6 chars: ${s}`);
  return [...s].map((c) => (c === 'x' || c === 'X' ? -1 : Number.parseInt(c, 10)));
}

/** Library entry builder. `barre` = inclusive string range; its fret = lowest fretted fret in that range. */
function def(name: string, fretStr: string, fingerStr: string, barre?: [number, number]): ChordShape {
  const frets = parseFretString(fretStr);
  const fingers = [...fingerStr].map((c) => Number.parseInt(c, 10));
  const shape: ChordShape = { name, frets, fingers, baseFret: computeBaseFret(frets) };
  if (barre) {
    const [fromString, toString] = barre;
    shape.barre = { fret: minFrettedFret(frets.slice(fromString, toString + 1)), fromString, toString };
  }
  return shape;
}

// ---------------------------------------------------------------- library

/**
 * Common open (and a few standard barre) voicings. Fingers: 1 index, 2 middle, 3 ring, 4 pinky;
 * strings covered by a barre carry the barre finger (1).
 */
export const CHORD_LIBRARY: ChordShape[] = [
  // Major
  def('C', 'x32010', '032010'),
  def('D', 'xx0232', '000132'),
  def('E', '022100', '023100'),
  def('F', '133211', '134211', [0, 5]),
  def('G', '320003', '210003'),
  def('A', 'x02220', '001230'),
  def('B', 'x24442', '012341', [1, 5]),
  // Minor
  def('Am', 'x02210', '002310'),
  def('Bm', 'x24432', '013421', [1, 5]),
  def('Cm', 'x35543', '013421', [1, 5]),
  def('Dm', 'xx0231', '000231'),
  def('Em', '022000', '023000'),
  def('Fm', '133111', '134111', [0, 5]),
  def('Gm', '355333', '134111', [0, 5]),
  // Dominant 7
  def('A7', 'x02020', '002030'),
  def('B7', 'x21202', '021304'),
  def('C7', 'x32310', '032410'),
  def('D7', 'xx0212', '000213'),
  def('E7', '020100', '020100'),
  def('G7', '320001', '320001'),
  // Minor 7
  def('Am7', 'x02010', '002010'),
  def('Dm7', 'xx0211', '000211', [4, 5]),
  def('Em7', '020000', '020000'),
  // Major 7
  def('Cmaj7', 'x32000', '032000'),
  def('Fmaj7', 'xx3210', '003210'),
  def('Amaj7', 'x02120', '002130'),
  def('Dmaj7', 'xx0222', '000111', [3, 5]),
  def('Emaj7', '021100', '031200'),
  // Suspended
  def('Asus2', 'x02200', '001200'),
  def('Asus4', 'x02230', '001230'),
  def('Dsus2', 'xx0230', '000130'),
  def('Dsus4', 'xx0233', '000134'),
  def('Esus4', '022200', '023400'),
  // Add9
  def('Cadd9', 'x32033', '021034'),
  def('Gadd9', '3x0203', '200103'),
  // Slash chords
  def('G/B', 'x20003', '010003'),
  def('D/F#', '200232', '100243'),
  def('C/G', '332010', '342010'),
  def('Am/G', '302210', '402310'),
  def('C/E', '032010', '032010'),
  def('D/A', 'x00232', '000132'),
  def('A/E', '002220', '001230'),
  def('A/C#', 'x42220', '041230'),
  def('E/G#', '4x2100', '302100'),
  def('Am/E', '002210', '002310'),
  def('Em/B', 'x22000', '012000'),
  def('G/D', 'xx0003', '000003'),
  // Barre / higher positions
  def('Bb', 'x13331', '012341', [1, 5]),
  def('Eb', 'x68886', '012341', [1, 5]),
  def('F#m', '244222', '134111', [0, 5]),
  def('C#m', 'x46654', '013421', [1, 5]),
  def('G#m', '466444', '134111', [0, 5]),
  def('Bm7', 'x24232', '013121', [1, 5]),
  def('F#m7', '242222', '131111', [0, 5]),
  // Power chords
  def('A5', 'x022xx', '001200'),
  def('E5', '022xxx', '012000'),
  def('D5', 'xx023x', '000130'),
  def('G5', '355xxx', '134000'),
];

/** Index by root:quality:bass (enharmonic and alias spellings collapse to the same key). */
const LIBRARY_INDEX: Map<string, ChordShape> = new Map();
for (const shape of CHORD_LIBRARY) {
  const sym = parseChordSymbol(shape.name);
  if (!sym) throw new Error(`invalid chord name in library: ${shape.name}`);
  const key = indexKey(sym.root, sym.quality, sym.bass);
  if (!LIBRARY_INDEX.has(key)) LIBRARY_INDEX.set(key, shape);
}

function indexKey(root: number, quality: ChordQuality, bass: number | null): string {
  return `${root}:${quality}:${bass === null ? '' : bass}`;
}

/** Library lookup by root + quality + bass (exact voicing identity, enharmonic-insensitive). */
export function findLibraryShape(root: number, quality: ChordQuality, bass: number | null = null): ChordShape | null {
  return LIBRARY_INDEX.get(indexKey(root, quality, bass)) ?? null;
}

// ---------------------------------------------------------------- barre generator

interface BarreTemplate {
  /** Fret offsets from the barre fret per string, -1 = muted. */
  rel: number[];
  fingers: number[];
  /** Whether the shape uses a full barre (power chords do not). */
  barre: boolean;
}

/** Root on the 6th string (E shape). Open-chord origin: E, Em, E7, Em7, Emaj7, Esus4, E5. */
const E_SHAPES: Partial<Record<ChordQuality, BarreTemplate>> = {
  maj: { rel: [0, 2, 2, 1, 0, 0], fingers: [1, 3, 4, 2, 1, 1], barre: true },
  min: { rel: [0, 2, 2, 0, 0, 0], fingers: [1, 3, 4, 1, 1, 1], barre: true },
  '7': { rel: [0, 2, 0, 1, 0, 0], fingers: [1, 3, 1, 2, 1, 1], barre: true },
  m7: { rel: [0, 2, 0, 0, 0, 0], fingers: [1, 3, 1, 1, 1, 1], barre: true },
  maj7: { rel: [0, 2, 1, 1, 0, 0], fingers: [1, 4, 2, 3, 1, 1], barre: true },
  sus4: { rel: [0, 2, 2, 2, 0, 0], fingers: [1, 2, 3, 4, 1, 1], barre: true },
  '5': { rel: [0, 2, 2, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], barre: false },
};

/** Root on the 5th string (A shape). Open-chord origin: A, Am, A7, Am7, Amaj7, Asus4, A5. */
const A_SHAPES: Partial<Record<ChordQuality, BarreTemplate>> = {
  maj: { rel: [-1, 0, 2, 2, 2, 0], fingers: [0, 1, 2, 3, 4, 1], barre: true },
  min: { rel: [-1, 0, 2, 2, 1, 0], fingers: [0, 1, 3, 4, 2, 1], barre: true },
  '7': { rel: [-1, 0, 2, 0, 2, 0], fingers: [0, 1, 3, 1, 4, 1], barre: true },
  m7: { rel: [-1, 0, 2, 0, 1, 0], fingers: [0, 1, 3, 1, 2, 1], barre: true },
  maj7: { rel: [-1, 0, 2, 1, 2, 0], fingers: [0, 1, 3, 2, 4, 1], barre: true },
  sus4: { rel: [-1, 0, 2, 2, 3, 0], fingers: [0, 1, 2, 3, 4, 1], barre: true },
  '5': { rel: [-1, 0, 2, 2, -1, -1], fingers: [0, 1, 3, 4, 0, 0], barre: false },
};

/** Qualities the barre generator can produce. */
export const GENERABLE_QUALITIES: ChordQuality[] = ['maj', 'min', '7', 'm7', 'maj7', 'sus4', '5'];

export function canGenerateShape(quality: ChordQuality): boolean {
  return E_SHAPES[quality] !== undefined && A_SHAPES[quality] !== undefined;
}

/** Fret where a movable shape whose open root is `openPc` puts the root `root`; 1..12 (never the open position). */
function barreFretFor(root: number, openPc: number): number {
  const f = (((root - openPc) % 12) + 12) % 12;
  return f === 0 ? 12 : f;
}

function resolveSymbol(symbol: string | ChordSymbol): ChordSymbol | null {
  const sym = typeof symbol === 'string' ? parseChordSymbol(symbol) : symbol;
  if (!sym || sym.quality === 'nc' || sym.root < 0 || sym.root > 11) return null;
  return sym;
}

/**
 * Generates a barre chord from the E shape (root on the 6th string) or the A shape (root on the
 * 5th string), whichever sits lowest on the neck (barre fret >= 1). The slash bass, if any, is
 * ignored (the generated name is the root-position chord). null for non-generable qualities.
 */
export function generateBarreShape(symbol: string | ChordSymbol): ChordShape | null {
  const sym = resolveSymbol(symbol);
  if (!sym) return null;
  const e = E_SHAPES[sym.quality];
  const a = A_SHAPES[sym.quality];
  if (!e || !a) return null;
  const fe = barreFretFor(sym.root, 4); // open E shape root = E
  const fa = barreFretFor(sym.root, 9); // open A shape root = A
  const useE = fe <= fa;
  const tpl = useE ? e : a;
  const fret = useE ? fe : fa;
  const frets = tpl.rel.map((r) => (r < 0 ? -1 : fret + r));
  const shape: ChordShape = {
    name: rootNameOf(sym) + QUALITY_SUFFIX[sym.quality],
    frets,
    fingers: [...tpl.fingers],
    baseFret: computeBaseFret(frets),
    generated: true,
  };
  if (tpl.barre) {
    const barre: Barre = { fret, fromString: useE ? 0 : 1, toString: 5 };
    shape.barre = barre;
  }
  return shape;
}

/**
 * Fingering for a chord symbol (text or parsed). Library first, matched by root + quality + bass
 * so `A#` finds `Bb` and `CM7` finds `Cmaj7`; a slash chord not in the library falls back to the
 * root-position library voicing; otherwise a generated barre chord (`generated: true`).
 * null for 'nc', invalid syntax, or qualities the generator cannot build.
 * Library objects are shared: do not mutate the returned shape.
 */
export function getChordShape(symbol: string | ChordSymbol): ChordShape | null {
  const sym = resolveSymbol(symbol);
  if (!sym) return null;
  const exact = findLibraryShape(sym.root, sym.quality, sym.bass);
  if (exact) return exact;
  if (sym.bass !== null) {
    const rootPosition = findLibraryShape(sym.root, sym.quality, null);
    if (rootPosition) return rootPosition;
  }
  return generateBarreShape(sym);
}

// ---------------------------------------------------------------- sounding notes

/** MIDI notes of the sounding strings (6th to 1st) in standard tuning. */
export function shapeMidiNotes(shape: ChordShape): number[] {
  const out: number[] = [];
  const n = Math.min(6, shape.frets.length);
  for (let i = 0; i < n; i++) {
    const f = shape.frets[i];
    if (f >= 0) out.push(STANDARD_TUNING_MIDI[i] + f);
  }
  return out;
}

/** Unique ascending pitch classes sounded by the shape. */
export function shapePitchClasses(shape: ChordShape): number[] {
  const set = new Set<number>();
  for (const m of shapeMidiNotes(shape)) set.add(m % 12);
  return [...set].sort((a, b) => a - b);
}
