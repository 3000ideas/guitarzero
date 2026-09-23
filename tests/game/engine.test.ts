import { describe, expect, it } from 'vitest';
import type {
  ChordShape,
  ClickScheduler,
  DetectorFrame,
  DetectorSource,
  Hit,
  SessionPhase,
  SessionSummary,
  Settings,
  Song,
  Verdict,
} from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import { PracticeSession, DEFAULT_FRAME_SECONDS, END_MARGIN_SEC } from '../../src/game/engine';
import { DEFAULT_JUDGE_OPTS } from '../../src/game/judge';
import { HARMONIC_DECAY, HARMONIC_OFFSETS, compressChroma } from '../../src/dsp/chroma';
import { chordPitchClasses, parseChordSymbol } from '../../src/music/notes';
import { getChordShape, shapeMidiNotes } from '../../src/music/chords';
import { parseSong } from '../../src/song/parser';
import { ChordDetector } from '../../src/dsp/detector';
import { mix, runDetector, silence, synthStrum } from '../helpers/synth';

// ---------------------------------------------------------------- fakes

class FakeClock {
  t = 0;
  now(): number {
    return this.t;
  }
}

class FakeDetector implements DetectorSource {
  private readonly cbs = new Set<(frame: DetectorFrame) => void>();
  subscribers(): number {
    return this.cbs.size;
  }
  onFrame(cb: (frame: DetectorFrame) => void): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }
  push(frame: DetectorFrame): void {
    for (const cb of Array.from(this.cbs)) cb(frame);
  }
}

interface ScheduledClick {
  t: number;
  accent: boolean;
  /** clock.now() when the click was scheduled. */
  at: number;
}

class FakeClicks implements ClickScheduler {
  scheduled: ScheduledClick[] = [];
  cleared = 0;
  constructor(private readonly clock: FakeClock) {}
  scheduleClick(timeSec: number, accent: boolean): void {
    this.scheduled.push({ t: timeSec, accent, at: this.clock.now() });
  }
  clear(): void {
    this.cleared++;
  }
}

// ---------------------------------------------------------------- chroma / frames

function energyOf(notes: Array<[pc: number, gain: number]>): Float32Array {
  const e = new Float32Array(12);
  for (const [pc, gain] of notes) {
    for (let h = 1; h <= HARMONIC_OFFSETS.length; h++) {
      const amp = Math.pow(HARMONIC_DECAY, h - 1);
      e[(((pc + HARMONIC_OFFSETS[h - 1]) % 12) + 12) % 12] += gain * amp * amp;
    }
  }
  return e;
}

function chordEnergy(name: string, scale = 1): Float32Array {
  const sym = parseChordSymbol(name);
  if (!sym) throw new Error(`invalid chord ${name}`);
  const e = energyOf(chordPitchClasses(sym).map((p) => [p, 1] as [number, number]));
  for (let i = 0; i < 12; i++) e[i] *= scale;
  return e;
}

function makeFrame(timeSec: number, energy: Float32Array | null, onsetTimeSec?: number): DetectorFrame {
  const energyChroma = energy ? energy.slice() : new Float32Array(12);
  const frame: DetectorFrame = {
    timeSec,
    rmsDb: energy ? -25 : -100,
    onset: onsetTimeSec !== undefined,
    energyChroma,
    chroma: compressChroma(energyChroma),
    bestChord: energy ? { name: 'X', score: 0.9 } : null,
  };
  if (onsetTimeSec !== undefined) frame.onsetTimeSec = onsetTimeSec;
  return frame;
}

interface Strum {
  at: number;
  /** Energy chroma from this strum on (null = silence / gated frames). */
  energy: Float32Array | null;
  /** Report an onset for this strum (default true). */
  onset?: boolean;
  /** How long the chord keeps ringing in the frames (default 2 s). */
  ring?: number;
}

const HOP = 0.04;
const STEP = 0.01;

/**
 * Drives a session with a fake clock: advances in small steps, pushes one synthetic
 * DetectorFrame per hop (chroma of the most recent strum, onset reported one hop after the
 * strum with a refined onsetTimeSec = the strum time) and calls update() at every step.
 */
class Driver {
  readonly strums: Strum[] = [];
  private frameIndex = 1;
  private readonly reported = new Set<Strum>();
  constructor(
    readonly session: PracticeSession,
    readonly clock: FakeClock,
    readonly detector: FakeDetector | null,
    private readonly frameSeconds = DEFAULT_FRAME_SECONDS,
    private readonly onsetDelay = HOP,
  ) {}

  strum(at: number, energy: Float32Array | null, extra: Partial<Strum> = {}): void {
    this.strums.push({ at, energy, ...extra });
  }

  /** Frames that would have been produced so far but were not pushed yet are skipped (time jump). */
  skipFramesUntil(t: number): void {
    this.frameIndex = Math.floor(t / HOP) + 1;
  }

  frameAt(end: number): DetectorFrame {
    let cur: Strum | null = null;
    for (const s of this.strums) if (s.at <= end + 1e-9 && (!cur || s.at >= cur.at)) cur = s;
    let energy: Float32Array | null = null;
    if (cur && cur.energy && end - cur.at <= (cur.ring ?? 2)) energy = cur.energy;
    let onsetAt: number | undefined;
    for (const s of this.strums) {
      if (s.onset === false || this.reported.has(s)) continue;
      if (end >= s.at + this.onsetDelay - 1e-9) {
        this.reported.add(s);
        onsetAt = s.at;
        break;
      }
    }
    return makeFrame(end, energy, onsetAt);
  }

  advanceTo(t: number, step = STEP): void {
    while (this.clock.t < t - 1e-9) {
      this.clock.t = Math.min(t, this.clock.t + step);
      if (this.detector) {
        while (this.frameIndex * HOP <= this.clock.t + 1e-9) {
          this.detector.push(this.frameAt(this.frameIndex * HOP));
          this.frameIndex++;
        }
      }
      this.session.update();
    }
  }

  get frameLength(): number {
    return this.frameSeconds;
  }
}

// ---------------------------------------------------------------- songs / sessions

const SRC_2BARS = 'title: Test\ntempo: 120\n\nC . . . | G . . . |';
const SRC_1BAR = 'title: Test\ntempo: 120\n\nC . . . |';
const SRC_34 = 'title: Vals\ntempo: 120\ntime: 3/4\n\nC . . | G . . |';
const SRC_MUTED = 'title: Muted\ntempo: 120\nstrum: DxDx\n\nC . . . |';
const SRC_NC = 'title: NC\ntempo: 120\n\nN.C. | C . . . |';
const SRC_8C = 'title: Eight\ntempo: 120\n\nC . . . | C . . . |';

