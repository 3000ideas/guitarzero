/**
 * Strumming pattern from taps: the user taps (space bar / button) on every strum while the track
 * plays, and the tap times are turned into a `strum:` pattern on the song's beat grid. Pure
 * TypeScript, no DOM, testable in Node. See docs/SPEC.md section 16.
 *
 * Pipeline:
 *  1. Grid: `beatTimes` (beat 0 = first beat of bar 1, one entry per beat), extrapolated with
 *     the last interval past the last tracked beat (and with the first one before beat 0);
 *     sixteenth slots are interpolated between consecutive beats, as strumDetect.ts does.
 *  2. Tap latency: with `latencySec: 'auto'` (default) delta = median(tap - nearest eighth slot)
 *     clamped to [MIN_LATENCY_SEC, MAX_LATENCY_SEC], subtracted from every tap. The eighth grid
 *     gives a capture range of +-half an eighth, wide enough for a tablet's 100..200 ms audio
 *     latency at usual tempos; on a sixteenth pattern the off-eighth taps pull the median, but
 *     the clamp bounds the damage (the acceptance case still comes out exact).
 *  3. Every tap goes to its nearest sixteenth slot on the whole grid (a downbeat tapped a little
 *     early therefore lands on slot 0 of the bar it starts, not on the last slot of the previous
 *     one); each tap counts once, in that slot of that bar, and the bars with at least one tap
 *     are counted (`bars`). Taps before beat 0 (the count-in) are ignored.
 *  4. Subdivision: odd sixteenth slots holding >= SIXTEENTH_TAP_FRACTION of the taps ->
 *     charsPerBeat 4, otherwise 2 (each tap then goes to its nearest eighth slot).
 *     slotStrength[k] = bars in which slot k was tapped / bars (0..1): a slot tapped twice in
 *     the same bar (a bounce) counts once for that bar, so the strength really is the fraction
 *     of the bars that have the strum.
 *  5. A slot is a strum when slotStrength >= minBarFraction (default 0.5: tapped in at least
 *     half of the bars); the downbeat needs only DOWNBEAT_FRACTION. Even slots -> D, odd -> U
 *     (the hand alternates at both resolutions). No active slot -> 'D-' per beat, confidence 0.
 *  6. confidence = fraction of the bars with taps whose tapped-slot set matches the pattern in
 *     >= BAR_AGREEMENT of the positions.
 */
import type { StrumDetection } from '../types';

export interface TapsOpts {
  /** Fraction of the bars (with taps) in which a slot must be tapped to count as a strum (default 0.5). */
  minBarFraction?: number;
  /** Tap latency to subtract, seconds, or 'auto' (default) to estimate it from the taps. */
  latencySec?: number | 'auto';
}

/** Default `minBarFraction`. */
const DEFAULT_MIN_BAR_FRACTION = 0.5;
/** The downbeat is a strum when it is tapped in at least this fraction of the bars. */
const DOWNBEAT_FRACTION = 0.25;
/** Bounds of the automatic latency estimate, seconds. */
const MIN_LATENCY_SEC = -0.05;
const MAX_LATENCY_SEC = 0.2;
/** Odd sixteenth slots holding at least this fraction of the taps -> sixteenth resolution. */
const SIXTEENTH_TAP_FRACTION = 0.2;
/** A bar agrees with the pattern when this fraction of its slots has the same state. */
const BAR_AGREEMENT = 0.75;

