/**
 * Strumming-pattern detection from a backing track: given the beat grid (tempo, first downbeat
 * and meter) it measures which subdivisions of the bar carry an attack in the audio and turns
 * them into a `strum:` pattern, so the highway arrows land on the strums that are really heard.
 * Pure TypeScript on typed arrays (no Web Audio), testable in Node. See docs/SPEC.md section 14.
 *
 * Pipeline:
 *  1. Onset envelope exactly as tempoEstimate.ts (decimation to ~11025 Hz, STFT 1024/256,
 *     half-wave rectified flux of log(1 + |X|) minus a centred 0.5 s moving average).
 *  2. Bar grid: beat T = 60 / bpm, bars from `firstDownbeatSec` to the end of the analysed audio;
 *     bars whose onset energy (sum of env^2) is below 10 % of the median bar are dropped (silence).
 *  3. Sixteenth-note slot strength: s[k] = max of the envelope in
 *     [t_k - 0.12 T/4, t_k + 0.12 T/4 + 60 ms] (a strum's flux peaks a few tens of ms late, see
 *     SLOT_LOOKAHEAD_SEC), averaged per slot over the kept bars and normalised to the strongest
 *     slot -> slot16 (4 x beatsPerBar).
 *  4. Subdivision: odd sixteenth slots (positions 1 and 3 of every beat) above SIXTEENTH_RATIO of
 *     the eighth slots -> 4 characters per beat, otherwise 2 (the resolution of every editor
 *     preset; see chooseCharsPerBeat). slotStrength = slot16 reduced to that resolution (mean of
 *     the grouped slots) and re-normalised to its strongest slot.
 *  5. A slot is a strum when slotStrength >= ACTIVE_THRESHOLD (the downbeat always is): even
 *     slots -> D, odd slots -> U (the hand alternates), the rest '-'.
 *  6. confidence = fraction of the kept bars whose own active set (same threshold on the bar
 *     alone) matches the pattern in >= 75 % of the positions.
 */
import type { StrumDetection } from '../types';
import { decimateForTempo, onsetEnvelope } from './tempoEstimate';

export interface StrumDetectOpts {
  /** Tempo of the grid, beats per minute. */
  bpm: number;
  /** Seconds into the audio of the first downbeat (start of bar 1); negative when the chart starts before the audio. */
  firstDownbeatSec: number;
  beatsPerBar: number;
  /** Only the first `maxSeconds` of audio are analysed (default 120). */
  maxSeconds?: number;
  /**
   * Tracked beat times in seconds (beat 0 = first downbeat, one entry per beat). When given,
   * bars and slots follow these times (so a song that speeds up or slows down stays aligned)
   * instead of the constant `bpm` / `firstDownbeatSec` grid.
   */
  beatTimes?: number[];
  /** Accepted for symmetry with the other analysers; the onset envelope is pitch-agnostic, so it is unused. */
  a4?: number;
}

/** One analysed bar: its span and the audio time of each of its sixteenth slots. */
interface BarGrid {
  start: number;
  end: number;
  slots: number[];
  /** Local sixteenth duration (window sizing). */
  slotSec: number;
}

/**
 * Bars covering the analysed audio. With `opts.beatTimes` every slot is interpolated between
 * consecutive tracked beats (beats past the last one are extrapolated with the last interval);
 * otherwise a constant grid from `firstDownbeatSec` at `bpm`. Bars that end after the audio
 * (beyond a small slack) are dropped.
 */
