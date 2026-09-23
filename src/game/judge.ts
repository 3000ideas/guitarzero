/**
 * Pure chord/timing judge (SPEC.md section 7, judge.ts).
 *
 * Every time here is in wall seconds (the clock that stamps DetectorFrame.timeSec). The judge
 * fills every Verdict field except `points`, which the engine adds. Rules, in order:
 *
 *  1. 'nc' chord                          -> skipped
 *  2. no onset                            -> missed
 *  3. timing = onset - expectedSec, timingLabel from perfectSec / goodSec
 *  4. muted strum                         -> correct (timing only)
 *  5. chroma of [onset + 0.02, min(onset + analysisWindowSec, nextOnset - 0.02)] (>= 0.05 s);
 *     all zeros                           -> missed (no timing)
 *  6. best = matchChord over the vocabulary with the expected template merged in;
 *     expectedScore = cosine(chroma, expected)
 *  7. expectedScore < minScore            -> wrong (detected = best)
 *  8. best != expected as pitch-class sets: superset -> the extra notes must be weaker than
 *     the weakest expected note; otherwise the missing notes must outweigh the extra ones
 *                                         -> wrong (detected = best)
 *  9. third check (always): the expected third must not be weaker than the other third
 *                                         -> wrong (detected = swapThirdName)
 * 10. correct with timing, timingLabel and expectedScore
 */
import type { ChordTemplate, Evidence, JudgeInput, JudgeOpts, JudgeResult, TimingLabel } from '../types';
import { cosine, matchChord, mergeExpectedTemplate, templateForPitchClasses } from '../dsp/chroma';
import { qualityThird, swapThirdName } from '../music/notes';

/** The analysis window starts this long after the onset (skips the noisy attack). */
export const ONSET_SKIP_SEC = 0.02;
/** The analysis window ends this long before the next onset. */
export const NEXT_ONSET_GUARD_SEC = 0.02;
/** Minimum length of the analysis window. */
export const MIN_WINDOW_SEC = 0.05;

/** Default judge tolerances (SPEC.md section 7): the engine fills the rest from Settings. */
export const DEFAULT_JUDGE_OPTS: Pick<JudgeOpts, 'analysisWindowSec' | 'minScore' | 'perfectSec' | 'goodSec'> = {
  analysisWindowSec: 0.3,
  minScore: 0.6,
  perfectSec: 0.07,
  goodSec: 0.15,
};

/** 'perfect' when |timing| <= perfectSec, 'good' when <= goodSec, else 'early' / 'late' by sign. */
export function timingLabelFor(timing: number, perfectSec: number, goodSec: number): Exclude<TimingLabel, null> {
  const a = Math.abs(timing);
  if (a <= perfectSec) return 'perfect';
  if (a <= goodSec) return 'good';
  return timing < 0 ? 'early' : 'late';
}

/**
 * Analysis window after an onset: [onset + 0.02, min(onset + analysisWindowSec, nextOnset - 0.02)],
 * stretched to at least 0.05 s. Shared with the engine (it waits until the ring covers t1).
 */
export function analysisWindow(onset: number, nextOnset: number | null, analysisWindowSec: number): { t0: number; t1: number } {
  const t0 = onset + ONSET_SKIP_SEC;
  let t1 = onset + analysisWindowSec;
  if (nextOnset !== null && nextOnset - NEXT_ONSET_GUARD_SEC < t1) t1 = nextOnset - NEXT_ONSET_GUARD_SEC;
  if (t1 - t0 < MIN_WINDOW_SEC) t1 = t0 + MIN_WINDOW_SEC;
  return { t0, t1 };
}

/** True when every bin is 0 (or the vector is empty). */
export function isAllZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