function song(src: string): Song {
  const res = parseSong(src, { id: 'test' });
  const errors = res.errors.filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(`song errors: ${JSON.stringify(errors)}`);
  return res.song;
}

const BASE: Settings = { ...DEFAULT_SETTINGS, latencySec: 0, metronome: false, listen: true };

function shapesFor(s: Song): Record<string, ChordShape | null> {
  const out: Record<string, ChordShape | null> = {};
  for (const name of s.chordNames) out[name] = getChordShape(name);
  return out;
}

interface Rig {
  song: Song;
  session: PracticeSession;
  clock: FakeClock;
  detector: FakeDetector | null;
  clicks: FakeClicks | null;
  drive: Driver;
  phases: SessionPhase[];
  hits: Array<{ hit: Hit; at: number; verdictBefore: Verdict | undefined }>;
  verdicts: Array<{ verdict: Verdict; at: number }>;
  ended: Array<{ summary: SessionSummary; reason: 'finished' | 'stopped'; at: number }>;
}

function rig(src: string, settings: Partial<Settings> = {}, opts: { detector?: boolean; clicks?: boolean; frameSeconds?: number } = {}): Rig {
  const s = song(src);
  const clock = new FakeClock();
  const detector = opts.detector === false ? null : new FakeDetector();
  const clicks = opts.clicks ? new FakeClicks(clock) : null;
  const session = new PracticeSession(
    s,
    {
      clock,
      clicks: clicks ?? undefined,
      detector: detector ?? undefined,
      settings: { ...BASE, ...settings },
      shapes: shapesFor(s),
    },
    opts.frameSeconds !== undefined ? { frameSeconds: opts.frameSeconds } : {},
  );
  const r: Rig = {
    song: s,
    session,
    clock,
    detector,
    clicks,
    drive: new Driver(session, clock, detector, opts.frameSeconds),
    phases: [],
    hits: [],
    verdicts: [],
    ended: [],
  };
  session.on('phase', (p) => r.phases.push(p));
  session.on('hit', (hit) => r.hits.push({ hit, at: clock.now(), verdictBefore: session.getState().verdicts[hit.eventIndex] }));
  session.on('verdict', (verdict) => r.verdicts.push({ verdict, at: clock.now() }));
  session.on('ended', (e) => r.ended.push({ ...e, at: clock.now() }));
  return r;
}

/** Wall time of a song beat when the session started at t = 0 with 120 bpm, 4/4 and tempoScale 1. */
function wall(beat: number, beatSec = 0.5, countInBeats = 4, startedAt = 0): number {
  return startedAt + 0.1 + (beat + countInBeats) * beatSec;
}

const C = chordEnergy('C');
const G = chordEnergy('G');
const PASS_MARGIN = BASE.lateSec + DEFAULT_JUDGE_OPTS.analysisWindowSec + END_MARGIN_SEC; // latency 0

// ================================================================ tests

describe('PracticeSession: construction and invariants', () => {
  it('starts idle with preallocated verdict/hit arrays and a neutral state', () => {
    const r = rig(SRC_2BARS);
    const st = r.session.getState();
    expect(r.song.events.length).toBe(8);
    expect(st.phase).toBe('idle');
    expect(st.verdicts.length).toBe(8);
    expect(st.hits.length).toBe(8);
    expect(st.verdicts.every((v) => v === undefined)).toBe(true);
    expect(st.hits.every((h) => h === undefined)).toBe(true);
    expect(st.beat).toBe(0);
    expect(st.songTimeSec).toBe(0);
    expect(st.nextEventIndex).toBe(0);
    expect(st.score).toBe(0);
    expect(st.streak).toBe(0);
    expect(st.countInBeatsLeft).toBe(0);
    expect(st.loop).toBeNull();
    expect(st.pass).toBe(1);
    expect(st.summary).toBeNull();
    expect(st.live.listening).toBe(true);
    expect(st.live.gateDb).toBe(BASE.gateDb);
    expect(st.live.bestChord).toBeNull();
  });

  it('getState() returns the same object and update() is a no-op while idle', () => {
    const r = rig(SRC_2BARS);
    const a = r.session.getState();
    r.clock.t = 5;
    const b = r.session.update();
    expect(b).toBe(a);
    expect(b.phase).toBe('idle');
    expect(b.beat).toBe(0);
  });

  it('live.listening is false without a detector or with listen = false', () => {
    expect(rig(SRC_2BARS, {}, { detector: false }).session.getState().live.listening).toBe(false);
    expect(rig(SRC_2BARS, { listen: false }).session.getState().live.listening).toBe(false);
  });

  it('frames received while idle update live but never produce hits', () => {
    const r = rig(SRC_2BARS);
    r.detector!.push(makeFrame(0.5, C, 0.46));
    const st = r.session.getState();
    expect(st.live.rmsDb).toBe(-25);
    expect(st.live.bestChord).toEqual({ name: 'X', score: 0.9 });
    expect(st.hits.every((h) => h === undefined)).toBe(true);
    expect(r.hits.length).toBe(0);
  });

  it('exposes the gate of a detector source that implements getGateDb', () => {
    const s = song(SRC_2BARS);
    const clock = new FakeClock();
    const detector = new FakeDetector() as FakeDetector & { getGateDb(): number };
    detector.getGateDb = () => -37;
    const session = new PracticeSession(s, { clock, detector, settings: BASE, shapes: shapesFor(s) });
    expect(session.getState().live.gateDb).toBe(-37);
  });
});

