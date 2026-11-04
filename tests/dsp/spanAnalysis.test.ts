import { describe, expect, it } from 'vitest';
import { analyzeSpan, suggestSpan } from '../../src/dsp/spanAnalysis';

const SR = 8000;

/** A decaying burst at every beat of a grid (accented on the first beat of each bar), plus off-beat strikes. */
function render(opts: { bpm: number; firstSec: number; bars: number; seconds: number; offbeats?: boolean }): Float32Array {
  const out = new Float32Array(Math.round(opts.seconds * SR));
  const beat = 60 / opts.bpm;
  let seed = 7;
  const burst = (t: number, amp: number): void => {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 0.2 * SR && s0 + i < out.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[s0 + i] += (Math.sin(i * 0.3) * 0.7 + ((seed / 4294967296) * 2 - 1) * 0.3) * Math.exp(-i / 400) * amp;
    }
  };
  for (let k = 0; k < opts.bars * 4; k++) {
    burst(opts.firstSec + k * beat, k % 4 === 0 ? 1 : 0.7);
    if (opts.offbeats) burst(opts.firstSec + (k + 0.5) * beat, 0.4);
  }
  return out;
}

describe('analyzeSpan', () => {
  it('finds the tempo, the bars and where they start', () => {
    const audio = render({ bpm: 120, firstSec: 1, bars: 4, seconds: 10 });
    const r = analyzeSpan({ samples: audio, sampleRate: SR, fromSec: 1.02, toSec: 8.9 });
    expect(r.ok).toBe(true);
    expect(r.bpm).toBeGreaterThan(118.5);
    expect(r.bpm).toBeLessThan(121.5);
    expect(r.bars).toBe(4);
    expect(r.firstBeatSec).toBeGreaterThan(0.97);
    expect(r.firstBeatSec).toBeLessThan(1.05);
    expect(r.barStarts).toHaveLength(4);
    expect(r.barStarts[1] - r.barStarts[0]).toBeCloseTo(2, 1);
    expect(r.endSec).toBeCloseTo(9, 0);
  });

  it('uses the number of bars the user gives to settle between half and double speed', () => {
    const audio = render({ bpm: 130, firstSec: 0.5, bars: 8, seconds: 18, offbeats: true });
    const r = analyzeSpan({ samples: audio, sampleRate: SR, fromSec: 0.5, toSec: 15.4, bars: 8 });
    expect(r.ok).toBe(true);
    expect(r.bars).toBe(8);
    expect(r.bpm).toBeGreaterThan(128);
    expect(r.bpm).toBeLessThan(132);
    expect(r.barStarts).toHaveLength(8);
  });

  it('keeps the first bar line on the mark even when off-beat strikes are as loud', () => {
    const audio = render({ bpm: 100, firstSec: 2, bars: 4, seconds: 14, offbeats: true });
    const r = analyzeSpan({ samples: audio, sampleRate: SR, fromSec: 2, toSec: 11.5, bars: 4 });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.firstBeatSec - 2)).toBeLessThan(0.09);
  });

  it('says so when the stretch is silent or too short', () => {
    expect(analyzeSpan({ samples: new Float32Array(SR * 10), sampleRate: SR, fromSec: 0, toSec: 8 }).ok).toBe(false);
    expect(analyzeSpan({ samples: render({ bpm: 120, firstSec: 0, bars: 2, seconds: 5 }), sampleRate: SR, fromSec: 0, toSec: 1 }).ok).toBe(false);
  });
});

describe('suggestSpan', () => {
  it('goes from the first strike to the strike after the first long pause', () => {
    const a = render({ bpm: 120, firstSec: 1, bars: 2, seconds: 20 });
    const b = render({ bpm: 120, firstSec: 10, bars: 1, seconds: 20 });
    const audio = a.map((v, i) => v + b[i]);
    const s = suggestSpan(audio, SR);
    expect(s).not.toBeNull();
    expect(s!.fromSec).toBeCloseTo(1, 1);
    expect(s!.toSec).toBeCloseTo(10, 1);
  });

  it('returns null for silence', () => {
    expect(suggestSpan(new Float32Array(SR * 5), SR)).toBeNull();
  });
});
