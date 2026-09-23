/**
 * Shared types — the contract between modules. Keep this file dependency-free.
 * String index convention everywhere: 0 = 6th string (low E), 5 = 1st string (high e).
 */

// ---------------------------------------------------------------- music

export type ChordQuality =
  | 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'dim' | 'dim7' | 'm7b5' | 'aug'
  | 'sus2' | 'sus4' | '7sus4' | 'add9' | '6' | 'm6' | '9' | '5' | 'nc';

export interface ChordSymbol {
  /** Original text as written by the user, e.g. "F#m7" */
  name: string;
  /** Pitch class of the root 0..11 (C = 0). -1 for 'nc' (no chord). */
  root: number;
  quality: ChordQuality;
  /** Pitch class of an alternate bass note (e.g. G/B -> 11), or null. */
  bass: number | null;
}

export interface Barre {
  fret: number;
  /** Inclusive string range covered by the barre (0 = low E). */
  fromString: number;
  toString: number;
}

export interface ChordShape {
  /** Canonical display name, e.g. "F#m" */
  name: string;
  /** 6 entries, index 0 = low E. -1 = muted, 0 = open, n = fret number (absolute). */
  frets: number[];
  /** 6 entries. 0 = none, 1 = index, 2 = middle, 3 = ring, 4 = pinky. */
  fingers: number[];
  /** First fret shown in the diagram (1 for open chords). */
  baseFret: number;
  barre?: Barre;
  /** True when produced by the barre generator rather than the library. */
  generated?: boolean;
}

// ---------------------------------------------------------------- song

export type StrumDirection = 'down' | 'up';

export interface StrumEvent {
  /** Index of this event within song.events */
  index: number;
  /** Absolute time in beats from the start of the song (float). */
  time: number;
  /** Chord symbol in effect at this event. quality 'nc' = no chord (skipped). */
  chord: ChordSymbol;
  direction: StrumDirection;
  barIndex: number;
  /** Beat within the bar, 0-based, may be fractional (0.5 = the "and"). */
  beatInBar: number;
  /** True for the first strum after a chord change (drawn with the chord name). */
  chordChange: boolean;
}

export interface TempoSegment {
  /** Beat at which this tempo starts. */
  fromBeat: number;
  bpm: number;
}

export interface SongBar {
  index: number;
  startBeat: number;
  beats: number;
  section: string | null;
  /** Chords held in this bar in order, with their duration in beats. */
  chords: Array<{ chord: ChordSymbol; startBeat: number; beats: number }>;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  /** Initial tempo, BPM. */
  tempo: number;
  tempoSegments: TempoSegment[];
  timeSignature: { beatsPerBar: number; beatUnit: number };
  capo: number;
  bars: SongBar[];
  events: StrumEvent[];
  /** Total length in beats (end of last bar). */
  totalBeats: number;
  /** Distinct chord names in order of first appearance. */
  chordNames: string[];
  /** The raw source text the song was parsed from. */
  source: string;
}

export interface ParseError {
  line: number; // 1-based
  message: string;
}

export interface ParseResult {
  song: Song;
  errors: ParseError[];
}

export interface StoredSong {
  id: string;
  title: string;
  artist: string;
  source: string;
  updatedAt: number;
  /** Bundled examples are read-only (Duplicate to edit). */
  builtin?: boolean;
}

// ---------------------------------------------------------------- dsp

export interface ChordTemplate {
  name: string;
  root: number;
  quality: ChordQuality;
  /** L2-normalised 12-bin template. */
  vector: Float32Array;
}

export interface ChordMatch {
  name: string;
  score: number;
}

export interface DetectorFrame {
  /** Time (seconds, AudioContext clock) of the END of the analysed frame. */
  timeSec: number;
  /** RMS level in dBFS. */
  rmsDb: number;
  /** True when this frame contains an attack (strum) onset. */
  onset: boolean;
  /** L2-normalised 12-bin chroma (all zeros when below the gate). */
  chroma: Float32Array;
  /** Best matching chord from the vocabulary, or null when gated by silence. */
  bestChord: ChordMatch | null;
}

/** Anything that can deliver DetectorFrames (the real mic pipeline or a test fake). */
export interface DetectorSource {
  onFrame(cb: (frame: DetectorFrame) => void): () => void; // returns unsubscribe
}

// ---------------------------------------------------------------- game

export type VerdictKind = 'correct' | 'wrong' | 'missed' | 'skipped';
export type TimingLabel = 'perfect' | 'good' | 'early' | 'late' | null;

export interface Verdict {
  eventIndex: number;
  kind: VerdictKind;
  /** onset - expected, in seconds (undefined when missed/skipped). */
  timing?: number;
  timingLabel: TimingLabel;
  /** Name of the chord the detector heard when kind === 'wrong'. */
  detected?: string;
  /** Similarity score of the expected chord in the analysed window. */
  expectedScore?: number;
  points: number;
}

export type SessionPhase = 'idle' | 'countin' | 'playing' | 'paused' | 'ended';

export interface SessionSummary {
  total: number;
  correct: number;
  wrong: number;
  missed: number;
  skipped: number;
  /** correct / (total - skipped), 0..1 */
  accuracy: number;
  score: number;
  bestStreak: number;
  perChord: Record<string, { total: number; correct: number }>;
}

export interface SessionState {
  phase: SessionPhase;
  /** Song time in seconds (negative during count-in). */
  songTimeSec: number;
  /** Song position in beats (negative during count-in). */
  beat: number;
  /** Index of the next event not yet reached (events[i].time > beat). */
  nextEventIndex: number;
  verdicts: (Verdict | undefined)[];
  score: number;
  streak: number;
  /** Live detector info for the HUD. */
  live: { rmsDb: number; bestChord: ChordMatch | null; listening: boolean };
  /** Count-in beats remaining (4,3,2,1) during 'countin', else 0. */
  countInBeatsLeft: number;
  summary: SessionSummary | null;
}

// ---------------------------------------------------------------- settings

export interface Settings {
  /** Input latency compensation in seconds (subtracted from detected onset times). */
  latencySec: number;
  /** Onset threshold multiplier (spectral flux vs adaptive median). */
  onsetThreshold: number;
  /** Silence gate in dBFS. */
  gateDb: number;
  a4: number;
  inputDeviceId: string | null;
  metronome: boolean;
  listen: boolean;
  /** Playback speed multiplier, 0.5..1.2 */
  tempoScale: number;
  /** Judge tolerances in seconds. */
  earlySec: number;
  lateSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  latencySec: 0.06,
  onsetThreshold: 1.5,
  gateDb: -50,
  a4: 440,
  inputDeviceId: null,
  metronome: true,
  listen: true,
  tempoScale: 1,
  earlySec: 0.15,
  lateSec: 0.25,
};