function pcSet(pcs: number[]): Set<number> {
  const s = new Set<number>();
  for (const p of pcs) s.add(((Math.round(p) % 12) + 12) % 12);
  return s;
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

function isSuperset(sup: Set<number>, sub: Set<number>): boolean {
  for (const p of sub) if (!sup.has(p)) return false;
  return true;
}

function minOver(c: Float32Array, pcs: Iterable<number>): number {
  let m = Infinity;
  for (const p of pcs) if (c[p] < m) m = c[p];
  return m;
}

function maxOver(c: Float32Array, pcs: Iterable<number>): number {
  let m = -Infinity;
  for (const p of pcs) if (c[p] > m) m = c[p];
  return m;
}

/** Mean of c over the pitch classes; 0 for an empty set. */
function meanOver(c: Float32Array, pcs: Iterable<number>): number {
  let sum = 0;
  let n = 0;
  for (const p of pcs) {
    sum += c[p];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function difference(a: Set<number>, b: Set<number>): number[] {
  const out: number[] = [];
  for (const p of a) if (!b.has(p)) out.push(p);
  return out;
}

/** The expected template, rebuilt from the pitch classes when the input carries none. */
function expectedTemplateOf(input: JudgeInput): ChordTemplate | null {
  if (input.expectedTemplate) return input.expectedTemplate;
  if (input.expectedPcs.length === 0) return null;
  return templateForPitchClasses(input.expectedPcs, input.chord.name, input.chord.root, input.chord.quality);
}

/**
 * Judges one strum event from the evidence gathered around it. Pure: no state, no clock.
 * `timingLabel` is only non-null for 'correct'; `timing` is present for 'correct' and 'wrong';
 * `detected` only for 'wrong'; `expectedScore` whenever a chroma was matched.
 */
export function judgeEvent(input: JudgeInput, evidence: Evidence, opts: JudgeOpts): JudgeResult {
  const eventIndex = input.eventIndex;

  // 1. No chord: nothing to judge (the ball still bounces).
  if (input.chord.quality === 'nc') return { eventIndex, kind: 'skipped', timingLabel: null };

  // 2. Nothing struck inside the window.
  if (evidence.onset === null) return { eventIndex, kind: 'missed', timingLabel: null };

  // 3. Timing.
  const onset = evidence.onset;
  const timing = onset - input.expectedSec;
  const timingLabel = timingLabelFor(timing, opts.perfectSec, opts.goodSec);

  // 4. Muted (percussive) strum: timing only.
  if (input.muted) return { eventIndex, kind: 'correct', timing, timingLabel };

  // 5. Chroma of the analysis window.
  const { t0, t1 } = analysisWindow(onset, evidence.nextOnset, opts.analysisWindowSec);
  const c = evidence.chromaAt(t0, t1);
  if (isAllZero(c)) return { eventIndex, kind: 'missed', timingLabel: null };

  // 6. Matching against the vocabulary with the expected voicing merged in.
  const expected = expectedTemplateOf(input);
  if (expected === null) {
    // No pitch content to compare against (defensive; 'nc' is handled above): timing only.
    return { eventIndex, kind: 'correct', timing, timingLabel };
  }
  const vocab = mergeExpectedTemplate(opts.templates, expected);
  const { best } = matchChord(c, vocab);
  const expectedScore = cosine(c, expected.vector);
  const detectedName = best ? best.name : expected.name;
  const E = pcSet(input.expectedPcs.length > 0 ? input.expectedPcs : expected.pcs);
  const B = best ? pcSet(best.pcs) : E;

  // 7. The expected chord is simply not there.
  if (expectedScore < opts.minScore) {
    return { eventIndex, kind: 'wrong', timing, timingLabel: null, detected: detectedName, expectedScore };
  }

  // 8. Another chord fits better: is the difference audible in the chroma?
  if (E.size > 0 && !sameSet(B, E)) {
    let d: number;
    if (isSuperset(B, E)) {
      d = minOver(c, E) - maxOver(c, difference(B, E));
    } else {
      d = meanOver(c, difference(E, B)) - meanOver(c, difference(B, E));
    }
    if (d < 0) {
      return { eventIndex, kind: 'wrong', timing, timingLabel: null, detected: detectedName, expectedScore };
    }
  }

  // 9. Third check, always: the written third must not be weaker than the other one.
  const third = qualityThird(input.chord.quality);
  if (third !== null && input.chord.root >= 0) {
    const other = third === 4 ? 3 : 4;
    const root = ((input.chord.root % 12) + 12) % 12;
    if (c[(root + third) % 12] < c[(root + other) % 12]) {
      return {
        eventIndex,
        kind: 'wrong',
        timing,
        timingLabel: null,
        detected: swapThirdName(input.chord),
        expectedScore,
      };
    }
  }

  // 10. Correct.
  return { eventIndex, kind: 'correct', timing, timingLabel, expectedScore };
}