describe('PracticeSession: count-in', () => {
  it('start() anchors one bar before, counts 4..1 and switches to playing on the first beat', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    let st = r.session.getState();
    expect(st.phase).toBe('countin');
    expect(r.phases).toEqual(['countin']);
    expect(st.countInBeatsLeft).toBe(4);
    expect(st.beat).toBe(-4);
    expect(st.songTimeSec).toBe(-2);
    expect(st.nextEventIndex).toBe(0);

    // The 0.1 s lead-in keeps the clock at the anchor.
    r.drive.advanceTo(0.05);
    st = r.session.getState();
    expect(st.beat).toBe(-4);
    expect(st.countInBeatsLeft).toBe(4);

    const seen: number[] = [];
    for (const t of [0.2, 0.7, 1.2, 1.7]) {
      r.drive.advanceTo(t);
      st = r.session.getState();
      expect(st.phase).toBe('countin');
      seen.push(st.countInBeatsLeft);
      // beat + countInBeatsLeft recovers the pass start (highway invariant).
      expect(Math.floor(st.beat) + st.countInBeatsLeft).toBe(0);
    }
    expect(seen).toEqual([4, 3, 2, 1]);

    r.drive.advanceTo(wall(0) + 0.001);
    st = r.session.getState();
    expect(st.phase).toBe('playing');
    expect(st.countInBeatsLeft).toBe(0);
    expect(st.beat).toBeCloseTo(0, 1);
    expect(st.nextEventIndex).toBe(1);
    expect(r.phases).toEqual(['countin', 'playing']);
  });

  it('counts 3 beats in 3/4', () => {
    const r = rig(SRC_34);
    r.session.start();
    expect(r.session.getState().countInBeatsLeft).toBe(3);
    expect(r.session.getState().beat).toBe(-3);
    r.drive.advanceTo(0.1 + 3 * 0.5 - 0.02);
    expect(r.session.getState().phase).toBe('countin');
    expect(r.session.getState().countInBeatsLeft).toBe(1);
    r.drive.advanceTo(0.1 + 3 * 0.5 + 0.01);
    expect(r.session.getState().phase).toBe('playing');
  });

  it('start() is only accepted while idle', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.advanceTo(1);
    const beat = r.session.getState().beat;
    r.session.start();
    expect(r.session.getState().beat).toBe(beat);
    expect(r.phases).toEqual(['countin']);
  });

  it('honours the tempo map (count-in at the initial tempo) and tempoScale', () => {
    const r = rig(SRC_2BARS, { tempoScale: 0.5 });
    r.session.start();
    // 120 bpm at half speed: one beat = 1 s wall, count-in 4 s.
    r.drive.advanceTo(4.05);
    expect(r.session.getState().phase).toBe('countin');
    r.drive.advanceTo(4.11);
    expect(r.session.getState().phase).toBe('playing');
    expect(r.session.wallSec(0)).toBeCloseTo(4.1, 9);
    expect(r.session.wallSec(4)).toBeCloseTo(8.1, 9);
  });
});

