/**
 * Shared types — the contract between modules. Keep this file dependency-free.
 * This file is the source of truth: where docs/SPEC.md and this file disagree, this file wins.
 *
 * String index convention everywhere: 0 = 6th string (low E), 5 = 1st string (high e).
 *
 * Time bases:
 *  - "beats": song position in beats (1 beat = 1/beatUnit note), float, negative during count-in.
 *  - "song seconds": beatToSec(tempoSegments, beat), NOT scaled by tempoScale.
 *  - "wall seconds" / "clock": Clock.now() — in the browser this is AudioContext.currentTime,
 *    the SAME clock that stamps DetectorFrame.timeSec. All judging (onsets, tolerances,
 *    latency, chroma windows) happens in wall seconds and never scales with tempoScale.
 */

// ---------------------------------------------------------------- music

export type ChordQuality =
  | 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'dim' | 'dim7' | 'm7b5' | 'aug'
  | 'sus2' | 'sus4' | '7sus4' | 'add9' | '6' | 'm6' | '9' | '5' | 'nc';

export interface ChordSymbol {
  /** Original text as written by the user, e.g. "F#m7". '-' for a rest, 'N.C.' for no chord. */
  name: string;
  /** Pitch class of the root 0..11 (C = 0). -1 for 'nc' (no chord / rest). */
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
  /** Chord symbol in effect at this event. quality 'nc' = no chord (skipped, ball still bounces). */
  chord: ChordSymbol;
  /** Muted strums ('x' in the pattern) are 'down'. */
  direction: StrumDirection;
  /** True for 'x' (percussive muted strum): judged on timing only, drawn as an X. */
  muted: boolean;
  barIndex: number;
  /** Beat within the bar, 0-based, may be fractional (0.5 = the "and"). */
  beatInBar: number;
  /** True for the first strum after a chord change (drawn as a full column with the chord name). */
  chordChange: boolean;
}

export interface TempoSegment {
  /**
   * Beat at which this tempo starts. Invariants (guaranteed by the parser): tempoSegments is
   * non-empty, sorted by strictly increasing fromBeat, and tempoSegments[0].fromBeat === 0.
   * For beat < 0 (count-in) tempo.ts extrapolates linearly with tempoSegments[0].
   */
  fromBeat: number;
  /** Beats (1/beatUnit notes) per minute. */
  bpm: number;
}

export interface SongBar {
  index: number;
  startBeat: number;
  beats: number;
  section: string | null;
  /** Chords held in this bar in order, with their duration in beats. Rests use quality 'nc', name '-'. */
  chords: Array<{ chord: ChordSymbol; startBeat: number; beats: number }>;
}

export interface LyricLine {
  /** Index of the first bar of the bar line this lyric belongs to (0 if none yet). */
  barIndex: number;
  text: string;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  /** Initial tempo in beats (1/beatUnit notes) per minute. Always equals tempoSegments[0].bpm. */
  tempo: number;
  tempoSegments: TempoSegment[];
  /** Initial time signature. beatUnit 4 => beat = quarter note; 8 => beat = eighth note. */
  timeSignature: { beatsPerBar: number; beatUnit: number };
  /** Capo fret. Detection is transposed so chords are judged in written space. */
  capo: number;
  bars: SongBar[];
  events: StrumEvent[];
  /** Total length in beats (end of last bar). */
  totalBeats: number;
  /** Distinct chord names (as written) in order of first appearance; excludes rests and N.C. */
  chordNames: string[];
  lyricLines: LyricLine[];
  /** The raw (unexpanded) source text the song was parsed from. */
  source: string;
}

export interface ParseError {
  line: number; // 1-based
  message: string;
  /** 'error' discards the affected bar/line; 'warning' keeps it. */
  severity: 'error' | 'warning';
}

export interface ParseResult {
  song: Song;
  errors: ParseError[];
}

/** Metadata of the backing audio file attached to a song (the blob itself lives in IndexedDB, see song/audioStore.ts). */
export interface AudioTrackInfo {
  name: string;
  type: string;
  size: number;
  durationSec: number;
  /** Seconds into the audio where beat 0 (start of bar 1) falls. Negative if the chart starts before the audio. */
  offsetSec: number;
  /** Linear playback gain 0..1 (default 0.8). */
  gain: number;
}

export interface StoredSong {
  id: string;
  title: string;
  artist: string;
  source: string;
  updatedAt: number;
  /** Bundled examples are read-only (Duplicate to edit). */
  builtin?: boolean;
  /** Backing track metadata, or null/undefined when the song has no audio. */
  audio?: AudioTrackInfo | null;
}

