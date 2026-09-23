import { describe, expect, it } from 'vitest';
import type { ChordSymbol, Evidence, JudgeInput, JudgeOpts } from '../../src/types';
import {
  DEFAULT_JUDGE_OPTS,
  MIN_WINDOW_SEC,
  NEXT_ONSET_GUARD_SEC,
  ONSET_SKIP_SEC,
  analysisWindow,
  isAllZero,
  judgeEvent,
  timingLabelFor,
} from '../../src/game/judge';
import {
  HARMONIC_DECAY,
  HARMONIC_OFFSETS,
  buildTemplates,
  compressChroma,
  matchChord,
  mergeExpectedTemplate,
  templateForPitchClasses,
} from '../../src/dsp/chroma';
import { chordPitchClasses, parseChordSymbol } from '../../src/music/notes';

// ---------------------------------------------------------------- fixtures

const TEMPLATES = buildTemplates();

const OPTS: JudgeOpts = {
  earlySec: 0.15,
  lateSec: 0.25,
  ...DEFAULT_JUDGE_OPTS,
  templates: TEMPLATES,
};

const EXPECTED_SEC = 10;

function symbol(name: string): ChordSymbol {
  const sym = parseChordSymbol(name);
  if (!sym) throw new Error(`invalid chord ${name}`);
  return sym;
}

/** Energy-domain chroma of a set of notes with per-note gains (same harmonic model as the templates). */
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

/** Energy chroma of a chord played with every note at the same level (scaled by `scale`). */
function chordEnergy(name: string, scale = 1): Float32Array {
  const pcs = chordPitchClasses(symbol(name));
  const e = energyOf(pcs.map((p) => [p, 1] as [number, number]));
  for (let i = 0; i < 12; i++) e[i] *= scale;
  return e;
}

function inputFor(name: string, opts: { muted?: boolean; expectedSec?: number; noTemplate?: boolean } = {}): JudgeInput {
  const chord = symbol(name);
  const pcs = chordPitchClasses(chord);
  return {
    eventIndex: 3,
    chord,
    muted: opts.muted ?? false,
    expectedSec: opts.expectedSec ?? EXPECTED_SEC,
    expectedPcs: pcs,
    expectedTemplate: opts.noTemplate || pcs.length === 0 ? null : templateForPitchClasses(pcs, chord.name, chord.root, chord.quality),
  };
}

interface SpyEvidence extends Evidence {
  calls: Array<[t0: number, t1: number]>;
}

/** Evidence whose chromaAt always returns the compressed `energy` (zeros when null) and records its windows. */
function evidenceOf(onset: number | null, energy: Float32Array | null, nextOnset: number | null = null): SpyEvidence {
  const calls: Array<[number, number]> = [];
  return {
    onset,
    nextOnset,
    calls,
    chromaAt(t0, t1) {
      calls.push([t0, t1]);
      return energy ? compressChroma(energy) : new Float32Array(12);
    },
  };
}

// ---------------------------------------------------------------- helpers

describe('timingLabelFor', () => {
  it('classifies by absolute offset and sign', () => {
    expect(timingLabelFor(0, 0.07, 0.15)).toBe('perfect');
    expect(timingLabelFor(0.07, 0.07, 0.15)).toBe('perfect');
    expect(timingLabelFor(-0.07, 0.07, 0.15)).toBe('perfect');
    expect(timingLabelFor(0.1, 0.07, 0.15)).toBe('good');
    expect(timingLabelFor(-0.15, 0.07, 0.15)).toBe('good');
    expect(timingLabelFor(0.2, 0.07, 0.15)).toBe('late');
    expect(timingLabelFor(-0.2, 0.07, 0.15)).toBe('early');
  });
});

describe('analysisWindow', () => {
  it('starts 20 ms after the onset and lasts analysisWindowSec without a next onset', () => {
    expect(analysisWindow(10, null, 0.3)).toEqual({ t0: 10 + ONSET_SKIP_SEC, t1: 10.3 });
  });

  it('is capped 20 ms before the next onset', () => {
    const w = analysisWindow(10, 10.2, 0.3);
    expect(w.t0).toBeCloseTo(10.02, 9);
    expect(w.t1).toBeCloseTo(10.2 - NEXT_ONSET_GUARD_SEC, 9);
  });

  it('never shrinks below 50 ms', () => {
    const w = analysisWindow(10, 10.05, 0.3);
    expect(w.t0).toBeCloseTo(10.02, 9);
    expect(w.t1).toBeCloseTo(10.02 + MIN_WINDOW_SEC, 9);
  });

  it('ignores a next onset beyond the window', () => {
    expect(analysisWindow(10, 11, 0.3).t1).toBeCloseTo(10.3, 9);
  });
});