describe('PracticeSession: hits and verdicts', () => {
  it('an onset exactly at expectedSec is a hit at once (before update) and becomes correct/perfect', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.advanceTo(wall(0) + 0.06);
    const st = r.session.getState();
    // The onset is reported by the first frame ending >= one hop after the strum (2.16 here):
    // the hit is emitted on arrival, before any verdict.
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].hit).toEqual({ eventIndex: 0, timing: 0, timingLabel: 'perfect' });
    expect(r.hits[0].verdictBefore).toBeUndefined();
    expect(r.hits[0].at).toBeLessThanOrEqual(wall(0) + 2 * HOP + 1e-9);
    expect(st.hits[0]).toBe(r.hits[0].hit);
    expect(st.verdicts[0]).toBeUndefined();

    // The verdict waits for the ring to cover onset + analysisWindowSec.
    r.drive.advanceTo(wall(0) + 0.28);
    expect(r.session.getState().verdicts[0]).toBeUndefined();
    r.drive.advanceTo(wall(0) + 0.35);
    const v = r.session.getState().verdicts[0]!;
    expect(v.kind).toBe('correct');
    expect(v.timingLabel).toBe('perfect');
    expect(v.timing).toBe(0);
    expect(v.points).toBe(110);
    expect(v.expectedScore).toBeGreaterThan(DEFAULT_JUDGE_OPTS.minScore);
    expect(r.verdicts[0].verdict).toBe(v);
    expect(r.session.getState().score).toBe(110);
    expect(r.session.getState().streak).toBe(1);
  });

  it('timing labels come from the real offset: good / late / early', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0) + 0.1, C); // good
    r.drive.strum(wall(1) + 0.2, C); // late (window is +0.25)
    r.drive.strum(wall(2) - 0.14, C); // early-ish but still good? |0.14| <= 0.15 -> good
    r.drive.strum(wall(3) - 0.15, C); // exactly -0.15 -> good (inclusive)
    r.drive.advanceTo(wall(4) + 0.5);
    const st = r.session.getState();
    expect(st.hits[0]!.timingLabel).toBe('good');
    expect(st.hits[1]!.timingLabel).toBe('late');
    expect(st.hits[2]!.timingLabel).toBe('good');
    expect(st.hits[3]!.timingLabel).toBe('good');
    expect(st.verdicts[0]!.kind).toBe('correct');
    expect(st.verdicts[1]!.kind).toBe('correct');
    expect(st.verdicts[1]!.timingLabel).toBe('late');
    expect(st.verdicts[1]!.points).toBe(100);
  });

  it('no frames at all -> every event is missed by the clock fallback and the song finishes', () => {
    const r = rig(SRC_2BARS, {}, { detector: true });
    r.session.start();
    // Drive the clock without pushing any frame.
    const d = new Driver(r.session, r.clock, null);
    d.advanceTo(wall(0) + BASE.lateSec + 0.45);
    expect(r.session.getState().verdicts[0]).toBeUndefined();
    d.advanceTo(wall(0) + BASE.lateSec + 0.52);
    expect(r.session.getState().verdicts[0]!.kind).toBe('missed');
    d.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.phase).toBe('ended');
    expect(st.verdicts.every((v) => v?.kind === 'missed')).toBe(true);
    expect(r.ended.length).toBe(1);
    expect(r.ended[0].reason).toBe('finished');
    expect(r.ended[0].at).toBeCloseTo(wall(8) + PASS_MARGIN, 1);
    const s = r.ended[0].summary;
    expect(s.total).toBe(8);
    expect(s.missed).toBe(8);
    expect(s.accuracy).toBe(0);
    expect(s.score).toBe(0);
    expect(st.summary).toBe(s);
    expect(r.phases).toEqual(['countin', 'playing', 'ended']);
  });

  it('gated frames -> missed as soon as the frames pass the window (+0.05 s)', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.advanceTo(wall(0) + BASE.lateSec + 0.03);
    expect(r.session.getState().verdicts[0]).toBeUndefined();
    r.drive.advanceTo(wall(0) + BASE.lateSec + 0.1);
    const v = r.session.getState().verdicts[0]!;
    expect(v).toEqual({ eventIndex: 0, kind: 'missed', timingLabel: null, points: 0 });
    expect(r.session.getState().streak).toBe(0);
  });

  it('listen = false -> every event is skipped and accuracy is 0 (never NaN)', () => {
    const r = rig(SRC_2BARS, { listen: false });
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.advanceTo(wall(0) + 0.05);
    expect(r.session.getState().verdicts[0]).toEqual({ eventIndex: 0, kind: 'skipped', timingLabel: null, points: 0 });
    expect(r.hits.length).toBe(0);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.phase).toBe('ended');
    expect(st.verdicts.every((v) => v?.kind === 'skipped')).toBe(true);
    const s = st.summary!;
    expect(s.total).toBe(8);
    expect(s.skipped).toBe(8);
    expect(s.correct + s.wrong + s.missed + s.skipped).toBe(s.total);
    expect(s.accuracy).toBe(0);
    expect(Number.isNaN(s.accuracy)).toBe(false);
    expect(s.medianTimingSec).toBeNull();
    expect(s.perChord).toEqual({});
  });

  it('no detector -> skipped too', () => {
    const r = rig(SRC_2BARS, {}, { detector: false });
    r.session.start();
    new Driver(r.session, r.clock, null).advanceTo(wall(8) + PASS_MARGIN + 0.02);
    expect(r.session.getState().summary!.skipped).toBe(8);
  });

  it('a wrong chord gives wrong + detected, 0 points and resets the streak', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.strum(wall(1), G);
    r.drive.strum(wall(2), C);
    r.drive.advanceTo(wall(3));
    const st = r.session.getState();
    expect(st.verdicts[0]!.kind).toBe('correct');
    expect(st.verdicts[1]!.kind).toBe('wrong');
    expect(st.verdicts[1]!.detected).toBe('G');
    expect(st.verdicts[1]!.points).toBe(0);
    expect(st.verdicts[1]!.timingLabel).toBeNull();
    expect(st.verdicts[1]!.timing).toBe(0);
    expect(st.verdicts[2]!.kind).toBe('correct');
    expect(st.streak).toBe(1);
    expect(st.score).toBe(220);
  });

  it('muted events are judged on timing only', () => {
    const r = rig(SRC_MUTED);
    expect(r.song.events.map((e) => e.muted)).toEqual([false, true, false, true]);
    r.session.start();
    // Gated frames but reported onsets: the muted strums are correct, the plain ones missed.
    r.drive.strum(wall(1), null, { onset: true });
    r.drive.strum(wall(3) + 0.1, null, { onset: true });
    r.drive.strum(wall(0), null, { onset: true });
    r.drive.advanceTo(wall(4) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.verdicts[0]!.kind).toBe('missed');
    expect(st.verdicts[1]!.kind).toBe('correct');
    expect(st.verdicts[1]!.timingLabel).toBe('perfect');
    expect(st.verdicts[2]!.kind).toBe('missed');
    expect(st.verdicts[3]!.kind).toBe('correct');
    expect(st.verdicts[3]!.timingLabel).toBe('good');
    expect(st.verdicts[3]!.timing).toBeCloseTo(0.1, 9);
  });

  it('N.C. events are skipped when their time passes and never receive onsets', () => {
    const r = rig(SRC_NC);
    const ncEvents = r.song.events.filter((e) => e.chord.quality === 'nc');
    expect(ncEvents.length).toBe(4);
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.advanceTo(wall(0) - 0.01);
    expect(r.session.getState().verdicts[0]).toBeUndefined();
    r.drive.advanceTo(wall(0) + 0.05);
    expect(r.session.getState().verdicts[0]).toEqual({ eventIndex: 0, kind: 'skipped', timingLabel: null, points: 0 });
    expect(r.hits.length).toBe(0);
    r.drive.strum(wall(4), C);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const s = r.session.getState().summary!;
    expect(s.skipped).toBe(4);
    expect(s.correct).toBe(1);
    expect(s.missed).toBe(3);
    expect(s.accuracy).toBeCloseTo(0.25, 9);
    expect(s.perChord).toEqual({ C: { total: 4, correct: 1 } });
  });

  it('assigns each onset to at most one event and each event at most one onset (closest wins)', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    // Two strums inside the window of event 0: the second one cannot be reassigned to event 0
    // and is outside event 1's window.
    r.drive.strum(wall(0) - 0.05, C);
    r.drive.strum(wall(0) + 0.15, C);
    // One strum between events 2 and 3, inside event 3's early window only.
    r.drive.strum(wall(3) - 0.12, C);
    r.drive.advanceTo(wall(4) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.hits[0]!.timing).toBeCloseTo(-0.05, 9);
    expect(st.hits[1]).toBeUndefined();
    expect(st.hits[2]).toBeUndefined();
    expect(st.hits[3]!.timing).toBeCloseTo(-0.12, 9);
    expect(st.hits[3]!.timingLabel).toBe('good');
    expect(st.verdicts[1]!.kind).toBe('missed');
    expect(st.verdicts[2]!.kind).toBe('missed');
    expect(r.hits.length).toBe(2);
  });

  it('an onset inside two overlapping windows goes to the closest event', () => {
    // Eighth-note strums: events every 0.25 s, windows [-0.15, +0.25] overlap.
    const r = rig('title: E\ntempo: 120\nstrum: DDDDDDDD\n\nC . . . |');
    expect(r.song.events.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    r.session.start();
    r.drive.strum(wall(0) + 0.2, C); // +0.2 for event 0, -0.05 for event 1
    r.drive.advanceTo(wall(0) + 0.3);
    const st = r.session.getState();
    expect(st.hits[0]).toBeUndefined();
    expect(st.hits[1]!.timing).toBeCloseTo(-0.05, 9);
    expect(st.hits[1]!.timingLabel).toBe('perfect');
  });

  it('points: 100 (+10 perfect) x 1.1^min(floor(streak/5), 5)', () => {
    const r = rig(SRC_8C);
    r.session.start();
    for (let i = 0; i < 8; i++) r.drive.strum(wall(i), C);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.verdicts.map((v) => v!.points)).toEqual([110, 110, 110, 110, 121, 121, 121, 121]);
    expect(st.score).toBe(4 * 110 + 4 * 121);
    expect(st.streak).toBe(8);
    const s = st.summary!;
    expect(s.score).toBe(st.score);
    expect(s.bestStreak).toBe(8);
    expect(s.accuracy).toBe(1);
    expect(s.medianTimingSec).toBe(0);
  });

  it('skipped events do not break the streak; wrong and missed do', () => {
    const r = rig(SRC_NC);
    r.session.start();
    r.drive.strum(wall(4), C);
    r.drive.strum(wall(5), C);
    r.drive.strum(wall(7), C);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const st = r.session.getState();
    expect(st.verdicts.slice(0, 4).every((v) => v!.kind === 'skipped')).toBe(true);
    expect(st.verdicts[4]!.kind).toBe('correct');
    expect(st.verdicts[5]!.kind).toBe('correct');
    expect(st.verdicts[6]!.kind).toBe('missed');
    expect(st.verdicts[7]!.kind).toBe('correct');
    expect(st.streak).toBe(1);
    expect(st.summary!.bestStreak).toBe(2);
  });

  it('latencySec = 0.2: the frames used by chromaAt lie after the (raw) onset', () => {
    const r = rig(SRC_1BAR, { latencySec: 0.2 });
    r.session.start();
    // Before the strum the frames carry a very loud wrong chord: if any frame that starts before
    // the onset leaked into the analysis window, the verdict would be 'wrong'.
    r.drive.strum(0, chordEnergy('F#', 1000), { onset: false, ring: 100 });
    r.drive.strum(wall(0) + 0.2, C);
    r.drive.advanceTo(wall(0) + 0.6);
    const st = r.session.getState();
    expect(st.hits[0]!.timing).toBeCloseTo(0, 9);
    expect(st.hits[0]!.timingLabel).toBe('perfect');
    expect(st.verdicts[0]!.kind).toBe('correct');
    expect(st.verdicts[0]!.timing).toBeCloseTo(0, 9);
    expect(r.session.expectedSec(r.song.events[0])).toBeCloseTo(wall(0) + 0.2, 9);
  });

  it('tempoScale = 0.5 slows the clock but keeps the tolerances in real seconds', () => {
    const r = rig(SRC_2BARS, { tempoScale: 0.5 });
    r.session.start();
    const e0 = r.session.wallSec(0); // 4.1
    const e1 = r.session.wallSec(1); // 5.1
    expect(e1 - e0).toBeCloseTo(1, 9);
    r.drive.strum(e0 + 0.3, C); // 0.3 s late = 0.3 beats at this speed, still outside lateSec
    r.drive.strum(e1 + 0.2, C); // inside the window, labelled late
    r.drive.advanceTo(e1 + 1);
    const st = r.session.getState();
    expect(st.hits[0]).toBeUndefined();
    expect(st.verdicts[0]!.kind).toBe('missed');
    expect(st.hits[1]!.timing).toBeCloseTo(0.2, 9);
    expect(st.hits[1]!.timingLabel).toBe('late');
    expect(st.verdicts[1]!.kind).toBe('correct');
  });

  it('a close next onset caps the analysis window (verdict arrives sooner, still correct)', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.strum(wall(0) + 0.1, C); // not in any window (event 1 is 0.5 s later)
    r.drive.advanceTo(wall(0) + 0.2);
    // t1 = min(o + 0.3, next - 0.02) = o + 0.08 -> judged once a frame ends past it.
    const v = r.session.getState().verdicts[0]!;
    expect(v.kind).toBe('correct');
    expect(r.verdicts[0].at).toBeLessThan(wall(0) + 0.2 + 1e-9);
    expect(r.session.getState().hits[1]).toBeUndefined();
  });

  it('accepts a custom frameSeconds (long frames fall back to the best-overlap frame)', () => {
    const r = rig(SRC_1BAR, {}, { frameSeconds: 0.5 });
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.advanceTo(wall(0) + 0.4);
    expect(r.session.getState().verdicts[0]!.kind).toBe('correct');
  });

  it('a frame with an onset inside the window but a silent ring afterwards -> missed (no chroma)', () => {
    const r = rig(SRC_1BAR);
    r.session.start();
    r.drive.strum(wall(0), null, { onset: true });
    r.drive.advanceTo(wall(0) + 0.4);
    const st = r.session.getState();
    expect(st.hits[0]).toBeDefined();
    expect(st.verdicts[0]!.kind).toBe('missed');
  });

  it('uses the voicing pitch classes from deps.shapes (G/B shape sounds like G)', () => {
    const src = 'title: Slash\ntempo: 120\n\nG/B . . . |';
    const r = rig(src);
    expect(r.song.chordNames).toEqual(['G/B']);
    r.session.start();
    r.drive.strum(wall(0), G);
    r.drive.advanceTo(wall(0) + 0.4);
    expect(r.session.getState().verdicts[0]!.kind).toBe('correct');
  });
});

