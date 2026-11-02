import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_SONGS, bundledAudioUrl, downloadBundledAudio, installBundledEntries } from '../../src/song/bundled';
import { parseSong } from '../../src/song/parser';
import { clearStorage, deleteSong, getSong, saveSong } from '../../src/song/storage';
import { deleteTrack, getTrack } from '../../src/song/audioStore';

const sodoma = BUNDLED_SONGS[0];
const okFetch = (bytes = 1234): typeof fetch =>
  vi.fn(async () => new Response(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }), { status: 200 })) as unknown as typeof fetch;

beforeEach(async () => {
  clearStorage();
  await deleteTrack(sodoma.id);
});

describe('bundled songs', () => {
  it('the Sodoma text parses without errors: a pick-up bar plus the 64 bars of the recording', () => {
    const { song, errors } = parseSong(sodoma.source);
    expect(errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(song.bars).toHaveLength(65);
    expect(song.bars[0].chords.map((c) => c.chord.name)).toEqual(['-', 'D']); // rest on beat 1, the guitar enters on beat 2
    expect(song.chordNames).toEqual(expect.arrayContaining(['D', 'E', 'A', 'F#m', 'Bm']));
  });

  it('installs an editable user song with its audio info, once', () => {
    const pending = installBundledEntries();
    expect(pending.map((b) => b.id)).toEqual(['sodoma-acustica']);
    const s = getSong('sodoma-acustica');
    expect(s?.builtin).toBeFalsy();
    expect(s?.audio?.offsetSec).toBeCloseTo(-0.228, 3);
    expect(s?.source).toBe(sodoma.source);
    // a second boot does not duplicate or overwrite it
    expect(installBundledEntries()).toHaveLength(1);
  });

  it('upgrades an untouched earlier version, never an edited one', () => {
    const legacy = sodoma.legacy![0];
    saveSong({ id: sodoma.id, title: 'Sodoma (acústica)', artist: 'Canción personal', source: legacy.source, updatedAt: 0, audio: { ...sodoma.audio, offsetSec: legacy.offsetSec } });
    installBundledEntries();
    expect(getSong(sodoma.id)?.source).toBe(sodoma.source);
    expect(getSong(sodoma.id)?.audio?.offsetSec).toBeCloseTo(-0.228, 3);
    // an edited copy keeps the user's work
    saveSong({ id: sodoma.id, title: 'Sodoma (acústica)', artist: 'Canción personal', source: legacy.source + '# mío\n', updatedAt: 0, audio: { ...sodoma.audio, offsetSec: legacy.offsetSec } });
    installBundledEntries();
    expect(getSong(sodoma.id)?.source).toContain('# mío');
  });

  it('does not bring a song back after the user deleted it', () => {
    installBundledEntries();
    expect(deleteSong('sodoma-acustica')).toBe(true);
    expect(installBundledEntries()).toEqual([]);
    expect(getSong('sodoma-acustica')).toBeNull();
  });

  it('downloads the audio into the store, and again if the browser lost it', async () => {
    const fetchFn = okFetch(4321);
    await downloadBundledAudio(installBundledEntries(), fetchFn);
    expect((await getTrack('sodoma-acustica'))?.size).toBe(4321);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await downloadBundledAudio(installBundledEntries(), fetchFn); // already there: no new download
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await deleteTrack('sodoma-acustica');
    await downloadBundledAudio(installBundledEntries(), fetchFn); // lost: downloaded again
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a failed download never throws and leaves the song installed', async () => {
    const failing = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(downloadBundledAudio(installBundledEntries(), failing)).resolves.toBeUndefined();
    expect(getSong('sodoma-acustica')).not.toBeNull();
    expect(await getTrack('sodoma-acustica')).toBeNull();
  });

  it('builds the audio url relative to the page', () => {
    expect(bundledAudioUrl('x.mp3', './')).toBe('./audio/x.mp3');
  });
});