/** One beat of an automatic chord transcription (dsp/chordTranscribe.ts). */
export interface TranscribedBeat {
  timeSec: number;
  /** Chord name in sharp spelling (e.g. 'F#m'), or null for no chord (N.C.). */
  chord: string | null;
  /** Emission score of the chosen chord in this beat, 0..1. */
  score: number;
}

export interface TranscribedBar {
  /** Index of the first beat of the bar within `beats`. */
  startBeat: number;
  /** Chords in order with their duration in beats (merged consecutive equal chords). */
  chords: Array<{ chord: string | null; beats: number }>;
}

export interface TranscribedSection {
  /** Inclusive bar range (bar indices into the transcription). */
  startBar: number;
  endBar: number;
  /** Spanish label: 'Intro' | 'Estrofa' | 'Estribillo' | 'Puente' | 'Final' | 'Parte A'... */
  label: string;
  /** Structural letter (A, B, C...) shared by repeated sections. */
  letter: string;
}

export interface ChordTranscription {
  bpm: number;
  beatsPerBar: number;
  /** Seconds into the audio of the first downbeat (start of bar 1). */
  firstDownbeatSec: number;
  key: { root: number; mode: 'major' | 'minor'; name: string };
  beats: TranscribedBeat[];
  bars: TranscribedBar[];
  /** Mean over beats of (best - second best emission score), clamped 0..1. */
  confidence: number;
  /** Tempo (bpm) of each bar from the tracked beats; absent when the grid was constant. */
  barTempos?: number[];
  /** Detected structure; absent when segmentation was not run or found a single section. */
  sections?: TranscribedSection[];
}

/** Result of dsp/strumDetect.ts: the strumming pattern heard in the audio. */
export interface StrumDetection {
  /** Pattern in the song grammar (D/U/-), charsPerBeat * beatsPerBar characters long. */
  pattern: string;
  charsPerBeat: 1 | 2 | 4;
  /** Mean onset strength per slot of the bar, normalised to the strongest slot (0..1). */
  slotStrength: number[];
  /** Fraction of bars whose active slots agree with the pattern, 0..1. */
  confidence: number;
  /** Number of bars analysed. */
  bars: number;
}

/** Result of dsp/tempoEstimate.ts. */
export interface TempoEstimate {
  bpm: number;
  beatPeriodSec: number;
  /** Seconds into the audio of the first detected beat (a beat, not necessarily a downbeat). */
  firstBeatSec: number;
  /** 0..1 — peak of the autocorrelation relative to its mean over the search range. */
  confidence: number;
}

// ---------------------------------------------------------------- dsp

export interface ChordTemplate {
  name: string;
  root: number;
  quality: ChordQuality;
  /** Pitch classes of the chord notes (no harmonics), sorted ascending, unique. */
  pcs: number[];
  /** 12-bin template, same compression path as chroma, L2-normalised. */
  vector: Float32Array;
}

export interface ChordMatch {
  name: string;
  score: number;
}

export interface DetectorOpts {
  /** Default 8192. MUST equal MicInput.fftSize. */
  fftSize?: number;
  /** Default 440. */
  a4?: number;
  /** Lower bound of the silence gate in dBFS (default -50). Effective gate = max(gateDb, noiseFloor + 10). */
  gateDb?: number;
  /** Onset threshold multiplier over the adaptive median flux (default 1.5). */
  onsetThreshold?: number;
  /** Nominal hop between frames in seconds (default 0.04); the real delta between timeSec values is used when available. */
  hopSeconds?: number;
  /** Log-compression strength gamma for chroma (default 10). */
  gamma?: number;
}

export interface DetectorFrame {
  /** RAW time (wall seconds, AudioContext clock) of the END of the analysed frame. Never latency-corrected here. */
  timeSec: number;
  /** RMS level in dBFS. */
  rmsDb: number;
  /** True when this frame contains an accepted attack (strum) onset. */
  onset: boolean;
  /** Refined onset time (wall seconds) located inside the frame; only set when onset === true. */
  onsetTimeSec?: number;
  /** Energy chroma (octave-weighted, peak-picked, in written space after transpose), NOT compressed, NOT normalised. Zeros when gated. */
  energyChroma: Float32Array;
  /** Compressed + L2-normalised 12-bin chroma (all zeros when gated by silence). */
  chroma: Float32Array;
  /** Best matching vocabulary chord (cosmetic, for the HUD), or null when gated. */
  bestChord: ChordMatch | null;
}

