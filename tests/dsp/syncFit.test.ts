import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { beatToSec } from '../../src/song/tempo';
import { describeFit, fitSync } from '../../src/dsp/syncFit';

const SR = 8000;
const SOURCE = 'tempo: 100\nstrum: D-DU-UDU\n' + 'C . G . | Am . . . | F . . . | G . . . |\n'.repeat(5);

/** Audio with a decaying burst at every strike of the text, played with its own offset and tempo factor. */
function renderAudio(trueOffset: number, factor: number, seconds: number, skipEvery = 0): Float32Array {
  const { song } = parseSong(SOURCE);
  const out = new Float32Array(Math.round(seconds * SR));
  let seed = 3;
  song.events.forEach((e, n) => {
    if (skipEvery > 0 && n % skipEvery === 0) return;
    const t = trueOffset + beatToSec(song.tempoSegments, e.time) * factor;
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 0.25 * SR && s0 + i < out.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[s0 + i] += (Math.sin(i * 0.3) * 0.7 + ((seed / 4294967296) * 2 - 1) * 0.3) * Math.exp(-i / 500) * (e.direction === 'up' ? 0.6 : 1);
    }
  });
  return out;
}

function input(audio: Float32Array, offsetSec: number, allowTempo: boolean) {
  const { song } = parseSong(SOURCE);
  return {
    samples: audio,
    sampleRate: SR,
    offsetSec,
    segments: song.tempoSegments,
    strikes: song.events.map((e) => e.time),
    beatSec: 60 / song.tempo,
    allowTempo,
  };
}

describe('fitSync', () => {
  it('finds a start offset that is off by tens of milliseconds', () => {
    const audio = renderAudio(0.5, 1, 40);
    const fit = fitSync(input(audio, 0.46, false));
    expect(fit.ok).toBe(true);
    expect(fit.deltaSec).toBeGreaterThan(0.032);
    expect(fit.deltaSec).toBeLessThan(0.048);
    expect(fit.after).toBeGreaterThanOrEqual(0.9);
    expect(fit.before).toBeLessThan(fit.after);
  });

  it('works in the other direction', () => {
    const audio = renderAudio(0.4, 1, 40);
    const fit = fitSync(input(audio, 0.47, false));
    expect(fit.deltaSec).toBeGreaterThan(-0.08);
    expect(fit.deltaSec).toBeLessThan(-0.06);
  });

  it('corrects a slightly different tempo too, when allowed', () => {
    const audio = renderAudio(0.3, 1.01, 40);
    const fit = fitSync(input(audio, 0.3, true));
    expect(fit.ok).toBe(true);
    expect(fit.tempoFactor).toBeGreaterThan(1.007);
    expect(fit.tempoFactor).toBeLessThan(1.013);
    expect(fit.after).toBeGreaterThanOrEqual(0.9);
  });

  it('finds both a big start error and a tempo drift at once', () => {
    const fit = fitSync(input(renderAudio(0.5, 1.01, 40), 0.3, true));
    expect(fit.ok).toBe(true);
    expect(fit.deltaSec).toBeGreaterThan(0.18);
    expect(fit.deltaSec).toBeLessThan(0.22);
    expect(fit.tempoFactor).toBeGreaterThan(1.007);
    expect(fit.tempoFactor).toBeLessThan(1.013);
    expect(fit.after).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves the tempo alone when it is not allowed', () => {
    const fit = fitSync(input(renderAudio(0.3, 1.01, 40), 0.3, false));
    expect(fit.tempoFactor).toBe(1);
  });

  it('copes with a player who misses some strikes', () => {
    const fit = fitSync(input(renderAudio(0.5, 1, 40, 4), 0.46, false));
    expect(fit.ok).toBe(true);
    expect(Math.abs(fit.deltaSec - 0.04)).toBeLessThan(0.01);
  });

  it('says so when already aligned', () => {
    const fit = fitSync(input(renderAudio(0.5, 1, 40), 0.5, false));
    expect(Math.abs(fit.deltaSec)).toBeLessThan(0.006);
    expect(describeFit(fit)).toContain('ya está alineada');
  });

  it('does not invent an alignment for noise or silence', () => {
    let seed = 9;
    const noise = new Float32Array(40 * SR);
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = ((seed / 4294967296) * 2 - 1) * 0.2;
    }
    expect(fitSync(input(noise, 0.5, true)).ok).toBe(false);
    expect(fitSync(input(new Float32Array(40 * SR), 0.5, true)).ok).toBe(false);
  });

  it('describes the direction of the correction', () => {
    const fit = fitSync(input(renderAudio(0.5, 1, 40), 0.46, false));
    expect(describeFit(fit)).toMatch(/adelantada/);
    const late = fitSync(input(renderAudio(0.4, 1, 40), 0.47, false));
    expect(describeFit(late)).toMatch(/retrasada/);
  });
});