describe('PracticeSession: pause / resume / seek / stop / settings', () => {
  it('pause freezes the clock, ignores frames and clears clicks; resume counts in and repeats the bar', () => {
    const r = rig(SRC_2BARS, { metronome: true }, { clicks: true });
    r.session.start();
    for (let i = 0; i < 4; i++) r.drive.strum(wall(i), C);
    r.drive.advanceTo(wall(5.6));
    let st = r.session.getState();
    expect(st.phase).toBe('playing');
    expect(st.verdicts.slice(0, 4).every((v) => v!.kind === 'correct')).toBe(true);
    expect(st.verdicts[4]!.kind).toBe('missed');
    const clearedBefore = r.clicks!.cleared;

    r.session.pause();
    st = r.session.getState();
    expect(st.phase).toBe('paused');
    expect(st.beat).toBeCloseTo(5.6, 6);
    expect(r.clicks!.cleared).toBe(clearedBefore + 1);
    expect(r.phases).toEqual(['countin', 'playing', 'paused']);

    // Frames are ignored while paused (live still updates).
    r.detector!.push(makeFrame(wall(5.6) + 0.05, G, wall(5.6) + 0.02));
    expect(r.session.getState().hits[5]).toBeUndefined();
    expect(r.session.getState().live.rmsDb).toBe(-25);
    r.clock.t = 6;
    r.session.update();
    expect(r.session.getState().beat).toBeCloseTo(5.6, 6);
    expect(r.session.getState().phase).toBe('paused');
    r.session.pause(); // no-op
    expect(r.phases.length).toBe(3);

    const scheduledBefore = r.clicks!.scheduled.length;
    r.session.resume();
    st = r.session.getState();
    expect(st.phase).toBe('countin');
    expect(st.countInBeatsLeft).toBe(4);
    expect(st.beat).toBe(0); // anchor = start of bar 1 (beat 4) minus one bar
    expect(st.verdicts.slice(0, 4).every((v) => v!.kind === 'correct')).toBe(true);
    expect(st.verdicts.slice(4).every((v) => v === undefined)).toBe(true);
    expect(st.score).toBe(440);
    expect(st.streak).toBe(4);

    // Count-in clicks of the resumed pass: 4 accented beats from t = 6.1, bar 1 plays at 8.1.
    expect(r.session.wallSec(4)).toBeCloseTo(8.1, 9);
    r.drive.skipFramesUntil(6);
    r.drive.advanceTo(8.1 + 0.01);
    st = r.session.getState();
    expect(st.phase).toBe('playing');
    const countIn = r.clicks!.scheduled.slice(scheduledBefore, scheduledBefore + 4);
    expect(countIn.map((c) => c.t)).toEqual([6.1, 6.6, 7.1, 7.6].map((x) => expect.closeTo(x, 9)));
    expect(countIn.every((c) => c.accent)).toBe(true);

    // The whole bar 1 is played again and judged.
    r.drive.strum(8.1, G);
    r.drive.advanceTo(8.1 + 0.4);
    expect(r.session.getState().verdicts[4]!.kind).toBe('correct');
    expect(r.session.getState().hits[4]!.timing).toBeCloseTo(0, 9);
  });

  it('pausing during the count-in resumes from the same bar', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.advanceTo(1.0);
    r.session.pause();
    r.session.resume();
    expect(r.session.getState().beat).toBe(-4);
    expect(r.session.getState().countInBeatsLeft).toBe(4);
    // Re-anchored at 1.0 + 0.1, a full count-in bar before beat 0.
    expect(r.session.wallSec(0)).toBeCloseTo(1.1 + 2, 9);
  });

  it('resume() only works while paused', () => {
    const r = rig(SRC_2BARS);
    r.session.resume();
    expect(r.session.getState().phase).toBe('idle');
    r.session.start();
    r.session.resume();
    expect(r.phases).toEqual(['countin']);
  });

  it('seekBar in idle sets the position, skips the earlier events and start() plays from there', () => {
    const r = rig(SRC_2BARS);
    r.session.seekBar(1);
    let st = r.session.getState();
    expect(st.phase).toBe('idle');
    expect(st.beat).toBe(4);
    expect(st.songTimeSec).toBe(2);
    expect(st.nextEventIndex).toBe(5);
    expect(st.verdicts.slice(0, 4).every((v) => v?.kind === 'skipped' && v.points === 0)).toBe(true);
    expect(st.verdicts.slice(4).every((v) => v === undefined)).toBe(true);
    expect(r.verdicts.length).toBe(0);

    r.session.start();
    st = r.session.getState();
    expect(st.phase).toBe('countin');
    expect(st.beat).toBe(0);
    expect(r.session.wallSec(4)).toBeCloseTo(2.1, 9);
    r.drive.strum(2.1, G);
    r.drive.advanceTo(2.1 + 0.4);
    expect(r.session.getState().verdicts[4]!.kind).toBe('correct');
    r.drive.advanceTo(r.session.wallSec(8) + PASS_MARGIN + 0.02);
    const s = r.session.getState().summary!;
    expect(s.total).toBe(8);
    expect(s.skipped).toBe(4);
    expect(s.correct).toBe(1);
    expect(s.missed).toBe(3);
    expect(s.accuracy).toBe(0.25);
  });

  it('seekBar clamps the bar index and is ignored while playing', () => {
    const r = rig(SRC_2BARS);
    r.session.seekBar(99);
    expect(r.session.getState().beat).toBe(4);
    r.session.seekBar(-3);
    expect(r.session.getState().beat).toBe(0);
    expect(r.session.getState().verdicts.every((v) => v === undefined)).toBe(true);
    r.session.start();
    r.drive.advanceTo(3);
    const beat = r.session.getState().beat;
    r.session.seekBar(1);
    expect(r.session.getState().beat).toBe(beat);
  });

  it('seekBar while paused moves the resume position', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    for (let i = 0; i < 4; i++) r.drive.strum(wall(i), C);
    r.drive.advanceTo(wall(6));
    r.session.pause();
    r.session.seekBar(0);
    let st = r.session.getState();
    expect(st.beat).toBe(0);
    expect(st.verdicts.every((v) => v === undefined)).toBe(true);
    expect(st.score).toBe(0);
    r.session.resume();
    st = r.session.getState();
    expect(st.beat).toBe(-4);
    // Anchored at wall(6) + 0.1, then one count-in bar (2 s) before beat 0.
    expect(r.session.wallSec(0)).toBeCloseTo(wall(6) + 0.1 + 2, 9);
  });

  it('stop() ends from any phase with reason stopped; the session is inert afterwards', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0), C);
    r.drive.advanceTo(wall(1.5));
    r.session.stop();
    const st = r.session.getState();
    expect(st.phase).toBe('ended');
    expect(r.ended[0].reason).toBe('stopped');
    expect(st.verdicts[0]!.kind).toBe('correct');
    expect(st.verdicts.slice(1).every((v) => v?.kind === 'skipped')).toBe(true);
    const s = st.summary!;
    expect(s.total).toBe(8);
    expect(s.correct).toBe(1);
    expect(s.skipped).toBe(7);
    expect(s.accuracy).toBe(1);
    expect(s.score).toBe(st.score);
    expect(r.detector!.subscribers()).toBe(0);
    expect(r.phases[r.phases.length - 1]).toBe('ended');

    // Inert.
    r.session.stop();
    r.session.start();
    r.session.resume();
    r.session.seekBar(0);
    r.session.setLoop({ fromBar: 0, toBar: 1 });
    r.session.setSettings({ tempoScale: 0.5 });
    r.clock.t = 100;
    expect(r.session.update().phase).toBe('ended');
    expect(r.ended.length).toBe(1);
    expect(r.session.getState().loop).toBeNull();
    expect(r.session.getSettings().tempoScale).toBe(1);
  });

  it('stop() while idle marks everything skipped', () => {
    const r = rig(SRC_2BARS);
    r.session.stop();
    const s = r.session.getState().summary!;
    expect(s.total).toBe(8);
    expect(s.skipped).toBe(8);
    expect(s.accuracy).toBe(0);
    expect(s.passes).toBe(1);
    expect(r.ended[0].reason).toBe('stopped');
  });

  it('setSettings: tempoScale only while idle/paused; listen and latency apply live', () => {
    const r = rig(SRC_2BARS);
    r.session.setSettings({ tempoScale: 0.5 });
    expect(r.session.getSettings().tempoScale).toBe(0.5);
    r.session.start();
    r.session.setSettings({ tempoScale: 1 });
    expect(r.session.getSettings().tempoScale).toBe(0.5);
    r.session.setSettings({ listen: false });
    expect(r.session.getState().live.listening).toBe(false);
    r.session.setSettings({ listen: true, latencySec: 0.1 });
    expect(r.session.expectedSec(r.song.events[0])).toBeCloseTo(4.1 + 0.1, 9);
    r.session.pause();
    r.session.setSettings({ tempoScale: 1 });
    expect(r.session.getSettings().tempoScale).toBe(1);
    // The deps.settings object is never mutated.
    expect(BASE.tempoScale).toBe(1);
    expect(BASE.latencySec).toBe(0);
  });

  it('turning the metronome off clears the pending clicks', () => {
    const r = rig(SRC_2BARS, { metronome: true }, { clicks: true });
    r.session.start();
    r.drive.advanceTo(0.2);
    expect(r.clicks!.scheduled.length).toBeGreaterThan(0);
    const cleared = r.clicks!.cleared;
    r.session.setSettings({ metronome: false });
    expect(r.clicks!.cleared).toBe(cleared + 1);
    const n = r.clicks!.scheduled.length;
    r.drive.advanceTo(3);
    expect(r.clicks!.scheduled.length).toBe(n);
  });
});