function buildBarGrid(opts: StrumDetectOpts, beatsPerBar: number, beatSec: number, nSlots16: number, durationSec: number): BarGrid[] {
  const grid: BarGrid[] = [];
  const bt = opts.beatTimes;
  if (bt && bt.length > beatsPerBar) {
    const lastInterval = bt.length >= 2 ? Math.max(1e-3, bt[bt.length - 1] - bt[bt.length - 2]) : beatSec;
    const beatAt = (j: number): number => (j < bt.length ? bt[j] : bt[bt.length - 1] + (j - (bt.length - 1)) * lastInterval);
    for (let first = 0; first + beatsPerBar <= bt.length; first += beatsPerBar) {
      const start = beatAt(first);
      const end = beatAt(first + beatsPerBar);
      if (!(end > start)) break;
      const slotSec = (end - start) / nSlots16;
      if (end > durationSec + BAR_END_SLACK * slotSec) break;
      const slots: number[] = [];
      for (let k = 0; k < nSlots16; k++) {
        const j = first + (k >> 2);
        const a = beatAt(j);
        const b = beatAt(j + 1);
        slots.push(a + ((k & 3) / 4) * (b - a));
      }
      grid.push({ start, end, slots, slotSec });
    }
    return grid;
  }
  const slotSec = beatSec / 4;
  const barSec = beatSec * beatsPerBar;
  const firstBar = opts.firstDownbeatSec >= 0 ? 0 : Math.ceil(-opts.firstDownbeatSec / barSec);
  for (let b = firstBar; ; b++) {
    const start = opts.firstDownbeatSec + b * barSec;
    if (start + barSec > durationSec + BAR_END_SLACK * slotSec) break;
    const slots: number[] = [];
    for (let k = 0; k < nSlots16; k++) slots.push(start + k * slotSec);
    grid.push({ start, end: start + barSec, slots, slotSec });
  }
  return grid;
}

/** Below this RMS the signal counts as silence (same gate as tempoEstimate.ts). */
const SILENCE_RMS = 1e-4;
/** Default analysed span, seconds. */
const DEFAULT_MAX_SECONDS = 120;
/** Half-width of a slot window as a fraction of a sixteenth note. */
const SLOT_HALF_WIDTH = 0.12;
/**
 * Extra look-ahead after the nominal slot time, seconds (capped at half a sixteenth so the window
 * never reaches the next slot's attack). Measured on the 1024/256 STFT flux of a strum whose six
 * strings are staggered 8 ms: a down-strum peaks 22..45 ms after its nominal time and an
 * up-strum (loud low strings last) 35..54 ms after it, so the 30 ms of the spec missed the
 * up-strum peak frame in about half of the bars.
 */
const SLOT_LOOKAHEAD_SEC = 0.06;
/**
 * Bars whose onset energy (sum of the squared envelope) is below this fraction of the median bar
 * are silence. The square matters: the rectified residual of a -40 dBFS noise floor summed over
 * a bar is ~25 % of a strummed bar's plain envelope sum, but ~2 % of its energy.
 */
const SILENT_BAR_FRACTION = 0.1;
/**
 * Odd sixteenth slots above this fraction of the eighth slots -> sixteenth resolution. The spec
 * suggests 0.35, which assumes up-strums as strong as down-strums; spectral flux measures the
 * INCREASE over what is still ringing, so an up-strum a sixteenth after a same-chord down-strum
 * reads 0.35..0.55 of it and a real 16th pattern (D-DUD-DUD-DUD-DU) measures 0.14..0.32 across
 * 80..200 BPM, while pure 8th patterns leak <= 0.01 into the odd slots at every tempo.
 */
const SIXTEENTH_RATIO = 0.12;
/**
 * Minimum normalised slot strength of a strum. The spec suggests 0.4; measured on the synthetic
 * progressions, rests stay <= 0.08 of the strongest slot while up-strums read 0.34..0.75 of it
 * depending on the tempo (they follow a same-chord down-strum whose partials still ring, so their
 * flux is small), and at 0.4 the up-strums of 8th patterns start dropping out around 140 BPM and
 * half of the 16th up-strums are lost at 100 BPM. 0.3 keeps a 3.7x margin over the rests.
 */
const ACTIVE_THRESHOLD = 0.3;
/** A bar agrees with the pattern when this fraction of its slots has the same state. */
const BAR_AGREEMENT = 0.75;
/** A bar is analysed when at most this fraction of a sixteenth is missing at the end of the audio. */
const BAR_END_SLACK = 0.5;

function silentDetection(beatsPerBar: number): StrumDetection {
  return {
    pattern: 'D-'.repeat(beatsPerBar),
    charsPerBeat: 2,
    slotStrength: new Array<number>(2 * beatsPerBar).fill(0),
    confidence: 0,
    bars: 0,
  };
}

/**
 * Sixteenth slots grouped `4 / charsPerBeat` at a time (mean), normalised to the strongest
 * group (all zeros stay zeros).
 */