describe('isAllZero', () => {
  it('detects null vectors', () => {
    expect(isAllZero(new Float32Array(12))).toBe(true);
    const v = new Float32Array(12);
    v[5] = 1e-6;
    expect(isAllZero(v)).toBe(false);
  });
});

// ---------------------------------------------------------------- rules 1-4

describe('judgeEvent: skipped / missed / timing / muted', () => {
  it('rule 1: N.C. is skipped even with an onset and a strong chroma', () => {
    const r = judgeEvent(inputFor('N.C.'), evidenceOf(EXPECTED_SEC, chordEnergy('C')), OPTS);
    expect(r).toEqual({ eventIndex: 3, kind: 'skipped', timingLabel: null });
    expect(r.timing).toBeUndefined();
    expect(r.detected).toBeUndefined();
  });

  it('rule 2: no onset -> missed without timing', () => {
    const ev = evidenceOf(null, chordEnergy('C'));
    const r = judgeEvent(inputFor('C'), ev, OPTS);
    expect(r).toEqual({ eventIndex: 3, kind: 'missed', timingLabel: null });
    expect(ev.calls).toEqual([]);
  });

  it('rule 3: timing labels perfect / good / late / early on a correct chord', () => {
    const cases: Array<[number, string]> = [
      [0, 'perfect'],
      [0.05, 'perfect'],
      [-0.06, 'perfect'],
      [0.1, 'good'],
      [-0.12, 'good'],
      [0.2, 'late'],
      [-0.2, 'early'],
    ];
    for (const [offset, label] of cases) {
      const r = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC + offset, chordEnergy('C')), OPTS);
      expect(r.kind).toBe('correct');
      expect(r.timing).toBeCloseTo(offset, 9);
      expect(r.timingLabel).toBe(label);
    }
  });

  it('rule 4: muted strums are judged on timing only (chroma never consulted)', () => {
    const ev = evidenceOf(EXPECTED_SEC + 0.1, null);
    const r = judgeEvent(inputFor('C', { muted: true }), ev, OPTS);
    expect(r.kind).toBe('correct');
    expect(r.timing).toBeCloseTo(0.1, 9);
    expect(r.timingLabel).toBe('good');
    expect(r.expectedScore).toBeUndefined();
    expect(ev.calls).toEqual([]);

    // Even a totally different chord is fine when muted.
    const r2 = judgeEvent(inputFor('C', { muted: true }), evidenceOf(EXPECTED_SEC, chordEnergy('F#')), OPTS);
    expect(r2.kind).toBe('correct');
  });
});

// ---------------------------------------------------------------- rule 5

describe('judgeEvent: chroma window', () => {
  it('rule 5: an all-zero chroma (gated frames) -> missed, no timing', () => {
    const r = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, null), OPTS);
    expect(r).toEqual({ eventIndex: 3, kind: 'missed', timingLabel: null });
  });

  it('asks chromaAt for [onset + 0.02, onset + analysisWindowSec] when there is no next onset', () => {
    const ev = evidenceOf(EXPECTED_SEC, chordEnergy('C'));
    judgeEvent(inputFor('C'), ev, OPTS);
    expect(ev.calls.length).toBe(1);
    expect(ev.calls[0][0]).toBeCloseTo(EXPECTED_SEC + 0.02, 9);
    expect(ev.calls[0][1]).toBeCloseTo(EXPECTED_SEC + 0.3, 9);
  });

  it('caps the window 20 ms before the next onset', () => {
    const ev = evidenceOf(EXPECTED_SEC, chordEnergy('C'), EXPECTED_SEC + 0.2);
    judgeEvent(inputFor('C'), ev, OPTS);
    expect(ev.calls[0][0]).toBeCloseTo(EXPECTED_SEC + 0.02, 9);
    expect(ev.calls[0][1]).toBeCloseTo(EXPECTED_SEC + 0.18, 9);
  });

  it('keeps at least 50 ms when the next onset is very close', () => {
    const ev = evidenceOf(EXPECTED_SEC, chordEnergy('C'), EXPECTED_SEC + 0.04);
    judgeEvent(inputFor('C'), ev, OPTS);
    expect(ev.calls[0][0]).toBeCloseTo(EXPECTED_SEC + 0.02, 9);
    expect(ev.calls[0][1]).toBeCloseTo(EXPECTED_SEC + 0.07, 9);
  });

  it('uses the given analysisWindowSec', () => {
    const ev = evidenceOf(EXPECTED_SEC, chordEnergy('C'));
    judgeEvent(inputFor('C'), ev, { ...OPTS, analysisWindowSec: 0.5 });
    expect(ev.calls[0][1]).toBeCloseTo(EXPECTED_SEC + 0.5, 9);
  });
});

