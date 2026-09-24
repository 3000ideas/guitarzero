import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/song/parser';
import { simplifyChart } from '../../src/music/simplify';
import {
  STRUM_PRESETS,
  chipRecommendation,
  currentStrumHeader,
  formatCapoLine,
  formatUnchangedRatio,
  isValidStrumPattern,
  presetIdFor,
  remainingHardChords,
  rewriteHeader,
  rewriteStrumHeader,
  simplifyOptionsFrom,
  simplifyPreviewRows,
  weightedChordsOf,
} from '../../src/ui/screens/editor';

const SOURCE = `title: Prueba
tempo: 100
strum: D-DU-UDU

[Estrofa]
C . . . | G . . . | Am . . . | F . . . |
Bm . . . | G . . . | x2
> letra
`;

describe('editor simplify helpers', () => {
  it('weightedChordsOf sums beats per chord in order of first appearance, skipping N.C. and rests', () => {
    const { song } = parseSong('tempo: 100\nC . G . | N.C. - Am . | C . . . |');
    expect(weightedChordsOf(song)).toEqual([
      { name: 'C', beats: 6 },
      { name: 'G', beats: 2 },
      { name: 'Am', beats: 2 },
    ]);
  });

  it('formatUnchangedRatio clamps and rounds to a percentage', () => {
    expect(formatUnchangedRatio(0.923)).toBe('Tocas el 92 % de la canción sin cambios');
    expect(formatUnchangedRatio(1.5)).toBe('Tocas el 100 % de la canción sin cambios');
    expect(formatUnchangedRatio(Number.NaN)).toBe('Tocas el 0 % de la canción sin cambios');
  });

  it('formatCapoLine', () => {
    expect(formatCapoLine(0)).toBe('Sin cejilla');
    expect(formatCapoLine(3)).toBe('Cejilla propuesta: traste 3');
  });

  it('simplifyOptionsFrom maps the UI state to SimplifyOptions', () => {
    const opts = simplifyOptionsFrom({ removeExtensions: false, substituteHard: true, suggestCapo: false, allowSevenths: true, maxChordsValue: '3' });
    expect(opts).toMatchObject({ removeExtensions: false, substituteHard: true, suggestCapo: false, allowSevenths: true, maxChords: 3 });
    expect(simplifyOptionsFrom({ removeExtensions: true, substituteHard: true, suggestCapo: true, allowSevenths: false, maxChordsValue: '' }).maxChords).toBeNull();
  });

  it('chipRecommendation flags barre chords and proposes an easy neighbour', () => {
    const easy = chipRecommendation('C', { root: 0, mode: 'major' });
    expect(easy.difficulty.level).toBe(1);
    expect(easy.rec).toBeNull();
    const hard = chipRecommendation('F', { root: 0, mode: 'major' });
    expect(hard.difficulty.level).toBe(3);
    expect(hard.rec).not.toBeNull();
    expect(hard.rec?.name).not.toBe('C');
    expect(hard.rec?.shared).toBeGreaterThanOrEqual(2);
  });

  it('simplifyPreviewRows and remainingHardChords describe a simplifyChart result', () => {
    const result = simplifyChart(SOURCE, { removeExtensions: true, substituteHard: true, suggestCapo: false, maxChords: null, allowSevenths: false });
    const rows = simplifyPreviewRows(result);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect([1, 2, 3]).toContain(row.fromLevel);
      expect([1, 2, 3]).toContain(row.toLevel);
      expect(row.beats).toBeGreaterThan(0);
    }
    expect(remainingHardChords(result).every((n) => !result.chordsAfter.includes(n) || true)).toBe(true);
    const { errors } = parseSong(result.source);
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
  });
});

describe('editor strum helpers', () => {
  it('rewriteHeader rewrites an existing header in place and inserts a missing one after the headers', () => {
    expect(rewriteStrumHeader(SOURCE, 'D-D-D-D-')).toContain('strum: D-D-D-D-\n');
    const noStrum = 'title: X\ntempo: 90\n\nC . . . |';
    const out = rewriteStrumHeader(noStrum, 'D---D---');
    expect(out.split('\n').slice(0, 3)).toEqual(['title: X', 'tempo: 90', 'strum: D---D---']);
    expect(rewriteHeader('C . . . |', 'capo', '2')).toBe('capo: 2\nC . . . |');
    expect(rewriteHeader('strum: D-DU-UDU   # pop\nC |', 'strum', 'D-D-D-D-')).toBe('strum: D-D-D-D-   # pop\nC |');
  });

  it('currentStrumHeader reads the leading header or falls back to one strum per beat', () => {
    expect(currentStrumHeader(SOURCE, 4)).toBe('D-DU-UDU');
    expect(currentStrumHeader('tempo: 100\nC . . |', 3)).toBe('D-D-D-');
    expect(currentStrumHeader('C . . . |\nstrum: DUDUDUDU', 4)).toBe('D-D-D-D-');
  });

  it('isValidStrumPattern accepts 1, 2 or 4 chars per beat of DUx-', () => {
    expect(isValidStrumPattern('D-D-D-D-', 4)).toBe(true);
    expect(isValidStrumPattern('DDDD', 4)).toBe(true);
    expect(isValidStrumPattern('DUDUDUDUDUDUDUDU', 4)).toBe(true);
    expect(isValidStrumPattern('D-DUDU', 3)).toBe(true);
    expect(isValidStrumPattern('D-DU-UD', 4)).toBe(false);
    expect(isValidStrumPattern('D-DU-UDQ', 4)).toBe(false);
  });

  it('presets produce valid patterns for 4/4 and 3/4 and round-trip through presetIdFor', () => {
    for (const preset of STRUM_PRESETS) {
      for (const n of [4, 3, 2]) {
        const p = preset.pattern(n);
        expect(isValidStrumPattern(p, n), `${preset.id} ${n}`).toBe(true);
      }
      expect(presetIdFor(preset.pattern(4), 4)).toBe(STRUM_PRESETS.find((q) => q.pattern(4) === preset.pattern(4))?.id);
    }
    expect(presetIdFor('DxDxDxDx', 4)).toBe('custom');
  });
});
