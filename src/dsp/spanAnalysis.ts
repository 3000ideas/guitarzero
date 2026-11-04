/**
 * Analysis of a stretch of the recording (an intro, a verse…): how fast it goes and where its bars
 * start. The user marks the stretch (`fromSec`..`toSec`, audio seconds); the strikes inside are fitted
 * with a regular beat grid (tempo + phase), the bar line is put on the beat that carries the most
 * attacks, and the number of whole bars that fit is the answer.
 */
import { attackCurve, sampleAt } from './syncFit';
import { energyAttacks } from '../song/barCheck';

export interface SpanInput {
  samples: Float32Array;
  sampleRate: number;
  /** Audio seconds. The stretch starts at (or a little before) the first bar line. */
  fromSec: number;
  /** Audio seconds. The stretch ends at (or a little before) the bar line that follows its last bar. */
  toSec: number;
  beatsPerBar?: number;
  /** Tempo search range (bpm). */
  minBpm?: number;
  maxBpm?: number;
  /**
   * How many bars the stretch has, when the user knows. A beat grid fits a stretch at half or double speed
   * just as well, so this is what settles the tempo.
   */
  bars?: number;
}

export interface SpanResult {
  ok: boolean;
  /** Spanish reason when not ok. */
  reason: string;
  bpm: number;
  beatsPerBar: number;
  /** Whole bars in the stretch. */
  bars: number;
  /** Audio second of the first bar line. */
  firstBeatSec: number;
  /** Audio second of the end of the last bar (= start of the next one). */
  endSec: number;
  /** Audio second of every bar line (`bars` entries). */
  barStarts: number[];
  /** 0..1: how clearly the strikes sit on the grid (best score over the average score of the sweep). */
  confidence: number;
}

const FAIL = (reason: string): SpanResult => ({ ok: false, reason, bpm: 0, beatsPerBar: 4, bars: 0, firstBeatSec: 0, endSec: 0, barStarts: [], confidence: 0 });

/** Attack strength at the grid points (each read as the best value within ±20 ms), over a fixed count so grids compare fairly. */
function gridScore(curve: Float32Array, times: readonly number[], count: number): number {
  if (times.length === 0 || !(count > 0)) return 0;
  let acc = 0;
  for (const t of times) {
    let best = 0;
    for (let d = -0.02; d <= 0.0201; d += 0.01) best = Math.max(best, sampleAt(curve, t + d));
    acc += best;
  }
  return acc / count;
}

export function analyzeSpan(input: SpanInput): SpanResult {
  const { samples, sampleRate } = input;
  const beatsPerBar = input.beatsPerBar ?? 4;
  let minBpm = input.minBpm ?? 60;
  let maxBpm = input.maxBpm ?? 200;
  if (input.bars && input.bars >= 1 && input.toSec > input.fromSec) {
    const centre = (60 * beatsPerBar * input.bars) / (input.toSec - input.fromSec);
    minBpm = Math.max(30, centre * 0.85);
    maxBpm = Math.min(300, centre * 1.15);
  }
  if (!(input.toSec - input.fromSec >= 2)) return FAIL('El tramo es demasiado corto (menos de 2 segundos).');
  if (!(sampleRate > 0) || samples.length === 0) return FAIL('No hay audio que analizar.');
  const from = Math.max(0, input.fromSec);
  const to = Math.min(samples.length / sampleRate, input.toSec);
  // A little margin on both sides, so strikes just outside the marks still count.
  const lo = Math.max(0, Math.floor((from - 1) * sampleRate));
  const hi = Math.min(samples.length, Math.ceil((to + 1) * sampleRate));
  const curve = attackCurve(samples.subarray(lo, hi), sampleRate);
  if (curve.length === 0) return FAIL('El tramo está en silencio.');
  const shift = lo / sampleRate;
  const at = (t: number): number => t - shift; // audio time -> curve time

  // The bar line is anchored on the mark: the user puts «desde» on the first beat of the first bar, give or take
  // a few hundredths. (Music full of off-beat strikes cannot say where the bar starts by itself: an eighth-note
  // grid fits just as well, half a beat off.) So only the tempo and a small fine-tune of the start are searched.
  interface Fit {
    score: number;
    bpm: number;
    first: number;
    sum: number;
    count: number;
  }
  const sweep = (lowBpm: number, highBpm: number): Fit => {
    const fit: Fit = { score: -1, bpm: 0, first: from, sum: 0, count: 0 };
    for (let bpm = lowBpm; bpm <= highBpm; bpm += 0.1) {
      const beat = 60 / bpm;
      for (let t0 = from - 0.08; t0 <= from + 0.0801; t0 += 0.005) {
        const times: number[] = [];
        for (let t = t0; t < to - beat / 2; t += beat) times.push(at(t));
        const sc = gridScore(curve, times, Math.max(1, Math.round((to - from) / beat)));
        fit.sum += sc;
        fit.count++;
        if (sc > fit.score) {
          fit.score = sc;
          fit.bpm = bpm;
          fit.first = t0;
        }
      }
    }
    return fit;
  };
  let fit = sweep(minBpm, maxBpm);
  if (!(fit.score > 0) || fit.count === 0) return FAIL('No encuentro golpes claros en el tramo.');
  const mean = fit.sum / fit.count;
  // A grid at half speed explains the strong strikes but leaves the others unexplained: when the double speed
  // is nearly as good, that is the one that describes the music (the user's bar count settles it either way).
  if (!input.bars && fit.bpm * 2 <= maxBpm) {
    const fast = sweep(fit.bpm * 1.96, Math.min(maxBpm, fit.bpm * 2.04));
    if (fast.count > 0 && fast.score >= 0.85 * fit.score) fit = { ...fast, sum: fit.sum, count: fit.count };
  }
  const bestScore = fit.score;
  const bestBpm = fit.bpm;
  const first = fit.first;
  const beat = 60 / bestBpm;
  const barLen = beat * beatsPerBar;
  const bars = input.bars && input.bars >= 1 ? Math.round(input.bars) : Math.round((to - first) / barLen);
  if (bars < 1) return FAIL('En ese tramo no cabe ni un compás entero.');
  const barStarts = Array.from({ length: bars }, (_, k) => first + k * barLen);
  return {
    ok: true,
    reason: '',
    bpm: Math.round(bestBpm * 10) / 10,
    beatsPerBar,
    bars,
    firstBeatSec: first,
    endSec: first + bars * barLen,
    barStarts,
    confidence: mean > 0 ? Math.max(0, Math.min(1, 1 - mean / bestScore)) : 0,
  };
}

/**
 * A first guess for the stretch to analyse: from the first strike to the strike that follows the first
 * long pause (2.5 s: the end of an intro, a break…). Null when the audio has no strikes.
 */
export function suggestSpan(samples: Float32Array, sampleRate: number, maxSec = 90): { fromSec: number; toSec: number } | null {
  const attacks = energyAttacks(samples, sampleRate, 0, Math.min(maxSec, samples.length / sampleRate), 0.07);
  if (attacks.length < 4) return null;
  const fromSec = attacks[0];
  for (let i = 3; i < attacks.length; i++) {
    if (attacks[i] - attacks[i - 1] >= 2.5) return { fromSec, toSec: attacks[i] };
  }
  return { fromSec, toSec: attacks[attacks.length - 1] };
}
