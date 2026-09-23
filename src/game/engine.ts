/**
 * PracticeSession — the practice engine (SPEC.md section 7, engine.ts).
 *
 * Owns the beat/wall clock (anchored on every start, scaled by tempoScale), the phases
 * (idle / countin / playing / paused / ended), the metronome look-ahead scheduling, the
 * evidence buffers fed by DetectorFrames (chroma ring buffer + onset list), the one-to-one
 * onset -> event assignment ('hit'), the verdict triggers (judgeEvent / missed / skipped),
 * points, streak, loop passes and the final summary.
 *
 * No timers: the screen calls update() on every animation frame; tests drive it with a fake
 * Clock. All judging happens in wall seconds (the clock that stamps DetectorFrame.timeSec):
 * tolerances, latency and analysis windows never scale with tempoScale.
 */
import type {
  ChordSymbol,
  ChordTemplate,
  DetectorFrame,
  Evidence,
  Hit,
  JudgeInput,
  JudgeOpts,
  JudgeResult,
  LoopRange,
  SessionDeps,
  SessionEvents,
  SessionPhase,
  SessionState,
  SessionSummary,
  Settings,
  Song,
  StrumEvent,
  Verdict,
} from '../types';
import { beatToSec, secToBeat } from '../song/tempo';
import { buildTemplates, compressChroma, templateForPitchClasses } from '../dsp/chroma';
import { chordPitchClasses } from '../music/notes';
import { shapePitchClasses } from '../music/chords';
import { DEFAULT_JUDGE_OPTS, analysisWindow, judgeEvent, timingLabelFor } from './judge';

/** The clock is anchored this long after the call that starts a pass. */
export const ANCHOR_LEAD_SEC = 0.1;
/** Metronome clicks are scheduled this far ahead of the clock. */
export const CLICK_LOOKAHEAD_SEC = 0.5;
/** Length of the evidence ring buffer (frames older than this are dropped). */
export const EVIDENCE_RING_SEC = 3;
/** Default analysed frame length: 8192 samples at 48 kHz. */
export const DEFAULT_FRAME_SECONDS = 8192 / 48000;
/** Extra margin after the last judging window before the song / loop pass is over. */
export const END_MARGIN_SEC = 0.1;
/** 'missed' when the last received frame ends this long after the event window. */
export const MISSED_FRAME_MARGIN_SEC = 0.05;
/** 'missed' fallback on the clock when no frames arrive. */
export const MISSED_CLOCK_MARGIN_SEC = 0.5;
/** Clicks whose nominal time is already this far in the past are not scheduled. */
const CLICK_PAST_TOLERANCE_SEC = 0.05;

export interface SessionOptions {
  /** Length of one analysed detector frame in seconds (fftSize / sampleRate). Default 8192/48000. */
  frameSeconds?: number;
}

interface EvidenceFrame {
  start: number;
  end: number;
  energyChroma: Float32Array;
  gated: boolean;
}

interface ExpectedInfo {
  pcs: number[];
  template: ChordTemplate | null;
}

interface PerChord {
  total: number;
  correct: number;
}

/** Counters of the passes already completed (the current pass lives in state.verdicts). */
interface Accumulated {
  total: number;
  correct: number;
  wrong: number;
  missed: number;
  skipped: number;
  score: number;
  timings: number[];
  perChord: Record<string, PerChord>;
}

type Listener<K extends keyof SessionEvents> = (e: SessionEvents[K]) => void;