function defaultDetection(beatsPerBar: number, bars: number): StrumDetection {
  return {
    pattern: 'D-'.repeat(beatsPerBar),
    charsPerBeat: 2,
    slotStrength: new Array<number>(2 * beatsPerBar).fill(0),
    confidence: 0,
    bars,
  };
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/**
 * Beat grid over the tracked beat times, extrapolated in both directions: past the last beat
 * with the last interval, before beat 0 with the first one.
 */
class BeatGrid {
  private readonly bt: number[];
  private readonly firstInterval: number;
  private readonly lastInterval: number;

  constructor(beatTimes: number[]) {
    this.bt = beatTimes;
    const n = beatTimes.length;
    this.firstInterval = Math.max(1e-3, beatTimes[1] - beatTimes[0]);
    this.lastInterval = Math.max(1e-3, beatTimes[n - 1] - beatTimes[n - 2]);
  }

  /** Time of beat `j` (any integer). */
  beatAt(j: number): number {
    const bt = this.bt;
    const last = bt.length - 1;
    if (j < 0) return bt[0] + j * this.firstInterval;
    if (j > last) return bt[last] + (j - last) * this.lastInterval;
    return bt[j];
  }

  /** Index of the beat at or before `t` (negative before beat 0, past the end after the last beat). */
  beatIndexAt(t: number): number {
    const bt = this.bt;
    const last = bt.length - 1;
    if (t < bt[0]) return -1 - Math.floor((bt[0] - t) / this.firstInterval);
    if (t >= bt[last]) return last + Math.floor((t - bt[last]) / this.lastInterval);
    // Binary search: largest j with bt[j] <= t.
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bt[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Global index (beat * subdiv + position) of the slot nearest to `t` at `subdiv` slots per beat. */
  nearestSlot(t: number, subdiv: number): number {
    const j = this.beatIndexAt(t);
    const a = this.beatAt(j);
    const b = this.beatAt(j + 1);
    const frac = b > a ? (t - a) / (b - a) : 0;
    return j * subdiv + Math.round(frac * subdiv);
  }

  /** Time of global slot `g` at `subdiv` slots per beat. */
  slotTime(g: number, subdiv: number): number {
    const j = Math.floor(g / subdiv);
    const pos = g - j * subdiv;
    const a = this.beatAt(j);
    const b = this.beatAt(j + 1);
    return a + (pos / subdiv) * (b - a);
  }
}

/**
 * Pattern tapped by the user on the beat grid `beatTimes` (beat 0 = first beat of bar 1, one
 * entry per beat; a grid of fewer than 2 beats cannot place a tap and gives the default). Taps
 * that are not finite numbers are ignored. No taps, or no slot tapped often enough, returns
 * 'D-' per beat with confidence 0.
 */
export function patternFromTaps(tapsSec: number[], beatTimes: number[], beatsPerBar: number, opts: TapsOpts = {}): StrumDetection {
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 32) {
    throw new RangeError(`patternFromTaps: invalid beatsPerBar ${beatsPerBar}`);
  }
  const minBarFraction =
    Number.isFinite(opts.minBarFraction) && (opts.minBarFraction as number) > 0 ? (opts.minBarFraction as number) : DEFAULT_MIN_BAR_FRACTION;
  const taps = tapsSec.filter((t) => Number.isFinite(t));
  if (taps.length === 0 || beatTimes.length < 2 || beatTimes.some((t) => !Number.isFinite(t))) {
    return defaultDetection(beatsPerBar, 0);
  }
  const grid = new BeatGrid(beatTimes);

  // (2) tap latency
  let latency: number;
  if (typeof opts.latencySec === 'number' && Number.isFinite(opts.latencySec)) {
    latency = opts.latencySec;
  } else {
    const residuals = taps.map((t) => t - grid.slotTime(grid.nearestSlot(t, 2), 2));
    latency = Math.min(MAX_LATENCY_SEC, Math.max(MIN_LATENCY_SEC, median(residuals)));
  }
  const corrected = taps.map((t) => t - latency);

  // (3) nearest sixteenth of every tap; taps before the grid (slot < 0) are dropped
  const slots16 = corrected.map((t) => grid.nearestSlot(t, 4)).filter((g) => g >= 0);
  if (slots16.length === 0) return defaultDetection(beatsPerBar, 0);

  // (4) subdivision, then taps per slot of the bar at that resolution
  let oddSixteenths = 0;
  for (const g of slots16) if (g % 2 === 1) oddSixteenths++;
  const charsPerBeat: 2 | 4 = oddSixteenths >= SIXTEENTH_TAP_FRACTION * slots16.length ? 4 : 2;
  const nSlots = charsPerBeat * beatsPerBar;
  const slotsAtRes = charsPerBeat === 4 ? slots16 : corrected.map((t) => grid.nearestSlot(t, 2)).filter((g) => g >= 0);
  /** Taps per slot of every bar that has one, keyed by bar index. */
  const barCounts = new Map<number, number[]>();
  for (const g of slotsAtRes) {
    const bar = Math.floor(g / nSlots);
    let counts = barCounts.get(bar);
    if (!counts) {
      counts = new Array<number>(nSlots).fill(0);
      barCounts.set(bar, counts);
    }
    counts[g - bar * nSlots]++;
  }
  const bars = barCounts.size;
  if (bars === 0) return defaultDetection(beatsPerBar, 0);
  const slotStrength = new Array<number>(nSlots).fill(0);
  for (const counts of barCounts.values()) for (let k = 0; k < nSlots; k++) if (counts[k] > 0) slotStrength[k]++;
  for (let k = 0; k < nSlots; k++) slotStrength[k] /= bars;

  // (5) active slots and directions
  const active = slotStrength.map((v, k) => v >= (k === 0 ? Math.min(DOWNBEAT_FRACTION, minBarFraction) : minBarFraction));
  if (!active.some((a) => a)) return defaultDetection(beatsPerBar, bars);
  let pattern = '';
  for (let k = 0; k < nSlots; k++) pattern += active[k] ? (k % 2 === 0 ? 'D' : 'U') : '-';

  // (6) confidence: bars whose tapped slots agree with the pattern
  let agreeing = 0;
  for (const counts of barCounts.values()) {
    let same = 0;
    for (let k = 0; k < nSlots; k++) if (counts[k] > 0 === active[k]) same++;
    if (same >= BAR_AGREEMENT * nSlots) agreeing++;
  }

  return { pattern, charsPerBeat, slotStrength, confidence: agreeing / bars, bars };
}