describe('PracticeSession: loop', () => {
  it('a 2-bar loop counts in again and returns to fromBar; passes are counted', () => {
    const r = rig(SRC_2BARS);
    r.session.setLoop({ fromBar: 0, toBar: 1 });
    expect(r.session.getState().loop).toEqual({ fromBar: 0, toBar: 1 });
    r.session.start();
    // Pass 1: everything missed (gated frames) -> all judged before the loop end (beat 8 at 6.1).
    r.drive.advanceTo(6.05);
    let st = r.session.getState();
    expect(st.phase).toBe('playing');
    expect(st.pass).toBe(1);
    expect(st.verdicts.every((v) => v?.kind === 'missed')).toBe(true);
    r.drive.advanceTo(6.15);
    st = r.session.getState();
    expect(st.phase).toBe('countin');
    expect(st.pass).toBe(2);
    expect(st.countInBeatsLeft).toBe(4);
    expect(st.beat).toBe(-4);
    expect(st.verdicts.every((v) => v === undefined)).toBe(true);
    expect(st.hits.every((h) => h === undefined)).toBe(true);
    const restart = r.session.wallSec(0) - 0.1 - 2; // clock time at the restart
    expect(restart).toBeCloseTo(6.1, 1);

    // Pass 2 with a couple of hits.
    const p2 = r.session.wallSec(0);
    r.drive.strum(p2, C);
    r.drive.strum(p2 + 0.5, C);
    r.drive.advanceTo(p2 + 4 + 0.05);
    st = r.session.getState();
    expect(st.phase).toBe('countin');
    expect(st.pass).toBe(3);
    // Streak and score carry over the passes.
    expect(st.score).toBe(220);
    expect(st.streak).toBe(0);

    // Pass 3: stop one second into bar 0 (events 0 and 1 already missed, the rest skipped).
    r.drive.advanceTo(r.session.wallSec(0) + 1);
    expect(r.session.getState().phase).toBe('playing');
    r.session.stop();
    const s = r.ended[0].summary;
    expect(s.passes).toBe(3);
    expect(s.total).toBe(8 + 8 + 8);
    expect(s.correct).toBe(2);
    expect(s.missed).toBe(8 + 6 + 2);
    expect(s.skipped).toBe(6);
    expect(s.correct + s.wrong + s.missed + s.skipped).toBe(s.total);
    expect(s.accuracy).toBeCloseTo(2 / 18, 9);
    expect(s.score).toBe(220);
    expect(s.bestStreak).toBe(2);
    expect(s.perChord).toEqual({ C: { total: 10, correct: 2 }, G: { total: 8, correct: 0 } });
    expect(r.phases).toEqual(['countin', 'playing', 'countin', 'playing', 'countin', 'playing', 'ended']);
  });

  it('without frames the loop restarts after the judging margin', () => {
    const r = rig(SRC_2BARS);
    r.session.setLoop({ fromBar: 0, toBar: 1 });
    r.session.start();
    const d = new Driver(r.session, r.clock, null);
    d.advanceTo(wall(8) + 0.2);
    expect(r.session.getState().pass).toBe(1);
    d.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    expect(r.session.getState().pass).toBe(2);
    expect(r.session.getState().phase).toBe('countin');
  });

  it('loops over a bar range in the middle of the song and never finishes by itself', () => {
    const r = rig(SRC_2BARS);
    r.session.setLoop({ fromBar: 1, toBar: 1 });
    r.session.seekBar(1);
    r.session.start();
    // The count-in runs over bar 0's beats: bar 1 starts at 2.1 and the loop end (beat 8) is at 4.1.
    expect(r.session.wallSec(4)).toBeCloseTo(2.1, 9);
    const loopEnd = r.session.wallSec(8);
    expect(loopEnd).toBeCloseTo(4.1, 9);
    r.drive.advanceTo(loopEnd - 0.05);
    let st = r.session.getState();
    expect(st.pass).toBe(1);
    expect(st.verdicts.slice(4).every((v) => v?.kind === 'missed')).toBe(true);
    r.drive.advanceTo(loopEnd + 0.05);
    st = r.session.getState();
    expect(st.pass).toBe(2);
    expect(st.phase).toBe('countin');
    expect(st.beat).toBe(0);
    expect(st.countInBeatsLeft).toBe(4);
    expect(st.verdicts.every((v) => v === undefined)).toBe(true); // dumped and cleared
    r.drive.advanceTo(40);
    st = r.session.getState();
    expect(st.phase).not.toBe('ended');
    expect(st.pass).toBeGreaterThan(5);
    r.session.stop();
    const s = r.ended[0].summary;
    // The seek skipped the 4 events of bar 0 once; every pass accounts for the 4 events of bar 1.
    expect(s.skipped).toBeGreaterThanOrEqual(4);
    expect(s.total).toBe(4 + 4 * s.passes);
    expect(s.missed + s.skipped).toBe(s.total);
  });

  it('setLoop(null) lets the song end naturally; setLoop clamps and orders the range', () => {
    const r = rig(SRC_2BARS);
    r.session.setLoop({ fromBar: 5, toBar: -1 });
    expect(r.session.getState().loop).toEqual({ fromBar: 0, toBar: 1 });
    r.session.setLoop({ fromBar: 1, toBar: 0 });
    expect(r.session.getState().loop).toEqual({ fromBar: 0, toBar: 1 });
    r.session.start();
    r.drive.advanceTo(3);
    r.session.setLoop(null);
    expect(r.session.getState().loop).toBeNull();
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    expect(r.session.getState().phase).toBe('ended');
    expect(r.ended[0].reason).toBe('finished');
    expect(r.ended[0].summary.passes).toBe(1);
  });
});

