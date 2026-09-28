import { describe, expect, it } from 'vitest';
import {
  OPEN_STRINGS,
  TUNER_CLOSE_CENTS,
  TUNER_FAR_CENTS,
  TUNER_IN_TUNE_CENTS,
  centsFromTarget,
  needleFraction,
  stringLabel,
  tunerAdvice,
  tunerZone,
} from '../../src/ui/screens/tuner';
import { midiToFreq } from '../../src/music/notes';

describe('tunerZone', () => {
  it('classifies in-tune / close / off by the absolute cents deviation', () => {
    expect(tunerZone(0)).toBe('in-tune');
    expect(tunerZone(TUNER_IN_TUNE_CENTS)).toBe('in-tune');
    expect(tunerZone(-TUNER_IN_TUNE_CENTS)).toBe('in-tune');
    expect(tunerZone(TUNER_IN_TUNE_CENTS + 0.1)).toBe('close');
    expect(tunerZone(TUNER_CLOSE_CENTS)).toBe('close');
    expect(tunerZone(-TUNER_CLOSE_CENTS)).toBe('close');
    expect(tunerZone(TUNER_CLOSE_CENTS + 0.1)).toBe('off');
    expect(tunerZone(-400)).toBe('off');
    expect(tunerZone(700)).toBe('off');
  });
});

describe('needleFraction', () => {
  it('maps -50..50 cents to 0..1, centred at 0.5', () => {
    expect(needleFraction(0)).toBeCloseTo(0.5, 9);
    expect(needleFraction(-50)).toBeCloseTo(0, 9);
    expect(needleFraction(50)).toBeCloseTo(1, 9);
    expect(needleFraction(25)).toBeCloseTo(0.75, 9);
    expect(needleFraction(-25)).toBeCloseTo(0.25, 9);
  });

  it('clamps beyond ±50 cents (a badly out-of-tune string still shows a pinned needle)', () => {
    expect(needleFraction(600)).toBe(1);
    expect(needleFraction(-600)).toBe(0);
  });
});

describe('centsFromTarget', () => {
  it('is 0 exactly at the target frequency', () => {
    expect(centsFromTarget(midiToFreq(45), 45)).toBeCloseTo(0, 6);
  });

  it('is positive when sharp (above target) and negative when flat', () => {
    const target = midiToFreq(45); // A2, 110 Hz
    expect(centsFromTarget(target * Math.pow(2, 20 / 1200), 45)).toBeCloseTo(20, 3);
    expect(centsFromTarget(target * Math.pow(2, -20 / 1200), 45)).toBeCloseTo(-20, 3);
  });

  it('is NOT clamped: a whole semitone off reads as ±100 cents, not folded to the nearest note', () => {
    // Target is E2 (midi 40). A string tuned a whole tone too high (two semitones up).
    expect(centsFromTarget(midiToFreq(42), 40)).toBeCloseTo(200, 3);
    // ... and a whole tone too low.
    expect(centsFromTarget(midiToFreq(38), 40)).toBeCloseTo(-200, 3);
  });

  it('honours a custom A4 reference', () => {
    // At a4 = 432, A3 (midi 57) sounds at 216 Hz.
    expect(centsFromTarget(216, 57, 432)).toBeCloseTo(0, 6);
  });
});

describe('tunerAdvice', () => {
  it('says "Afinada" when in tune', () => {
    expect(tunerAdvice(0)).toBe('Afinada');
    expect(tunerAdvice(TUNER_IN_TUNE_CENTS)).toBe('Afinada');
    expect(tunerAdvice(-TUNER_IN_TUNE_CENTS)).toBe('Afinada');
  });

  it('sharp (positive cents) means too tight: tells the player to loosen (aflojar)', () => {
    const justOver = TUNER_IN_TUNE_CENTS + 2;
    expect(tunerAdvice(justOver)).toMatch(/tensa/i);
    expect(tunerAdvice(justOver)).toMatch(/afloja/i);
    expect(tunerAdvice(40)).toMatch(/tensa/i);
    expect(tunerAdvice(40)).toMatch(/afloja/i);
  });

  it('flat (negative cents) means too loose: tells the player to tighten (apretar)', () => {
    const justUnder = -(TUNER_IN_TUNE_CENTS + 2);
    expect(tunerAdvice(justUnder)).toMatch(/floja/i);
    expect(tunerAdvice(justUnder)).toMatch(/aprieta/i);
    expect(tunerAdvice(-40)).toMatch(/floja/i);
    expect(tunerAdvice(-40)).toMatch(/aprieta/i);
  });

  it('distinguishes a small nudge (close) from a bigger correction (off)', () => {
    const close = tunerAdvice(TUNER_CLOSE_CENTS);
    const off = tunerAdvice(TUNER_CLOSE_CENTS + 10);
    expect(close).toMatch(/ligeramente/i);
    expect(off).not.toMatch(/ligeramente/i);
  });

  it('flags a very large deviation as possibly the wrong string', () => {
    expect(tunerAdvice(TUNER_FAR_CENTS + 1)).toMatch(/cuerda/i);
    expect(tunerAdvice(-(TUNER_FAR_CENTS + 1))).toMatch(/cuerda/i);
    expect(tunerAdvice(50)).not.toMatch(/cuerda/i);
  });
});

describe('stringLabel', () => {
  it('formats "<string>ª · <Spanish note> (<scientific name>)"', () => {
    expect(stringLabel({ name: 'E2', string: 6 })).toBe('6ª · Mi (E2)');
    expect(stringLabel({ name: 'A2', string: 5 })).toBe('5ª · La (A2)');
    expect(stringLabel({ name: 'D3', string: 4 })).toBe('4ª · Re (D3)');
    expect(stringLabel({ name: 'G3', string: 3 })).toBe('3ª · Sol (G3)');
    expect(stringLabel({ name: 'B3', string: 2 })).toBe('2ª · Si (B3)');
    expect(stringLabel({ name: 'E4', string: 1 })).toBe('1ª · mi (E4)');
  });
});

describe('OPEN_STRINGS', () => {
  it('is the six standard-tuning strings, low to high, numbered as a guitarist counts them (6..1)', () => {
    expect(OPEN_STRINGS.map((s) => s.name)).toEqual(['E2', 'A2', 'D3', 'G3', 'B3', 'E4']);
    expect(OPEN_STRINGS.map((s) => s.midi)).toEqual([40, 45, 50, 55, 59, 64]);
    expect(OPEN_STRINGS.map((s) => s.string)).toEqual([6, 5, 4, 3, 2, 1]);
  });
});