/** Anything that can deliver DetectorFrames (the real mic pipeline or a test fake). */
export interface DetectorSource {
  onFrame(cb: (frame: DetectorFrame) => void): () => void; // returns unsubscribe
}

// ---------------------------------------------------------------- game

/** Seconds. MUST be the same clock as DetectorFrame.timeSec (AudioContext.currentTime in the browser). */
export interface Clock {
  now(): number;
}

/** Metronome implements this. Times are nominal (when the click should be HEARD), on the Clock. */
export interface ClickScheduler {
  scheduleClick(timeSec: number, accent: boolean): void;
  clear(): void;
}

export interface SessionDeps {
  clock: Clock;
  /** Absent or settings.metronome === false -> no clicks. */
  clicks?: ClickScheduler;
  /** Absent or settings.listen === false -> every verdict is 'skipped'. */
  detector?: DetectorSource;
  settings: Settings;
  /** Resolved once by the screen: getChordShape(name) for each song.chordNames (key = name as written). */
  shapes: Record<string, ChordShape | null>;
}

export type VerdictKind = 'correct' | 'wrong' | 'missed' | 'skipped';
export type TimingLabel = 'perfect' | 'good' | 'early' | 'late' | null;

export interface Verdict {
  eventIndex: number;
  kind: VerdictKind;
  /** onset - expected, in real (wall) seconds, latency already compensated. Only when kind === 'correct' or 'wrong'. */
  timing?: number;
  /** Only non-null when kind === 'correct'. */
  timingLabel: TimingLabel;
  /** Name of the chord the detector heard when kind === 'wrong'. */
  detected?: string;
  /** Cosine score of the expected chord in the analysed window (whenever chroma was analysed). */
  expectedScore?: number;
  points: number;
}

/** Emitted immediately when an onset is assigned to an event (before the chord verdict). */
export interface Hit {
  eventIndex: number;
  /** onset - expected, wall seconds. */
  timing: number;
  timingLabel: Exclude<TimingLabel, null>;
}

/** Inputs to judgeEvent. All times are wall seconds (same clock as DetectorFrame.timeSec). */
export interface JudgeInput {
  eventIndex: number;
  chord: ChordSymbol;
  muted: boolean;
  /** Expected onset time in wall seconds = wallSec(event.time) + settings.latencySec. */
  expectedSec: number;
  /** Pitch classes of the expected voicing (shapePitchClasses(shape), else chordPitchClasses(chord)). Empty for 'nc'. */
  expectedPcs: number[];
  /** Template built from expectedPcs via templateForPitchClasses; null for 'nc'. */
  expectedTemplate: ChordTemplate | null;
}

export interface Evidence {
  /** The onset assigned to this event (wall seconds, RAW detector time), or null when none fell in the window. */
  onset: number | null;
  /** The next detected onset after `onset` (wall seconds), or null; used to cap the analysis window. */
  nextOnset: number | null;
  /**
   * Mean energy chroma over detector frames fully inside [t0, t1] (frame.start >= t0 && frame.end <= t1),
   * or the single frame with the largest overlap when none fits; then compressed + L2-normalised
   * exactly like DetectorFrame.chroma. All zeros when every frame in range was gated.
   */
  chromaAt(t0: number, t1: number): Float32Array;
}

export interface JudgeOpts {
  earlySec: number;
  lateSec: number;
  /** Default 0.3. Analysis window after the onset, in wall seconds. */
  analysisWindowSec: number;
  /** Default 0.6. Minimum cosine score of the expected template for 'correct'. */
  minScore: number;
  /** Tie-break margin for the superset/third checks (judge.ts rules 8-9); scales with difficulty. */
  mismatchMargin: number;
  /** |timing| <= perfectSec -> 'perfect' (default 0.07); <= goodSec -> 'good' (default 0.15). */
  perfectSec: number;
  goodSec: number;
  /** Vocabulary from buildTemplates(), built once per session. */
  templates: ChordTemplate[];
}

/** The judge is pure: it fills every Verdict field except points (the engine adds points). */
export type JudgeResult = Omit<Verdict, 'points'>;

export type SessionPhase = 'idle' | 'countin' | 'playing' | 'paused' | 'ended';

export interface LoopRange {
  /** Inclusive bar indices. */
  fromBar: number;
  toBar: number;
}

