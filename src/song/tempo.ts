/**
 * Pure tempo-map helpers (SPEC.md section 6).
 *
 * `segments` follows the invariants guaranteed by the parser: non-empty, sorted by strictly
 * increasing `fromBeat`, `segments[0].fromBeat === 0`. Beats below 0 (count-in) extrapolate
 * linearly with `segments[0]`. Nothing here depends on the time signature or on tempoScale.
 */
import type { Song, TempoSegment } from '../types';

/** Defensive fallback so a malformed (empty) tempo map never yields NaN. */
const FALLBACK_SEGMENTS: TempoSegment[] = [{ fromBeat: 0, bpm: 80 }];

function segmentsOf(segments: TempoSegment[]): TempoSegment[] {
  return segments.length > 0 ? segments : FALLBACK_SEGMENTS;
}

/** Seconds spent in a segment of `bpm` between two beat positions. */
function span(fromBeat: number, toBeat: number, bpm: number): number {
  return ((toBeat - fromBeat) * 60) / bpm;
}

/** Song seconds at `beat` (negative for beat < 0). */
export function beatToSec(segments: TempoSegment[], beat: number): number {
  const segs = segmentsOf(segments);
  let sec = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    if (next === undefined || beat <= next.fromBeat) {
      return sec + span(seg.fromBeat, beat, seg.bpm);
    }
    sec += span(seg.fromBeat, next.fromBeat, seg.bpm);
  }
  return sec;
}

/** Inverse of beatToSec: beat position at `sec` song seconds (negative for sec < 0). */
export function secToBeat(segments: TempoSegment[], sec: number): number {
  const segs = segmentsOf(segments);
  let segStartSec = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    if (next === undefined) {
      return seg.fromBeat + ((sec - segStartSec) * seg.bpm) / 60;
    }
    const segEndSec = segStartSec + span(seg.fromBeat, next.fromBeat, seg.bpm);
    if (sec <= segEndSec) {
      return seg.fromBeat + ((sec - segStartSec) * seg.bpm) / 60;
    }
    segStartSec = segEndSec;
  }
  return 0;
}

/** Total duration of the (expanded) song in song seconds. Does not apply tempoScale. */
export function songDurationSec(song: Pick<Song, 'tempoSegments' | 'totalBeats'>): number {
  return beatToSec(song.tempoSegments, song.totalBeats);
}
