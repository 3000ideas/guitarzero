import { describe, expect, it } from 'vitest';
import { eventAt, parseTab, splitFrets } from '../../src/song/tab';
import { BUNDLED_TABS } from '../../src/song/bundledTabs';

describe('tablature', () => {
  it('splits glued numbers into two-digit frets', () => {
    expect(splitFrets('12')).toEqual(['12']);
    expect(splitFrets('9')).toEqual(['9']);
    expect(splitFrets('171916')).toEqual(['17', '19', '16']);
    expect(splitFrets('1517191715')).toEqual(['15', '17', '19', '17', '15']);
  });

  it('reads six-line blocks, the top line being the thinnest string, with columns, slides and vibrato', () => {
    const tab = parseTab('```\n|--5--7/9-|\n|-3--------|\n|----------|\n|----------|\n|----------|\n|-0~-------|\n\nnotas\n```');
    expect(tab.blocks).toHaveLength(1);
    const notes = tab.blocks[0].notes;
    expect(notes.find((n) => n.row === 0 && n.fret === 5)).toMatchObject({ col: 2, slide: false });
    expect(notes.find((n) => n.fret === 7)).toMatchObject({ slide: true });
    expect(notes.find((n) => n.fret === 9)).toMatchObject({ slide: false });
    expect(notes.find((n) => n.row === 1)?.fret).toBe(3);
    expect(notes.find((n) => n.row === 5)).toMatchObject({ fret: 0, vib: true });
    // events are in time order; notes in the same column sound together
    const cols = tab.events.map((e) => e.col);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
    expect(eventAt(tab, 0)).toBe(-1);
    expect(eventAt(tab, 1e6)).toBe(tab.events.length - 1);
  });

  it("reads Brian May's «Last Horizon»: every block has six strings and notes", () => {
    const tab = parseTab(BUNDLED_TABS[0].tab);
    expect(tab.blocks.length).toBeGreaterThanOrEqual(12);
    for (const b of tab.blocks) {
      expect(b.rows).toHaveLength(6);
      expect(b.notes.length).toBeGreaterThan(0);
      for (const n of b.notes) expect(n.fret).toBeLessThanOrEqual(24);
    }
    // the block of glued numbers: 17 19 16 repeated, then 21 19 17 16 19 17 16
    const glued = tab.blocks.find((b) => b.rows[0].startsWith('-171916'));
    expect(glued).toBeTruthy();
    expect(glued!.notes.filter((n) => n.row === 0).slice(0, 3).map((n) => n.fret)).toEqual([17, 19, 16]);
    expect(tab.totalSec).toBeGreaterThan(30);
  });
});