function reduceSlots(slots16: ArrayLike<number>, offset: number, nSlots16: number, charsPerBeat: 2 | 4): number[] {
  const group = 4 / charsPerBeat;
  const n = nSlots16 / group;
  const out = new Array<number>(n);
  let max = 0;
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let g = 0; g < group; g++) acc += slots16[offset + j * group + g];
    out[j] = acc / group;
    if (out[j] > max) max = out[j];
  }
  if (max > 0) for (let j = 0; j < n; j++) out[j] /= max;
  return out;
}

/** Active slots: strength >= ACTIVE_THRESHOLD; the downbeat (slot 0) always is. */
function activeSlots(strength: number[]): boolean[] {
  return strength.map((v, j) => j === 0 || v >= ACTIVE_THRESHOLD);
}

/**
 * Sixteenth resolution when the odd sixteenth slots carry more than SIXTEENTH_RATIO of the eighth
 * slots AND at least one of them is strong enough to be a strum (otherwise the extra slots would
 * all be rests: in a sparse pattern such as D---D--- the noise floor of eight odd slots adds up
 * against only two strong eighth slots). Eighth resolution otherwise. The spec also describes a
 * reduction to one character per beat when the eighth off-beats stay under 25 % of the beats,
 * but its own acceptance cases ('D-D-D-D-' -> 'D-D-D-D-', 'D---D---' -> 'D---D---') and every
 * editor preset are written at two characters per beat, so that reduction is deliberately not
 * applied: a beat-only pattern comes back as 'D-D-D-D-' (which the parser treats exactly like
 * 'DDDD') and matches the presets.
 */
function chooseCharsPerBeat(slot16: Float64Array): 2 | 4 {
  let odd = 0;
  let oddMax = 0;
  let eighth = 0;
  for (let k = 0; k < slot16.length; k++) {
    if (k % 2 === 1) {
      odd += slot16[k];
      if (slot16[k] > oddMax) oddMax = slot16[k];
    } else {
      eighth += slot16[k];
    }
  }
  return odd > SIXTEENTH_RATIO * eighth && oddMax >= ACTIVE_THRESHOLD ? 4 : 2;
}

/**
 * Even slots -> 'D', odd slots -> 'U': the hand alternates down / up over the beat at both
 * resolutions (eighths: 1 &  = D U; sixteenths: 1 e & a = D U D U). The spec's text puts the
 * third sixteenth of a beat on 'U' ("positions 2 and 3"), but its own acceptance case
 * 'D-DUD-DUD-DUD-DU' (a down-strum on every "&") can only be matched with the alternation, which
 * is also how sixteenth strumming is played and written.
 */
function directionChar(slot: number): 'D' | 'U' {
  return slot % 2 === 0 ? 'D' : 'U';
}

/**
 * Detects the strumming pattern of `samples` on the bar grid given by `opts`. Near-silent input
 * (RMS < 1e-4 over the analysed span), no onset energy or no complete bar inside the audio
 * returns the default pattern ('D-' per beat) with confidence 0 and bars 0.
 */