export interface SessionSummary {
  /** song.events.length x passes (events judged in every pass, including the partial one in progress). */
  total: number;
  correct: number;
  wrong: number;
  missed: number;
  skipped: number;
  /** judged = total - skipped; accuracy = judged > 0 ? correct / judged : 0. */
  accuracy: number;
  score: number;
  bestStreak: number;
  /** Number of passes (>= 1; > 1 only with a loop). */
  passes: number;
  /** Median of Verdict.timing over 'correct' verdicts, or null when fewer than 4. */
  medianTimingSec: number | null;
  /** Keyed by event.chord.name (as written). total excludes skipped. */
  perChord: Record<string, { total: number; correct: number }>;
}

export interface SessionState {
  phase: SessionPhase;
  /** Song time in seconds (negative during count-in). Not scaled by tempoScale. */
  songTimeSec: number;
  /** Song position in beats (negative during count-in). */
  beat: number;
  /** Index of the next event not yet reached (events[i].time > beat). */
  nextEventIndex: number;
  /** Always song.events.length long, indexed by event.index; undefined = not judged yet (cleared from the resume/seek bar onwards). */
  verdicts: (Verdict | undefined)[];
  /** Parallel to verdicts; set as soon as an onset is assigned to the event. */
  hits: (Hit | undefined)[];
  score: number;
  streak: number;
  /** Live detector info for the HUD. */
  live: { rmsDb: number; bestChord: ChordMatch | null; listening: boolean; gateDb: number };
  /** Count-in beats remaining, beatsPerBar..1 during 'countin' (= ceil(-relativeBeat)), else 0. */
  countInBeatsLeft: number;
  /** Beat at which the current/last count-in started (= startBeat - beatsPerBar of the start bar). 0 before any start. */
  countInStartBeat: number;
  loop: LoopRange | null;
  /** 1-based pass counter (increments each time the loop restarts). */
  pass: number;
  summary: SessionSummary | null;
}

export type SessionEvents = {
  hit: Hit;
  verdict: Verdict;
  phase: SessionPhase;
  ended: { summary: SessionSummary; reason: 'finished' | 'stopped' };
};

// ---------------------------------------------------------------- ui

/** A routed screen. mount() renders into root and returns its unmount/cleanup function. */
export interface Screen {
  mount(root: HTMLElement, params: Record<string, string>): () => void;
}

// ---------------------------------------------------------------- settings

export interface Settings {
  /** Input latency compensation in wall seconds (added to the expected time / subtracted from onsets). -0.1..0.5 */
  latencySec: number;
  /** Onset threshold multiplier (spectral flux vs adaptive median). Lower = more sensitive. */
  onsetThreshold: number;
  /** Lower bound of the silence gate in dBFS (effective gate = max(gateDb, noiseFloor + 10)). */
  gateDb: number;
  a4: number;
  inputDeviceId: string | null;
  metronome: boolean;
  listen: boolean;
  /** Playback speed multiplier, 0.5..1.2 */
  tempoScale: number;
  /** Judge tolerances in wall seconds (never scaled by tempoScale). */
  earlySec: number;
  lateSec: number;
  /** Semitones the guitar is tuned away from standard (e.g. -1 for Eb tuning). Added to song.capo for detection. */
  tuningOffset: number;
  /** Draw the 6th string on top (player's view) instead of tab order (1st on top). */
  invertStrings: boolean;
  /** Play the song's backing track (when the song has one) during practice. */
  backingTrack: boolean;
  /** What plays as the backing track: the uploaded recording, or a synthesized chords-only version (audio/chordSynth.ts). */
  backingSource: 'audio' | 'chords';
  /** Ask the browser for echo cancellation on the mic (helps when the backing track plays through speakers). */
  echoCancellation: boolean;
  /**
   * How closely a strum must match the expected chord to count as 'correct' (game/judge.ts's
   * minScore + mismatchMargin). 'normal' already forgives real-world noise; 'lenient' forgives a
   * lot more — closer to "you're at least attempting the right chord" than a precise match.
   */
  chordTolerance: 'normal' | 'lenient';
}

export const DEFAULT_SETTINGS: Settings = {
  latencySec: 0.06,
  // 1.2, not the DSP module's own 1.5 (dsp/detector.ts's DEFAULTS, tuned for its own tests):
  // a real beginner's strum through a real (often weak/noisy) mic needs a more forgiving default
  // than a lab-clean signal, so onsets aren't silently missed. Still adjustable in Ajustes.
  onsetThreshold: 1.2,
  gateDb: -50,
  a4: 440,
  inputDeviceId: null,
  metronome: true,
  listen: true,
  tempoScale: 1,
  earlySec: 0.15,
  lateSec: 0.25,
  tuningOffset: 0,
  invertStrings: false,
  backingTrack: true,
  backingSource: 'audio',
  echoCancellation: false,
  chordTolerance: 'normal',
};