describe('PracticeSession: metronome', () => {
  it('schedules every integer beat up to 0.5 s ahead, accented on the count-in and bar downbeats', () => {
    const r = rig(SRC_2BARS, { metronome: true }, { clicks: true });
    r.session.start();
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    const sched = r.clicks!.scheduled;
    expect(sched.map((c) => c.t)).toEqual(
      [0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6, 4.1, 4.6, 5.1, 5.6].map((x) => expect.closeTo(x, 9)),
    );
    expect(sched.map((c) => c.accent)).toEqual([true, true, true, true, true, false, false, false, true, false, false, false]);
    for (const c of sched) {
      expect(c.t - c.at).toBeLessThanOrEqual(0.5 + STEP + 1e-9);
      expect(c.t - c.at).toBeGreaterThanOrEqual(-0.05);
    }
    // Ending clears whatever is pending.
    expect(r.clicks!.cleared).toBeGreaterThanOrEqual(1);
  });

  it('3/4: three count-in clicks, accents on beats 0 and 3', () => {
    const r = rig(SRC_34, { metronome: true }, { clicks: true });
    r.session.start();
    r.drive.advanceTo(5);
    const sched = r.clicks!.scheduled;
    expect(sched.map((c) => c.t)).toEqual([0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6, 4.1].map((x) => expect.closeTo(x, 9)));
    expect(sched.map((c) => c.accent)).toEqual([true, true, true, true, false, false, true, false, false]);
  });

  it('no clicks when settings.metronome is false or no scheduler is given', () => {
    const r = rig(SRC_2BARS, { metronome: false }, { clicks: true });
    r.session.start();
    r.drive.advanceTo(3);
    expect(r.clicks!.scheduled).toEqual([]);
    const r2 = rig(SRC_2BARS, { metronome: true });
    r2.session.start();
    r2.drive.advanceTo(3);
    expect(r2.session.getState().phase).toBe('playing');
  });

  it('clicks follow tempoScale and stop at the loop end', () => {
    const r = rig(SRC_1BAR, { metronome: true, tempoScale: 0.5 }, { clicks: true });
    r.session.setLoop({ fromBar: 0, toBar: 0 });
    r.session.start();
    r.drive.advanceTo(8.05); // beat 4 (loop end) at 8.1
    const times = r.clicks!.scheduled.map((c) => c.t);
    expect(times).toEqual([0.1, 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1].map((x) => expect.closeTo(x, 9)));
  });
});