export function detectStrumPattern(samples: Float32Array, sampleRate: number, opts: StrumDetectOpts): StrumDetection {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`detectStrumPattern: invalid sampleRate ${sampleRate}`);
  }
  // The song grammar admits 20..400 BPM; a wider guard keeps the bar loop finite whatever comes in.
  if (!Number.isFinite(opts.bpm) || opts.bpm < 10 || opts.bpm > 1000) {
    throw new RangeError(`detectStrumPattern: invalid bpm ${opts.bpm}`);
  }
  if (!Number.isInteger(opts.beatsPerBar) || opts.beatsPerBar < 1 || opts.beatsPerBar > 32) {
    throw new RangeError(`detectStrumPattern: invalid beatsPerBar ${opts.beatsPerBar}`);
  }
  if (!Number.isFinite(opts.firstDownbeatSec)) {
    throw new RangeError(`detectStrumPattern: invalid firstDownbeatSec ${opts.firstDownbeatSec}`);
  }
  const beatsPerBar = opts.beatsPerBar;
  const maxSeconds =
    Number.isFinite(opts.maxSeconds) && (opts.maxSeconds as number) > 0 ? (opts.maxSeconds as number) : DEFAULT_MAX_SECONDS;

  // (1) decimation, silence gate, onset envelope
  const { data, rate, rms } = decimateForTempo(samples, sampleRate, maxSeconds);
  if (rms < SILENCE_RMS) return silentDetection(beatsPerBar);
  const { env, frameRate, frameOffsetSec } = onsetEnvelope(data, rate);
  const frames = env.length;
  let envMax = 0;
  for (let i = 0; i < frames; i++) if (env[i] > envMax) envMax = env[i];
  if (frames === 0 || !(envMax > 0)) return silentDetection(beatsPerBar);
  // Cumulative onset energy (env^2) for the per-bar silence test.
  const cum = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cum[i + 1] = cum[i] + env[i] * env[i];

  /** Frame index of a time, clamped to the envelope. */
  const frameOf = (sec: number, round: (x: number) => number): number => {
    const n = round((sec - frameOffsetSec) * frameRate);
    return n < 0 ? 0 : n > frames - 1 ? frames - 1 : n;
  };
  /** Largest envelope value at the frames inside [a, b] (the nearest frame when none falls inside). */
  const maxEnvIn = (a: number, b: number): number => {
    let n0 = frameOf(a, Math.ceil);
    let n1 = frameOf(b, Math.floor);
    if (n0 > n1) n0 = n1 = frameOf(0.5 * (a + b), Math.round);
    let m = 0;
    for (let n = n0; n <= n1; n++) if (env[n] > m) m = env[n];
    return m;
  };

  // (2) bar grid over the analysed audio: tracked beat times when given, else a constant grid
  const beatSec = 60 / opts.bpm;
  const nSlots16 = 4 * beatsPerBar;
  const durationSec = data.length / rate;
  const grid = buildBarGrid(opts, beatsPerBar, beatSec, nSlots16, durationSec);
  const nBars = grid.length;
  if (nBars === 0) return silentDetection(beatsPerBar);

  // (3) sixteenth slot strengths per bar, bar energies
  const strengths = new Float64Array(nBars * nSlots16);
  const energy = new Float64Array(nBars);
  for (let b = 0; b < nBars; b++) {
    const bar = grid[b];
    const half = SLOT_HALF_WIDTH * bar.slotSec;
    const lookahead = Math.min(SLOT_LOOKAHEAD_SEC, 0.5 * bar.slotSec);
    for (let k = 0; k < nSlots16; k++) {
      const t = bar.slots[k];
      strengths[b * nSlots16 + k] = maxEnvIn(t - half, t + half + lookahead);
    }
    const n0 = frameOf(bar.start, Math.ceil);
    const n1 = frameOf(bar.end, Math.ceil);
    energy[b] = cum[n1] - cum[n0];
  }
  const sorted = Array.from(energy).sort((x, y) => x - y);
  const median = nBars % 2 === 1 ? sorted[(nBars - 1) >> 1] : 0.5 * (sorted[nBars / 2 - 1] + sorted[nBars / 2]);
  const kept: number[] = [];
  for (let b = 0; b < nBars; b++) if (energy[b] > 0 && energy[b] >= SILENT_BAR_FRACTION * median) kept.push(b);
  if (kept.length === 0) return silentDetection(beatsPerBar);

  const slot16 = new Float64Array(nSlots16);
  for (const b of kept) for (let k = 0; k < nSlots16; k++) slot16[k] += strengths[b * nSlots16 + k];
  let slotMax = 0;
  for (let k = 0; k < nSlots16; k++) {
    slot16[k] /= kept.length;
    if (slot16[k] > slotMax) slotMax = slot16[k];
  }
  if (!(slotMax > 0)) return silentDetection(beatsPerBar);
  for (let k = 0; k < nSlots16; k++) slot16[k] /= slotMax;

  // (4) subdivision and reduced strengths
  const charsPerBeat = chooseCharsPerBeat(slot16);
  const slotStrength = reduceSlots(slot16, 0, nSlots16, charsPerBeat);

  // (5) threshold and directions
  const active = activeSlots(slotStrength);
  let pattern = '';
  for (let j = 0; j < active.length; j++) pattern += active[j] ? directionChar(j) : '-';

  // (6) confidence: bars whose own active set agrees with the pattern
  let agreeing = 0;
  for (const b of kept) {
    const own = activeSlots(reduceSlots(strengths, b * nSlots16, nSlots16, charsPerBeat));
    let same = 0;
    for (let j = 0; j < own.length; j++) if (own[j] === active[j]) same++;
    if (same >= BAR_AGREEMENT * own.length) agreeing++;
  }
  const confidence = agreeing / kept.length;

  return { pattern, charsPerBeat, slotStrength, confidence, bars: kept.length };
}