// ---------------------------------------------------------------- rules 6-10

describe('judgeEvent: chord verdicts', () => {
  it('correct chord -> correct with timing, label and expectedScore', () => {
    for (const name of ['C', 'G', 'Am', 'F', 'Em', 'D7', 'Bb', 'F#m', 'Cmaj7', 'Dsus4', 'A5']) {
      const r = judgeEvent(inputFor(name), evidenceOf(EXPECTED_SEC, chordEnergy(name)), OPTS);
      expect(r.kind, name).toBe('correct');
      expect(r.timing).toBe(0);
      expect(r.timingLabel).toBe('perfect');
      expect(r.expectedScore).toBeGreaterThan(0.99);
      expect(r.detected).toBeUndefined();
    }
  });

  it('is scale invariant (the chroma level does not matter)', () => {
    const loud = judgeEvent(inputFor('G'), evidenceOf(EXPECTED_SEC, chordEnergy('G', 1000)), OPTS);
    const quiet = judgeEvent(inputFor('G'), evidenceOf(EXPECTED_SEC, chordEnergy('G', 0.001)), OPTS);
    expect(loud.kind).toBe('correct');
    expect(quiet.kind).toBe('correct');
    expect(loud.expectedScore).toBeCloseTo(quiet.expectedScore ?? -1, 6);
  });

  it('rule 7: an unrelated chord -> wrong with the detected name, timing kept, label null', () => {
    const r = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC + 0.05, chordEnergy('F#')), OPTS);
    expect(r.kind).toBe('wrong');
    expect(r.detected).toBe('F#');
    expect(r.timing).toBeCloseTo(0.05, 9);
    expect(r.timingLabel).toBeNull();
    expect(r.expectedScore).toBeDefined();
    expect(r.expectedScore!).toBeLessThan(OPTS.minScore);
  });

  it('G when C is expected -> wrong, detected G', () => {
    const r = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, chordEnergy('G')), OPTS);
    expect(r.kind).toBe('wrong');
    expect(r.detected).toBe('G');
  });

  it('superset detected: Am7 (with a softer 7th) when Am is expected -> correct', () => {
    // A minor with the 7th (G) played a bit softer than the triad, as on a real guitar.
    const energy = energyOf([
      [9, 1],
      [0, 1],
      [4, 1],
      [7, 0.6],
    ]);
    const input = inputFor('Am');
    // Premise: the vocabulary prefers the superset chord.
    const vocab = mergeExpectedTemplate(TEMPLATES, input.expectedTemplate!);
    expect(matchChord(compressChroma(energy), vocab).best?.name).toBe('Am7');

    const r = judgeEvent(input, evidenceOf(EXPECTED_SEC, energy), OPTS);
    expect(r.kind).toBe('correct');
    expect(r.timingLabel).toBe('perfect');
    expect(r.expectedScore).toBeGreaterThan(OPTS.minScore);
  });

  it('rule 8 (superset): an extra note louder than the weakest expected note -> wrong', () => {
    // Full-strength Am7: the G bin ends up above the A and C bins (harmonics), so the
    // superset rule rejects it.
    const input = inputFor('Am');
    const energy = chordEnergy('Am7');
    const r = judgeEvent(input, evidenceOf(EXPECTED_SEC, energy), OPTS);
    expect(r.kind).toBe('wrong');
    expect(r.detected).toBe('Am7');
  });

  it('A vs Am: the wrong third is rejected in both directions', () => {
    const r1 = judgeEvent(inputFor('A'), evidenceOf(EXPECTED_SEC, chordEnergy('Am')), OPTS);
    expect(r1.kind).toBe('wrong');
    expect(r1.detected).toBe('Am');

    const r2 = judgeEvent(inputFor('Am'), evidenceOf(EXPECTED_SEC, chordEnergy('A')), OPTS);
    expect(r2.kind).toBe('wrong');
    expect(r2.detected).toBe('A');
  });

  it('C vs Am (relative chords sharing two notes) are told apart', () => {
    const r1 = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, chordEnergy('Am')), OPTS);
    expect(r1.kind).toBe('wrong');
    expect(r1.detected).toBe('Am');
    // The expected chord still scores fairly well: it is rule 8 (missing G vs extra A) that decides.
    expect(r1.expectedScore).toBeGreaterThan(OPTS.minScore);

    const r2 = judgeEvent(inputFor('Am'), evidenceOf(EXPECTED_SEC, chordEnergy('C')), OPTS);
    expect(r2.kind).toBe('wrong');
    expect(r2.detected).toBe('C');
  });

  it('rule 9: the third is checked even when the matcher agrees with the expected chord', () => {
    // Empty vocabulary: the merged expected template is the only candidate, so rules 7/8 pass
    // and only the third check can reject. C major with Eb louder than E -> Cm.
    const energy = energyOf([
      [0, 1],
      [4, 0.8],
      [3, 1],
      [7, 1],
    ]);
    const r = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, energy), { ...OPTS, templates: [] });
    expect(r.kind).toBe('wrong');
    expect(r.detected).toBe('Cm');
    expect(r.expectedScore).toBeGreaterThan(OPTS.minScore);

    const r7 = judgeEvent(inputFor('C7'), evidenceOf(EXPECTED_SEC, energy), { ...OPTS, templates: [] });
    expect(r7.kind).toBe('wrong');
    expect(r7.detected).toBe('Cm7');

    // The same construction with the expected third on top is fine.
    const ok = energyOf([
      [0, 1],
      [4, 1],
      [3, 0.8],
      [7, 1],
    ]);
    expect(judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, ok), { ...OPTS, templates: [] }).kind).toBe('correct');
  });

  it('rule 9 keeps the user spelling of the root in the detected name', () => {
    const energy = energyOf([
      [10, 1],
      [2, 0.8],
      [1, 1],
      [5, 1],
    ]);
    const r = judgeEvent(inputFor('Bb'), evidenceOf(EXPECTED_SEC, energy), { ...OPTS, templates: [] });
    expect(r.kind).toBe('wrong');
    expect(r.detected).toBe('Bbm');
  });

  it('qualities without a third skip the third check', () => {
    expect(judgeEvent(inputFor('Asus4'), evidenceOf(EXPECTED_SEC, chordEnergy('Asus4')), OPTS).kind).toBe('correct');
    expect(judgeEvent(inputFor('A5'), evidenceOf(EXPECTED_SEC, chordEnergy('A5')), OPTS).kind).toBe('correct');
    expect(judgeEvent(inputFor('Dsus2'), evidenceOf(EXPECTED_SEC, chordEnergy('Dsus2')), OPTS).kind).toBe('correct');
  });

  it('slash chords: the bass note is part of the expected set', () => {
    const r = judgeEvent(inputFor('G/B'), evidenceOf(EXPECTED_SEC, chordEnergy('G')), OPTS);
    expect(r.kind).toBe('correct');
    const r2 = judgeEvent(inputFor('C/G'), evidenceOf(EXPECTED_SEC, chordEnergy('C')), OPTS);
    expect(r2.kind).toBe('correct');
  });

  it('expectedPcs from a voicing can differ from the symbol (a G shape with a doubled D is still G)', () => {
    const input = inputFor('G');
    input.expectedPcs = [7, 11, 2];
    const r = judgeEvent(input, evidenceOf(EXPECTED_SEC, chordEnergy('G')), OPTS);
    expect(r.kind).toBe('correct');
  });

  it('rebuilds the expected template from expectedPcs when the input carries none', () => {
    const r = judgeEvent(inputFor('C', { noTemplate: true }), evidenceOf(EXPECTED_SEC, chordEnergy('C')), OPTS);
    expect(r.kind).toBe('correct');
    const w = judgeEvent(inputFor('C', { noTemplate: true }), evidenceOf(EXPECTED_SEC, chordEnergy('F#')), OPTS);
    expect(w.kind).toBe('wrong');
  });

  it('never returns a timingLabel on wrong / missed / skipped, and never a timing on missed / skipped', () => {
    const wrong = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC + 0.01, chordEnergy('F#')), OPTS);
    expect(wrong.timingLabel).toBeNull();
    expect(wrong.timing).toBeCloseTo(0.01, 9);
    const missed = judgeEvent(inputFor('C'), evidenceOf(null, chordEnergy('C')), OPTS);
    expect(missed.timingLabel).toBeNull();
    expect(missed.timing).toBeUndefined();
    const gated = judgeEvent(inputFor('C'), evidenceOf(EXPECTED_SEC, null), OPTS);
    expect(gated.timingLabel).toBeNull();
    expect(gated.timing).toBeUndefined();
    const skipped = judgeEvent(inputFor('N.C.'), evidenceOf(EXPECTED_SEC, chordEnergy('C')), OPTS);
    expect(skipped.timingLabel).toBeNull();
    expect(skipped.timing).toBeUndefined();
  });

  it('is pure: the same inputs give the same result and the inputs are not mutated', () => {
    const input = inputFor('Em');
    const before = JSON.stringify(input);
    const energy = chordEnergy('Em');
    const copy = energy.slice();
    const a = judgeEvent(input, evidenceOf(EXPECTED_SEC, energy), OPTS);
    const b = judgeEvent(input, evidenceOf(EXPECTED_SEC, energy), OPTS);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
    expect(Array.from(energy)).toEqual(Array.from(copy));
  });
});
