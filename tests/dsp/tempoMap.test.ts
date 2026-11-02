import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { fitSync } from '../../src/dsp/syncFit';
import { followAudio, type Stretch } from '../../src/dsp/tempoMap';

const SR = 8000;
const BODY = 'C . G . | Am . . . | F . . . | G . . . |\n'.repeat(16);
const src = (bpm: number) => `tempo: ${bpm}\nstrum: D-DU-UDU\n${BODY}`;

/** A recording by a person: the tempo wanders from bar to bar, strikes are a few ms off and some are missed. */
function humanTake(seedStart: number, missing: number) {
  const { song } = parseSong(src(100));
  let seed = seedStart;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const barStart: number[] = [0.3];
  let factor = 1.02;
  for (let i = 0; i < song.bars.length; i++) {
    factor = Math.min(1.05, Math.max(0.99, factor + (rnd() - 0.5) * 0.012 + (1.02 - factor) * 0.1));
    barStart.push(barStart[i] + 2.4 * factor);
  }
  const out = new Float32Array(Math.ceil((barStart[barStart.length - 1] + 2) * SR));
  for (const e of song.events) {
    if (rnd() < missing) continue;
    const bar = song.bars[e.barIndex];
    const frac = (e.time - bar.startBeat) / bar.beats;
    const t = barStart[e.barIndex] + frac * (barStart[e.barIndex + 1] - barStart[e.barIndex]) + (rnd() - 0.5) * 0.03;
    const s0 = Math.round(t * SR);
    const amp = 0.5 + rnd() * 0.5;
    for (let i = 0; i < 0.25 * SR && s0 + i < out.length; i++) out[s0 + i] += (Math.sin(i * 0.3) * 0.7 + (rnd() * 2 - 1) * 0.3) * Math.exp(-i / 500) * amp;
  }
  return { song, out, barStart };
}

describe('followAudio', () => {
  it.each([[8, 0.25], [9, 0.4], [10, 0.1]])('follows a wandering recording (seed %i, %f of the strikes missed)', (seed, missing) => {
    const { song, out, barStart } = humanTake(seed, missing);
    const fit = fitSync({ samples: out, sampleRate: SR, offsetSec: 0.3, segments: song.tempoSegments, strikes: song.events.map((e) => e.time), beatSec: 0.6, allowTempo: true });
    const k = fit.tempoFactor;
    const off = 0.3 + fit.deltaSec;
    const song2 = parseSong(src(Math.round((100 / k) * 100) / 100)).song;
    const stretches: Stretch[] = [];
    for (let b = 0; b < song2.bars.length; b += 4) stretches.push({ fromBar: b, toBar: b + 4, retimable: true });
    const map = followAudio(out, SR, off, song2, stretches);
    expect(map.ok).toBe(true);
    const truth = stretches.map((st) => barStart[st.fromBar] - (off + st.fromBar * 2.4 * k));
    const err = map.anchors.slice(0, stretches.length).map((a, i) => Math.abs(a - truth[i])).sort((x, y) => x - y);
    expect(err[err.length >> 1]).toBeLessThan(0.015);
    expect(err[err.length - 1]).toBeLessThan(0.04);
    expect(map.after).toBeGreaterThan(map.before + 0.15);
    expect(map.bpm.every((b) => b > 90 && b < 110)).toBe(true);
  });

  it('a stretch that cannot be retimed keeps its written duration', () => {
    const { song, out } = humanTake(10, 0.1);
    const fit = fitSync({ samples: out, sampleRate: SR, offsetSec: 0.3, segments: song.tempoSegments, strikes: song.events.map((e) => e.time), beatSec: 0.6, allowTempo: true });
    const song2 = parseSong(src(Math.round((100 / fit.tempoFactor) * 100) / 100)).song;
    const stretches: Stretch[] = [];
    for (let b = 0; b < song2.bars.length; b += 4) stretches.push({ fromBar: b, toBar: b + 4, retimable: b !== 8 });
    const map = followAudio(out, SR, 0.3 + fit.deltaSec, song2, stretches);
    expect(map.anchors[3]).toBeCloseTo(map.anchors[2], 6);
    expect(map.bpm[2]).toBeCloseTo(Math.round((100 / fit.tempoFactor) * 100) / 100, 1);
  });

  it('refuses silence and nearly empty audio', () => {
    const { song } = humanTake(1, 0);
    const stretches: Stretch[] = [{ fromBar: 0, toBar: 4, retimable: true }];
    expect(followAudio(new Float32Array(10 * SR), SR, 0.3, song, stretches).ok).toBe(false);
    expect(followAudio(new Float32Array(0), SR, 0.3, song, stretches).ok).toBe(false);
  });
});