/** Duck-typed access to the effective gate of the real detector pipeline (MicDetectorSource). */
interface GateProvider {
  getGateDb?: () => number;
  detector?: { getGateDb?: () => number };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** First index whose event time is >= beat (events sorted by time). */
function lowerBound(events: StrumEvent[], beat: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose event time is > beat. */
function upperBound(events: StrumEvent[], beat: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class PracticeSession {
  readonly song: Song;

  private readonly deps: SessionDeps;
  private settings: Settings;
  private readonly frameSeconds: number;
  private readonly judgeOpts: JudgeOpts;
  private readonly expectedCache = new Map<string, ExpectedInfo>();
  private readonly barStarts = new Set<number>();
  private readonly listeners = new Map<keyof SessionEvents, Set<Listener<keyof SessionEvents>>>();
  private unsubscribeDetector: (() => void) | null = null;

  private readonly state: SessionState;

  // Clock anchors (wall seconds / beats).
  private anchorBeat = 0;
  private anchorWall = 0;
  private startBeat = 0;
  /** Position the next resume/start plays from (bar containing it). */
  private pausedBeat = 0;
  /** Lowest start beat of the current pass (events below it are not part of the pass). */
  private passStartBeat = 0;
  private lastScheduledBeat = -Infinity;

  // Evidence.
  private readonly frames: EvidenceFrame[] = [];
  private readonly onsets: number[] = [];
  private lastFrameEnd = -Infinity;
  private readonly assignedOnset: (number | undefined)[];
  /** First event index (in order) whose verdict is still pending. */
  private verdictCursor = 0;

  // Scoring.
  private bestStreak = 0;
  /** Streak carried over from completed passes. */
  private baseStreak = 0;
  private readonly acc: Accumulated = {
    total: 0,
    correct: 0,
    wrong: 0,
    missed: 0,
    skipped: 0,
    score: 0,
    timings: [],
    perChord: {},
  };

  constructor(song: Song, deps: SessionDeps, opts: SessionOptions = {}) {
    this.song = song;
    this.deps = deps;
    this.settings = { ...deps.settings };
    this.frameSeconds = opts.frameSeconds !== undefined && opts.frameSeconds > 0 ? opts.frameSeconds : DEFAULT_FRAME_SECONDS;
    this.judgeOpts = {
      ...DEFAULT_JUDGE_OPTS,
      earlySec: this.settings.earlySec,
      lateSec: this.settings.lateSec,
      templates: buildTemplates(),
    };
    for (const bar of song.bars) this.barStarts.add(bar.startBeat);

    const n = song.events.length;
    this.assignedOnset = new Array<number | undefined>(n).fill(undefined);
    this.state = {
      phase: 'idle',
      songTimeSec: 0,
      beat: 0,
      nextEventIndex: 0,
      verdicts: new Array<Verdict | undefined>(n).fill(undefined),
      hits: new Array<Hit | undefined>(n).fill(undefined),
      score: 0,
      streak: 0,
      live: { rmsDb: -100, bestChord: null, listening: this.isListening(), gateDb: this.currentGateDb() },
      countInBeatsLeft: 0,
      loop: null,
      pass: 1,
      summary: null,
    };

    if (deps.detector) {
      this.unsubscribeDetector = deps.detector.onFrame((frame) => this.onFrame(frame));
    }
  }

  // ---------------------------------------------------------------- events

  on<K extends keyof SessionEvents>(k: K, cb: (e: SessionEvents[K]) => void): () => void {
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    const listener = cb as Listener<keyof SessionEvents>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<K extends keyof SessionEvents>(k: K, e: SessionEvents[K]): void {
    const set = this.listeners.get(k);
    if (!set) return;
    for (const cb of Array.from(set)) cb(e);
  }

  private setPhase(phase: SessionPhase): void {
    if (this.state.phase === phase) return;
    this.state.phase = phase;
    this.emit('phase', phase);
  }

  // ---------------------------------------------------------------- clock

  private songSec(beat: number): number {
    return beatToSec(this.song.tempoSegments, beat);
  }

  /** Wall time of a song beat in the current pass. */
  wallSec(beat: number): number {
    return this.anchorWall + (this.songSec(beat) - this.songSec(this.anchorBeat)) / this.settings.tempoScale;
  }

  /** Song beat at a wall time (clamped at the anchor during the lead-in). */
  private beatAt(now: number): number {
    const beat = secToBeat(this.song.tempoSegments, this.songSec(this.anchorBeat) + (now - this.anchorWall) * this.settings.tempoScale);
    return beat < this.anchorBeat ? this.anchorBeat : beat;
  }

  /** Expected onset time (wall seconds) of an event, latency included. */
  expectedSec(event: StrumEvent): number {
    return this.wallSec(event.time) + this.settings.latencySec;
  }

  private barIndexAt(beat: number): number {
    const bars = this.song.bars;
    if (bars.length === 0) return 0;
    let index = 0;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].startBeat <= beat) index = i;
      else break;
    }
    return index;
  }

  private clampBar(n: number): number {
    const last = this.song.bars.length - 1;
    if (last < 0 || !Number.isFinite(n)) return 0;
    const i = Math.floor(n);
    return i < 0 ? 0 : i > last ? last : i;
  }

  private loopEndBeat(range: LoopRange): number {
    const bar = this.song.bars[this.clampBar(range.toBar)];
    return bar ? bar.startBeat + bar.beats : this.song.totalBeats;
  }

  /** End (exclusive) of the current pass: loop end or song end. */
  private passEndBeat(): number {
    return this.state.loop ? this.loopEndBeat(this.state.loop) : this.song.totalBeats;
  }

  /** Time after which every event of the pass has had its chance to be judged. */
  private passOverWall(endBeat: number): number {
    return (
      this.wallSec(endBeat) +
      this.settings.latencySec +
      this.settings.lateSec +
      this.judgeOpts.analysisWindowSec +
      END_MARGIN_SEC
    );
  }

  // ---------------------------------------------------------------- settings / deps

  private isListening(): boolean {
    return this.deps.detector !== undefined && this.settings.listen;
  }

  private currentGateDb(): number {
    const d = this.deps.detector as unknown as GateProvider | undefined;
    if (d) {
      const own = d.getGateDb;
      if (typeof own === 'function') {
        const g = own.call(d);
        if (Number.isFinite(g)) return g;
      }
      const inner = d.detector?.getGateDb;
      if (typeof inner === 'function') {
        const g = inner.call(d.detector);
        if (Number.isFinite(g)) return g;
      }
    }
    return this.settings.gateDb;
  }

  /** Live settings: metronome / listen / tolerances / latency apply at once; tempoScale only when idle or paused. */
  setSettings(patch: Partial<Settings>): void {
    if (this.state.phase === 'ended') return;
    const next: Settings = { ...this.settings, ...patch };
    if (this.state.phase !== 'idle' && this.state.phase !== 'paused') next.tempoScale = this.settings.tempoScale;
    const metronomeWasOn = this.settings.metronome;
    this.settings = next;
    this.judgeOpts.earlySec = next.earlySec;
    this.judgeOpts.lateSec = next.lateSec;
    if (metronomeWasOn && !next.metronome) this.deps.clicks?.clear();
    this.state.live.listening = this.isListening();
    this.state.live.gateDb = this.currentGateDb();
  }

  getSettings(): Settings {
    return this.settings;
  }

  private expectedFor(chord: ChordSymbol): ExpectedInfo {
    if (chord.quality === 'nc') return { pcs: [], template: null };
    const cached = this.expectedCache.get(chord.name);
    if (cached) return cached;
    const shape = this.deps.shapes[chord.name];
    const pcs = shape ? shapePitchClasses(shape) : chordPitchClasses(chord);
    const info: ExpectedInfo = {
      pcs,
      template: pcs.length > 0 ? templateForPitchClasses(pcs, chord.name, chord.root, chord.quality) : null,
    };
    this.expectedCache.set(chord.name, info);
    return info;
  }

  // ---------------------------------------------------------------- phases

  /** Starts from `fromBar` (default: the bar chosen with seekBar, initially 0). Only in 'idle'. */
  start(fromBar?: number): void {
    if (this.state.phase !== 'idle') return;
    const bar = fromBar === undefined ? this.barIndexAt(Math.max(0, this.pausedBeat)) : this.clampBar(fromBar);
    this.playFrom(bar, true);
  }

  /** Freezes the clock. Only in 'countin' / 'playing'. */
  pause(): void {
    const phase = this.state.phase;
    if (phase !== 'countin' && phase !== 'playing') return;
    const beat = this.beatAt(this.deps.clock.now());
    this.state.beat = beat;
    this.state.songTimeSec = this.songSec(beat);
    this.pausedBeat = phase === 'countin' ? this.startBeat : beat;
    this.state.countInBeatsLeft = 0;
    this.deps.clicks?.clear();
    this.setPhase('paused');
  }

  /** Count-in of one bar, then the bar that was playing is repeated in full. Only in 'paused'. */
  resume(): void {
    if (this.state.phase !== 'paused') return;
    this.playFrom(this.barIndexAt(Math.max(0, this.pausedBeat)), false);
  }

  /** Sets the position without starting. Only in 'idle' / 'paused'. */
  seekBar(n: number): void {
    const phase = this.state.phase;
    if (phase !== 'idle' && phase !== 'paused') return;
    if (this.song.bars.length === 0) return;
    const bar = this.song.bars[this.clampBar(n)];
    const startBeat = bar.startBeat;
    this.pausedBeat = startBeat;
    const events = this.song.events;
    for (let i = 0; i < events.length; i++) {
      if (events[i].time >= startBeat) {
        this.clearEvent(i);
      } else if (this.state.verdicts[i] === undefined) {
        this.state.verdicts[i] = { eventIndex: i, kind: 'skipped', timingLabel: null, points: 0 };
      }
    }
    this.recomputeScoring();
    this.state.beat = startBeat;
    this.state.songTimeSec = this.songSec(startBeat);
    this.state.nextEventIndex = upperBound(events, startBeat);
  }

  /** Loop over inclusive bar indices (null = no loop). Any phase but 'ended'. */
  setLoop(range: LoopRange | null): void {
    if (this.state.phase === 'ended') return;
    if (range === null || this.song.bars.length === 0) {
      this.state.loop = null;
      return;
    }
    let from = this.clampBar(range.fromBar);
    let to = this.clampBar(range.toBar);
    if (to < from) [from, to] = [to, from];
    this.state.loop = { fromBar: from, toBar: to };
  }

  /** Ends the session now (summary of what was played). Any phase but 'ended'. */
  stop(): void {
    if (this.state.phase === 'ended') return;
    this.finish('stopped');
  }

  private clearEvent(i: number): void {
    this.state.verdicts[i] = undefined;
    this.state.hits[i] = undefined;
    this.assignedOnset[i] = undefined;
  }

  /**
   * Anchors the clock one bar before `barIndex` and starts the count-in. Clears verdicts,
   * hits and evidence from that bar on. `newPass` marks the start of a pass (start / loop).
   */
  private playFrom(barIndex: number, newPass: boolean): void {
    const bar = this.song.bars[this.clampBar(barIndex)];
    const startBeat = bar ? bar.startBeat : 0;
    const beats = bar ? bar.beats : this.song.timeSignature.beatsPerBar;
    const events = this.song.events;

    for (let i = 0; i < events.length; i++) if (events[i].time >= startBeat) this.clearEvent(i);
    this.frames.length = 0;
    this.onsets.length = 0;
    this.lastFrameEnd = -Infinity;
    this.recomputeScoring();

    this.startBeat = startBeat;
    this.pausedBeat = startBeat;
    if (newPass) this.passStartBeat = startBeat;
    else if (startBeat < this.passStartBeat) this.passStartBeat = startBeat;
    this.anchorBeat = startBeat - beats;
    this.anchorWall = this.deps.clock.now() + ANCHOR_LEAD_SEC;
    this.lastScheduledBeat = Math.ceil(this.anchorBeat) - 1;
    this.deps.clicks?.clear();

    this.verdictCursor = lowerBound(events, startBeat);
    this.state.beat = this.anchorBeat;
    this.state.songTimeSec = this.songSec(this.anchorBeat);
    this.state.nextEventIndex = upperBound(events, this.anchorBeat);
    this.state.countInBeatsLeft = Math.ceil(startBeat - this.anchorBeat);
    this.setPhase('countin');
  }

  /** Walks the current verdicts: score (over the accumulated), streak and best streak. */
  private recomputeScoring(): void {
    let score = this.acc.score;
    let streak = this.baseStreak;
    let best = this.bestStreak;
    for (const v of this.state.verdicts) {
      if (!v) continue;
      score += v.points;
      if (v.kind === 'correct') {
        streak++;
        if (streak > best) best = streak;
      } else if (v.kind === 'wrong' || v.kind === 'missed') {
        streak = 0;
      }
    }
    this.state.score = score;
    this.state.streak = streak;
    this.bestStreak = best;
  }

  /** Folds the verdicts of the pass into the accumulated counters and clears them. */
  private dumpPass(): void {
    const events = this.song.events;
    for (let i = 0; i < events.length; i++) {
      const v = this.state.verdicts[i];
      if (!v) continue;
      this.acc.total++;
      this.acc.score += v.points;
      if (v.kind === 'correct') {
        this.acc.correct++;
        if (v.timing !== undefined) this.acc.timings.push(v.timing);
      } else if (v.kind === 'wrong') this.acc.wrong++;
      else if (v.kind === 'missed') this.acc.missed++;
      else this.acc.skipped++;
      if (v.kind !== 'skipped') {
        const name = events[i].chord.name;
        const pc = this.acc.perChord[name] ?? (this.acc.perChord[name] = { total: 0, correct: 0 });
        pc.total++;
        if (v.kind === 'correct') pc.correct++;
      }
      this.clearEvent(i);
    }
    this.baseStreak = this.state.streak;
  }

  private buildSummary(): SessionSummary {
    const events = this.song.events;
    let total = this.acc.total;
    let correct = this.acc.correct;
    let wrong = this.acc.wrong;
    let missed = this.acc.missed;
    let skipped = this.acc.skipped;
    const timings = this.acc.timings.slice();
    const perChord: Record<string, PerChord> = {};
    for (const name of Object.keys(this.acc.perChord)) perChord[name] = { ...this.acc.perChord[name] };
    for (let i = 0; i < events.length; i++) {
      const v = this.state.verdicts[i];
      if (!v) continue;
      total++;
      if (v.kind === 'correct') {
        correct++;
        if (v.timing !== undefined) timings.push(v.timing);
      } else if (v.kind === 'wrong') wrong++;
      else if (v.kind === 'missed') missed++;
      else skipped++;
      if (v.kind !== 'skipped') {
        const name = events[i].chord.name;
        const pc = perChord[name] ?? (perChord[name] = { total: 0, correct: 0 });
        pc.total++;
        if (v.kind === 'correct') pc.correct++;
      }
    }
    const judged = total - skipped;
    return {
      total,
      correct,
      wrong,
      missed,
      skipped,
      accuracy: judged > 0 ? correct / judged : 0,
      score: this.state.score,
      bestStreak: this.bestStreak,
      passes: this.state.pass,
      medianTimingSec: timings.length >= 4 ? median(timings) : null,
      perChord,
    };
  }

  private finish(reason: 'finished' | 'stopped'): void {
    if (this.state.phase === 'ended') return;
    this.deps.clicks?.clear();
    const events = this.song.events;
    const passEnd = this.passEndBeat();
    for (let i = 0; i < events.length; i++) {
      const t = events[i].time;
      if (this.state.verdicts[i] === undefined && t >= this.passStartBeat && t < passEnd) {
        this.state.verdicts[i] = { eventIndex: i, kind: 'skipped', timingLabel: null, points: 0 };
      }
    }
    this.state.countInBeatsLeft = 0;
    const summary = this.buildSummary();
    this.state.summary = summary;
    if (this.unsubscribeDetector) {
      this.unsubscribeDetector();
      this.unsubscribeDetector = null;
    }
    this.setPhase('ended');
    this.emit('ended', { summary, reason });
  }

  // ---------------------------------------------------------------- update

  getState(): SessionState {
    return this.state;
  }

  /** Advances the session to the clock's current time and returns the state. */
  update(): SessionState {
    const state = this.state;
    if (state.phase !== 'countin' && state.phase !== 'playing') return state;
    const now = this.deps.clock.now();
    const beat = this.beatAt(now);
    state.beat = beat;
    state.songTimeSec = this.songSec(beat);

    if (state.phase === 'countin' && beat >= this.startBeat) this.setPhase('playing');
    state.countInBeatsLeft = state.phase === 'countin' ? Math.ceil(this.startBeat - beat) : 0;

    const events = this.song.events;
    let next = state.nextEventIndex;
    while (next < events.length && events[next].time <= beat) next++;
    state.nextEventIndex = next;

    this.scheduleClicks(now);
    this.processVerdicts(now);

    if (state.phase === 'playing') {
      const loop = state.loop;
      if (loop) {
        const end = this.loopEndBeat(loop);
        if (beat >= end && (now >= this.passOverWall(end) || this.verdictCursor >= lowerBound(events, end))) {
          this.dumpPass();
          state.pass++;
          this.playFrom(loop.fromBar, true);
        }
      } else if (now >= this.passOverWall(this.song.totalBeats)) {
        this.finish('finished');
      }
    }
    return state;
  }

  /** Schedules the integer beats up to 0.5 s ahead (accent on bar downbeats and during the count-in). */
  private scheduleClicks(now: number): void {
    const endBeat = this.passEndBeat();
    const horizon = now + CLICK_LOOKAHEAD_SEC;
    const clicks = this.settings.metronome ? this.deps.clicks : undefined;
    let b = this.lastScheduledBeat + 1;
    while (b < endBeat) {
      const t = this.wallSec(b);
      if (t > horizon) break;
      if (clicks && t >= now - CLICK_PAST_TOLERANCE_SEC) {
        clicks.scheduleClick(t, b < this.startBeat || this.barStarts.has(b));
      }
      this.lastScheduledBeat = b;
      b++;
    }
  }

  // ---------------------------------------------------------------- evidence

  private onFrame(frame: DetectorFrame): void {
    const state = this.state;
    if (state.phase === 'ended') return;
    state.live.rmsDb = frame.rmsDb;
    state.live.bestChord = frame.bestChord;
    state.live.listening = this.isListening();
    state.live.gateDb = this.currentGateDb();
    if (state.phase !== 'countin' && state.phase !== 'playing') return;
    if (!this.settings.listen) return;

    const end = frame.timeSec;
    const energy = frame.energyChroma;
    let max = 0;
    for (let i = 0; i < energy.length; i++) if (energy[i] > max) max = energy[i];
    this.frames.push({ start: end - this.frameSeconds, end, energyChroma: energy, gated: !(max > 0) });
    if (end > this.lastFrameEnd) this.lastFrameEnd = end;
    const oldest = this.lastFrameEnd - EVIDENCE_RING_SEC;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].end < oldest) drop++;
    if (drop > 0) this.frames.splice(0, drop);
    let dropOnsets = 0;
    while (dropOnsets < this.onsets.length && this.onsets[dropOnsets] < oldest) dropOnsets++;
    if (dropOnsets > 0) this.onsets.splice(0, dropOnsets);

