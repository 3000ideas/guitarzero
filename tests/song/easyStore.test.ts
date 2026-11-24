import { beforeEach, describe, expect, it } from 'vitest';
import { createEasySong, easyBaseId, easyTitle } from '../../src/song/easyStore';
import { parseSong } from '../../src/song/parser';
import { clearStorage, getSong, listSongs, saveSong } from '../../src/song/storage';
import { deleteTrack, getTrack, putTrack } from '../../src/song/audioStore';

const SRC = 'title: Mía\ntempo: 120\n[A]\nBb . . . | Eb . . . | F . . . | Gm . Bb7 . |\n';
const AUDIO = { name: 'mia.mp3', type: 'audio/mpeg', size: 3, durationSec: 8, offsetSec: 0, gain: 1 };

beforeEach(async () => {
  clearStorage();
  await deleteTrack('mia');
  await deleteTrack('mia-facil');
});

describe('easy copy of a song', () => {
  it('is a normal song next to the full one, with open chords, a capo and a down-strum per beat', async () => {
    saveSong({ id: 'mia', title: 'Mía', artist: 'Yo', source: SRC, updatedAt: 0 });
    const made = await createEasySong('mia', null, { capo: true });
    expect(made).toMatchObject({ ok: true, id: 'mia-facil', message: '' });
    const easy = getSong('mia-facil');
    expect(easy?.title).toBe('Mía (fácil)');
    expect(easy?.artist).toBe('Yo');
    const { song, errors } = parseSong(easy?.source ?? '');
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(song.capo).toBe(3);
    expect(song.chordNames).toEqual(['G', 'C', 'D', 'Em']);
    expect(song.events).toHaveLength(16);
    expect(getSong('mia')?.source).toBe(SRC); // the full song is untouched
  });

  it('keeps the audio of the song and rests where the recording stops', async () => {
    saveSong({ id: 'mia', title: 'Mía', artist: '', source: SRC, updatedAt: 0, audio: AUDIO });
    await putTrack('mia', new Blob([new Uint8Array(3)]), { name: AUDIO.name, type: AUDIO.type, size: AUDIO.size });
    // 16 beats of 0.5 s: a steady tone, silent on beats 6 and 7
    const sr = 8000;
    const samples = new Float32Array(sr * 8);
    for (let i = 0; i < samples.length; i++) {
      const beat = Math.floor(i / (sr / 2));
      samples[i] = beat === 6 || beat === 7 ? 0 : 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
    }
    const made = await createEasySong('mia', { samples, sampleRate: sr }, { capo: true });
    expect(made.ok).toBe(true);
    expect(made.result?.rests).toBe(2);
    expect(getSong('mia-facil')?.audio).toEqual(AUDIO);
    expect(await getTrack('mia-facil')).not.toBeNull();
    expect(getSong('mia-facil')?.source).toContain('G . . . | C . - . | D . . . |');
  });

  it('asked from the easy copy, it is made again from the full song (never an easy copy of an easy copy)', async () => {
    saveSong({ id: 'mia', title: 'Mía', artist: '', source: SRC, updatedAt: 0 });
    await createEasySong('mia');
    const again = await createEasySong('mia-facil');
    expect(again.id).toBe('mia-facil');
    expect(listSongs().filter((s) => !s.builtin).map((s) => s.id).sort()).toEqual(['mia', 'mia-facil']);
    expect(easyBaseId('mia-facil')).toBe('mia');
    expect(easyBaseId('mia')).toBe('mia');
    expect(easyTitle('Mía (fácil)')).toBe('Mía (fácil)');
  });

  it('says so when the song does not exist', async () => {
    expect(await createEasySong('nope')).toMatchObject({ ok: false, id: '', result: null });
  });
});
