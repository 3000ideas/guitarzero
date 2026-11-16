import { describe, expect, it } from 'vitest';
import { chordSlots } from '../../src/ui/screens/follow';
import { parseSong } from '../../src/song/parser';
import { parseRoute, routeIsAvailable, titleForRoute } from '../../src/main';

describe('Seguir', () => {
  it('lists the chords of the song in playing order, with absolute beats, skipping rests', () => {
    const { song } = parseSong('tempo: 100\ntime: 4/4\n\nD . . . | - . . . | F#m . E . |\n');
    const slots = chordSlots(song);
    expect(slots.map((s) => s.name)).toEqual(['D', 'F#m', 'E']);
    expect(slots.map((s) => s.startBeat)).toEqual([0, 8, 10]);
    expect(slots.map((s) => s.bar)).toEqual([0, 2, 2]);
  });

  it('has its own route #/follow/:id', () => {
    const route = parseRoute('#/follow/abc');
    expect(route).toEqual({ name: 'follow', params: { id: 'abc' } });
    expect(titleForRoute(route!)).toContain('Seguir');
    expect(routeIsAvailable({ name: 'follow', params: { id: 'no-existe' } })).toBe(false);
  });
});