    if (frame.onset) {
      const o = frame.onsetTimeSec ?? frame.timeSec;
      let pos = this.onsets.length;
      while (pos > 0 && this.onsets[pos - 1] > o) pos--;
      this.onsets.splice(pos, 0, o);
      this.assignOnset(o);
    }
  }

  /** One-to-one assignment: the closest pending event whose window contains the onset. */
  private assignOnset(o: number): void {
    const events = this.song.events;
    const passEnd = this.passEndBeat();
    const { earlySec, lateSec, perfectSec, goodSec } = this.judgeOpts;
    let best = -1;
    let bestDist = Infinity;
    let bestExpected = 0;
    for (let i = this.verdictCursor; i < events.length; i++) {
      const e = events[i];
      if (e.time >= passEnd) break;
      const expected = this.expectedSec(e);
      if (expected - earlySec > o) break;
      if (this.state.verdicts[i] !== undefined || this.assignedOnset[i] !== undefined || e.chord.quality === 'nc') continue;
      if (o > expected + lateSec) continue;
      const d = Math.abs(o - expected);
      if (d < bestDist) {
        bestDist = d;
        best = i;
        bestExpected = expected;
      }
    }
    if (best < 0) return;
    this.assignedOnset[best] = o;
    const timing = o - bestExpected;
    const hit: Hit = { eventIndex: best, timing, timingLabel: timingLabelFor(timing, perfectSec, goodSec) };
    this.state.hits[best] = hit;
    this.emit('hit', hit);
  }

  private nextOnsetAfter(o: number): number | null {
    for (const t of this.onsets) if (t > o) return t;
    return null;
  }

  /** Evidence.chromaAt over the ring buffer (mean of the frames inside, else the best overlap). */
  private readonly chromaAt = (t0: number, t1: number): Float32Array => {
    const sum = new Float32Array(12);
    let n = 0;
    for (const f of this.frames) {
      if (f.gated || f.start < t0 || f.end > t1) continue;
      for (let i = 0; i < 12; i++) sum[i] += f.energyChroma[i];
      n++;
    }
    if (n > 0) {
      for (let i = 0; i < 12; i++) sum[i] /= n;
      return compressChroma(sum);
    }
    let bestOverlap = 0;
    let bestFrame: EvidenceFrame | null = null;
    for (const f of this.frames) {
      if (f.gated) continue;
      const overlap = Math.min(f.end, t1) - Math.max(f.start, t0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestFrame = f;
      }
    }
    if (bestFrame) return compressChroma(bestFrame.energyChroma, undefined, sum);
    return sum;
  };

  /** Judges pending events in index order, stopping at the first one that cannot be decided yet. */
  private processVerdicts(now: number): void {
    const events = this.song.events;
    const state = this.state;
    const listening = this.isListening();
    const passEnd = this.passEndBeat();
    const { lateSec, analysisWindowSec } = this.judgeOpts;
    for (let i = this.verdictCursor; i < events.length; i++) {
      if (state.verdicts[i] !== undefined) {
        this.verdictCursor = i + 1;
        continue;
      }
      const e = events[i];
      if (e.time >= passEnd) break;
      const expected = this.expectedSec(e);
      let result: JudgeResult | null = null;
      if (e.chord.quality === 'nc' || !listening) {
        if (now >= expected) result = { eventIndex: i, kind: 'skipped', timingLabel: null };
      } else {
        const o = this.assignedOnset[i];
        if (o !== undefined) {
          const nextOnset = this.nextOnsetAfter(o);
          const { t1 } = analysisWindow(o, nextOnset, analysisWindowSec);
          if (this.lastFrameEnd >= t1 || now > o + analysisWindowSec + MISSED_CLOCK_MARGIN_SEC) {
            const info = this.expectedFor(e.chord);
            const input: JudgeInput = {
              eventIndex: i,
              chord: e.chord,
              muted: e.muted,
              expectedSec: expected,
              expectedPcs: info.pcs,
              expectedTemplate: info.template,
            };
            const evidence: Evidence = { onset: o, nextOnset, chromaAt: this.chromaAt };
            result = judgeEvent(input, evidence, this.judgeOpts);
          }
        } else if (
          this.lastFrameEnd > expected + lateSec + MISSED_FRAME_MARGIN_SEC ||
          now > expected + lateSec + MISSED_CLOCK_MARGIN_SEC
        ) {
          result = { eventIndex: i, kind: 'missed', timingLabel: null };
        }
      }
      if (result === null) break;
      this.applyVerdict(result);
      this.verdictCursor = i + 1;
    }
  }

  /** Points, streak and score for a judged event; stores and emits the verdict. */
  private applyVerdict(result: JudgeResult): void {
    const state = this.state;
    let points = 0;
    if (result.kind === 'correct') {
      state.streak++;
      if (state.streak > this.bestStreak) this.bestStreak = state.streak;
      const base = 100 + (result.timingLabel === 'perfect' ? 10 : 0);
      points = Math.round(base * Math.pow(1.1, Math.min(Math.floor(state.streak / 5), 5)));
    } else if (result.kind === 'wrong' || result.kind === 'missed') {
      state.streak = 0;
    }
    state.score += points;
    const verdict: Verdict = { ...result, points };
    state.verdicts[result.eventIndex] = verdict;
    this.emit('verdict', verdict);
  }
}
