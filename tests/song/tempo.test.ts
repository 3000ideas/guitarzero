import { describe, expect, it } from 'vitest';
import { beatToSec, secToBeat, songDurationSec } from '../../src/song/tempo';
import { parseSong } from '../../src/song/parser';
import type { TempoSegment } from '../../src/types';

// ---------------------------------------------------------------- fixtures

/** The tempo map of SPEC.md section 6: 120 bpm for 8 beats, then 60 bpm. */
const TWO: TempoSegment[] = [
  { fromBeat: 0, bpm: 120 },
  { fromBeat: 8, bpm: 60 },
];
const ONE: TempoSegment[] = [{ fromBeat: 0, bpm: 120 }];
const THREE: TempoSegment[] = [
  { fromBeat: 0, bpm: 100 },
  { fromBeat: 4, bpm: 140 },
  { fromBeat: 12, bpm: 100 },
];

const src = (...lines: string[]): string => lines.join('\n');

// ---------------------------------------------------------------- beatToSec

describe('beatToSec', () => {
  it('SPEC: [{0,120},{8,60}] -> beatToSec(12) === 8', () => {
    expect(beatToSec(TWO, 12)).toBe(8);
  });

  it('extrapolates linearly with segments[0] for negative beats: beatToSec(-4) === -2', () => {
    expect(beatToSec(TWO, -4)).toBe(-2);
    expect(beatToSec(TWO, -1)).toBe(-0.5);
    expect(beatToSec(THREE, -10)).toBeCloseTo(-6, 12);
  });

  it('is 0 at beat 0 and linear inside a single segment', () => {
    expect(beatToSec(ONE, 0)).toBe(0);
    expect(beatToSec(ONE, 1)).toBe(0.5);
    expect(beatToSec(ONE, 4)).toBe(2);
    expect(beatToSec(ONE, 2.5)).toBe(1.25);
    expect(beatToSec([{ fromBeat: 0, bpm: 80 }], 8)).toBe(6);
  });

  it('is exact at segment boundaries', () => {
    expect(beatToSec(TWO, 0)).toBe(0);
    expect(beatToSec(TWO, 8)).toBe(4);
    expect(beatToSec(TWO, 8.5)).toBe(4.5);
    expect(beatToSec(THREE, 4)).toBeCloseTo(2.4, 12);
    expect(beatToSec(THREE, 12)).toBeCloseTo(2.4 + (8 * 60) / 140, 12);
  });

  it('accumulates every previous segment', () => {
    expect(beatToSec(THREE, 16)).toBeCloseTo(2.4 + (8 * 60) / 140 + 2.4, 12);
    expect(beatToSec(THREE, 6)).toBeCloseTo(2.4 + (2 * 60) / 140, 12);
  });

  it('is strictly increasing in beat', () => {
    let prev = beatToSec(THREE, -5);
    for (let b = -4.75; b <= 20; b += 0.25) {
      const s = beatToSec(THREE, b);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('never consults the time signature: a 6/8 bar at 120 lasts 3 s', () => {
    expect(beatToSec([{ fromBeat: 0, bpm: 120 }], 6)).toBe(3);
    const r = parseSong(src('tempo: 120', 'time: 6/8', 'C*6 |'));
    expect(r.errors).toEqual([]);
    expect(r.song.totalBeats).toBe(6);
    expect(beatToSec(r.song.tempoSegments, r.song.totalBeats)).toBe(3);
  });

  it('never yields NaN for an empty tempo map (defensive fallback)', () => {
    expect(Number.isNaN(beatToSec([], 4))).toBe(false);
    expect(Number.isNaN(secToBeat([], 4))).toBe(false);
    expect(beatToSec([], 0)).toBe(0);
  });
});

// ---------------------------------------------------------------- secToBeat

describe('secToBeat', () => {
  it('inverts beatToSec for several beats, including negatives and segment boundaries', () => {
    const beats = [-8, -4, -1, -0.5, 0, 0.25, 1, 3, 7.99, 8, 8.01, 10, 12, 16, 20, 100];
    for (const segs of [ONE, TWO, THREE]) {
      for (const b of beats) {
        expect(secToBeat(segs, beatToSec(segs, b))).toBeCloseTo(b, 9);
      }
    }
  });

  it('inverts in the other direction too (beatToSec(secToBeat(s)) ≈ s)', () => {
    for (const s of [-3, -0.25, 0, 0.5, 2.4, 3, 4, 5.828, 8, 30]) {
      expect(beatToSec(THREE, secToBeat(THREE, s))).toBeCloseTo(s, 9);
    }
  });

  it('SPEC map: 8 s is beat 12, 4 s is beat 8, -2 s is beat -4', () => {
    expect(secToBeat(TWO, 8)).toBe(12);
    expect(secToBeat(TWO, 4)).toBe(8);
    expect(secToBeat(TWO, -2)).toBe(-4);
    expect(secToBeat(TWO, 0)).toBe(0);
    expect(secToBeat(TWO, 2)).toBe(4); // still in the 120 bpm segment
    expect(secToBeat(TWO, 6)).toBe(10); // 2 s into the 60 bpm segment
  });

  it('single segment: sec * bpm / 60', () => {
    expect(secToBeat(ONE, 1)).toBe(2);
    expect(secToBeat(ONE, -1)).toBe(-2);
    expect(secToBeat([{ fromBeat: 0, bpm: 90 }], 2)).toBe(3);
  });

  it('is strictly increasing in seconds', () => {
    let prev = secToBeat(THREE, -3);
    for (let s = -2.9; s <= 15; s += 0.1) {
      const b = secToBeat(THREE, s);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
  });
});

// ---------------------------------------------------------------- songDurationSec

describe('songDurationSec', () => {
  it('equals beatToSec(tempoSegments, totalBeats)', () => {
    expect(songDurationSec({ tempoSegments: TWO, totalBeats: 12 })).toBe(8);
    expect(songDurationSec({ tempoSegments: TWO, totalBeats: 4 })).toBe(2);
    expect(songDurationSec({ tempoSegments: THREE, totalBeats: 16 })).toBe(beatToSec(THREE, 16));
  });

  it('is 0 for an empty song', () => {
    expect(songDurationSec(parseSong('tempo: 100').song)).toBe(0);
    expect(songDurationSec({ tempoSegments: ONE, totalBeats: 0 })).toBe(0);
  });

  it('a 6/8 bar at 120 lasts 3 s', () => {
    const r = parseSong(src('tempo: 120', 'time: 6/8', 'C . . . . . |'));
    expect(r.errors).toEqual([]);
    expect(songDurationSec(r.song)).toBe(3);
  });

  it('follows the expanded song with a mid-song tempo change', () => {
    // 8 beats at 120 (4 s) + 4 beats at 60 (4 s), then the section is recalled at its own tempos
    const r = parseSong(src('tempo: 120', '[A]', 'C . . . | G . . . |', 'tempo: 60', 'Am . . . |', '[A]'));
    expect(r.errors).toEqual([]);
    expect(r.song.tempoSegments).toEqual([
      { fromBeat: 0, bpm: 120 },
      { fromBeat: 8, bpm: 60 },
      { fromBeat: 12, bpm: 120 },
      { fromBeat: 20, bpm: 60 },
    ]);
    expect(songDurationSec(r.song)).toBe(16);
  });

  it('accepts a full Song and does not scale by any tempoScale', () => {
    const r = parseSong(src('tempo: 60', 'C . . . | G . . . | x2'));
    expect(songDurationSec(r.song)).toBe(16);
    // duration only depends on the tempo map and totalBeats: no other field is read
    expect(songDurationSec({ ...r.song, tempoSegments: [{ fromBeat: 0, bpm: 120 }] })).toBe(8);
  });
});
