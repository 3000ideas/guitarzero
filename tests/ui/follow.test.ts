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

  it('fitGrid puts every bar on screen when it can be read, and falls back to scrolling when it cannot', () => {
    const wide = fitGrid(54, 4, 1200, 700);
    expect(wide.fits).toBe(true);
    expect(wide.cols * wide.rows).toBeGreaterThanOrEqual(54);
    const small = fitGrid(54, 4, 1200, 700);
    const big = fitGrid(54, 4, 1200, 1400);
    expect(big.fontPx).toBeGreaterThanOrEqual(small.fontPx);
    expect(fitGrid(400, 4, 360, 300).fits).toBe(false);
  });

  it('has its own route #/follow/:id', () => {
    const route = parseRoute('#/follow/abc');
    expect(route).toEqual({ name: 'follow', params: { id: 'abc' } });
    expect(titleForRoute(route!)).toContain('Seguir');
    expect(routeIsAvailable({ name: 'follow', params: { id: 'no-existe' } })).toBe(false);
  });
});