describe('PracticeSession: summary and ended', () => {
  it('ended carries the summary with perChord, median timing and the score invariant', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0) + 0.01, C);
    r.drive.strum(wall(1) - 0.01, C);
    r.drive.strum(wall(2) + 0.02, C);
    r.drive.strum(wall(3), C);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    expect(r.ended.length).toBe(1);
    const { summary, reason } = r.ended[0];
    expect(reason).toBe('finished');
    const st = r.session.getState();
    expect(st.phase).toBe('ended');
    expect(st.summary).toBe(summary);
    expect(summary.total).toBe(8);
    expect(summary.correct).toBe(4);
    expect(summary.missed).toBe(4);
    expect(summary.wrong).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.accuracy).toBe(0.5);
    expect(summary.passes).toBe(1);
    expect(summary.score).toBe(st.score);
    expect(summary.score).toBe(440);
    expect(summary.bestStreak).toBe(4);
    expect(summary.medianTimingSec).toBeCloseTo(0.005, 9);
    expect(summary.perChord).toEqual({ C: { total: 4, correct: 4 }, G: { total: 4, correct: 0 } });
    expect(st.verdicts.length).toBe(st.hits.length);
    expect(st.verdicts.length).toBe(r.song.events.length);
  });

  it('medianTimingSec is null with fewer than 4 correct verdicts', () => {
    const r = rig(SRC_2BARS);
    r.session.start();
    r.drive.strum(wall(0) + 0.05, C);
    r.drive.strum(wall(1) + 0.05, C);
    r.drive.strum(wall(2) + 0.05, C);
    r.drive.advanceTo(wall(8) + PASS_MARGIN + 0.02);
    expect(r.session.getState().summary!.correct).toBe(3);
    expect(r.session.getState().summary!.medianTimingSec).toBeNull();
  });

  it('listeners can unsubscribe', () => {
    const r = rig(SRC_2BARS);
    let n = 0;
    const off = r.session.on('phase', () => n++);
    r.session.start();
    expect(n).toBe(1);
    off();
    r.drive.advanceTo(3);
    expect(n).toBe(1);
    expect(r.phases).toEqual(['countin', 'playing']);
  });
});

describe('PracticeSession: integration with the real ChordDetector', () => {
  const SR = 48000;

  function notesOf(name: string): number[] {
    const shape = getChordShape(name);
    if (!shape) throw new Error(`no shape for ${name}`);
    return shapeMidiNotes(shape);
  }

  /** Feeds real detector frames (from a synthesized signal) into a session started at t = 0. */
  function playSignal(r: Rig, signal: Float32Array, untilSec: number): void {
    const frames = runDetector(signal, SR, {}, new ChordDetector(SR));
    for (const f of frames) {
      if (f.timeSec > untilSec) break;
      r.clock.t = f.timeSec;
      r.detector!.push(f);
      r.session.update();
    }
    r.clock.t = untilSec;
    r.session.update();
  }

  it('four strummed C chords on the beat are all correct and close to perfect', () => {
    const r = rig(SRC_1BAR);
    r.session.start();
    const seconds = 5.2;
    const parts = [0, 1, 2, 3].map((i) => {
      const at = wall(i);
      return { signal: synthStrum(notesOf('C'), SR, seconds - at, { atSec: 0, seed: 11 + i }), atSec: at };
    });
    const signal = mix([{ signal: silence(SR, seconds), atSec: 0 }, ...parts], SR, seconds);
    playSignal(r, signal, seconds);
    const st = r.session.getState();
    expect(st.phase).toBe('ended');
    for (let i = 0; i < 4; i++) {
      const v = st.verdicts[i]!;
      expect(v.kind, `event ${i}: ${JSON.stringify(v)}`).toBe('correct');
      expect(Math.abs(v.timing!)).toBeLessThan(0.02);
      expect(v.timingLabel).toBe('perfect');
    }
    expect(st.summary!.accuracy).toBe(1);
  }, 30000);

  it('a C chord where G is expected is judged wrong with C detected', () => {
    const r = rig('title: G\ntempo: 120\n\nG . . . |');
    r.session.start();
    const seconds = 3.5;
    const at = wall(0);
    const signal = mix(
      [
        { signal: silence(SR, seconds), atSec: 0 },
        { signal: synthStrum(notesOf('C'), SR, seconds - at, { seed: 5 }), atSec: at },
      ],
      SR,
      seconds,
    );
    playSignal(r, signal, seconds);
    const v = r.session.getState().verdicts[0]!;
    expect(v.kind).toBe('wrong');
    expect(v.detected).toBe('C');
    expect(Math.abs(v.timing!)).toBeLessThan(0.02);
  }, 30000);
});
