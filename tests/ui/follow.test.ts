import { describe, expect, it } from 'vitest';
import { beatCells, fitGrid } from '../../src/ui/screens/follow';
import { parseSong } from '../../src/song/parser';
import { parseRoute, routeIsAvailable, titleForRoute } from '../../src/main';

describe('Seguir', () => {
  it('beatCells writes the chord where it starts, a dot while it goes on and a dash for a rest', () => {
    const { song } = parseSong('tempo: 100\ntime: 4/4\n\nD . . . | - . . . | F#m . E . |\n');
    expect(beatCells(song.bars[0])).toEqual(['D', '·', '·', '·']);
    expect(beatCells(song.bars[1])).toEqual(['–', '·', '·', '·']);
    expect(beatCells(song.bars[2])).toEqual(['F#m', '·', 'E', '·']);
  });

  it('fitGrid puts every bar on screen with compact bars, and falls back to scrolling when it cannot', () => {
    const f = fitGrid(65, 4, 1000, 520);
    expect(f.fits).toBe(true);
    expect(f.cols * f.rows).toBeGreaterThanOrEqual(65);
    expect(f.rows * f.rowPx).toBeLessThanOrEqual(520);
    expect(f.fontPx).toBeLessThanOrEqual(13);
    // A bigger box never needs fewer columns than a small one for the same text.
    expect(fitGrid(65, 4, 1000, 900).cols).toBeGreaterThanOrEqual(f.cols);
    expect(fitGrid(400, 4, 360, 300).fits).toBe(false);
  });

  it('has its own route #/follow/:id', () => {
    const route = parseRoute('#/follow/abc');
    expect(route).toEqual({ name: 'follow', params: { id: 'abc' } });
    expect(titleForRoute(route!)).toContain('Seguir');
    expect(routeIsAvailable({ name: 'follow', params: { id: 'no-existe' } })).toBe(false);
  });
});
