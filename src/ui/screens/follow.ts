/**
 * «Seguir» (#/follow/:id): a screen to PLAY ALONG with the song. The recording (or the synthesized chords) sounds
 * and the grid of bars goes by: the bar that sounds now is lit from the moment it starts, with a fill that grows
 * across it (no per-beat flashing), the current chord is shown big with the next ones coming. Player controls:
 * play / pause, back to the start, ±5 s, a position slider and a loop. Click a bar to jump there; drag over
 * several bars (or Shift-click, or the ＋ / − buttons) to select them: that stretch is what plays and loops.
 */
import './follow.css';
import type { ChordShape, Screen, Song } from '../../types';
import { parseSong } from '../../song/parser';
import { getSong, loadSettings } from '../../song/storage';
import { getTrack } from '../../song/audioStore';
import { beatToSec, secToBeat, songDurationSec } from '../../song/tempo';
import { getChordShape } from '../../music/chords';
import { getAudioContext } from '../../audio/context';
import { BackingTrack } from '../../audio/backing';
import { renderChordTrack } from '../../audio/chordSynth';
import { drawChordDiagramHorizontal } from '../chordDiagram';
import { clear, h } from '../dom';

const noop = (): void => undefined;
const START_DELAY_SEC = 0.06;

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

interface ChordSlot {
  name: string;
  quality: string;
  bar: number;
  startBeat: number;
}

/** Every chord of the song in playing order (rests and «sin acorde» skipped). */
export function chordSlots(song: Song): ChordSlot[] {
  const out: ChordSlot[] = [];
  for (const bar of song.bars) {
    for (const c of bar.chords) {
      if (c.chord.quality === 'nc') continue;
      out.push({ name: c.chord.name, quality: c.chord.quality, bar: bar.index, startBeat: c.startBeat });
    }
  }
  return out;
}

export const followScreen: Screen = {
  mount(root: HTMLElement, params: Record<string, string>): () => void {
    const id = params.id ?? '';
    const stored = id ? getSong(id) : null;
    if (!stored) {
      location.replace('#/');
      return noop;
    }
    const { song } = parseSong(stored.source, { id });
    const bars = song.bars;
    const slots = chordSlots(song);
    const totalSec = songDurationSec(song);
    const settings = loadSettings();
    const ctx = getAudioContext();
    const audioInfo = stored.audio ?? null;
    let disposed = false;

    // ---------------------------------------------------------------- sound
    type Src = 'song' | 'chords';
    const tracks: Partial<Record<Src, BackingTrack>> = {};
    const loading: Partial<Record<Src, Promise<BackingTrack | null>>> = {};
    let src: Src = audioInfo ? 'song' : 'chords';
    const offsetFor = (s: Src): number => (s === 'song' && audioInfo ? audioInfo.offsetSec : 0);

    function loadTrack(which: Src): Promise<BackingTrack | null> {
      const existing = loading[which];
      if (existing) return existing;
      const p = (async (): Promise<BackingTrack | null> => {
        const track = new BackingTrack(ctx);
        try {
          if (which === 'song') {
            const blob = await getTrack(id);
            if (!blob) throw new Error('No se encontró el archivo de audio en este navegador');
            await track.load(blob);
            track.setGain(audioInfo ? audioInfo.gain : 0.8);
          } else {
            track.loadBuffer(await renderChordTrack(song));
            track.setGain(0.9);
          }
          if (disposed) {
            track.dispose();
            return null;
          }
          tracks[which] = track;
          return track;
        } catch (err) {
          track.dispose();
          console.warn('No se pudo preparar el sonido', err);
          setStatus(which === 'song' ? 'No se pudo cargar el audio de la canción: suenan los acordes.' : 'No se pudo preparar el sonido.');
          delete loading[which];
          return null;
        }
      })();
      loading[which] = p;
      return p;
    }

    // ---------------------------------------------------------------- state
    let playing = false;
    let posSec = 0; // song seconds, kept while paused
    let baseWall = 0; // AudioContext time at which `baseSec` is heard
    let baseSec = 0;
    let range: { a: number; b: number } | null = null; // inclusive bar indices
    let anchor = 0;
    let dragging = false;
    let moved = false;
    let raf = 0;
    let shownBar = -2;
    let shownSlot = -2;

    const barStart = (i: number): number => beatToSec(song.tempoSegments, bars[i].startBeat);
    const barEnd = (i: number): number => beatToSec(song.tempoSegments, bars[i].startBeat + bars[i].beats);
    const currentSec = (): number => (playing ? Math.min(totalSec, baseSec + Math.max(0, ctx.currentTime - baseWall)) : posSec);
    const barAt = (sec: number): number => {
      const beat = secToBeat(song.tempoSegments, sec);
      for (let i = bars.length - 1; i >= 0; i--) if (beat >= bars[i].startBeat - 1e-6) return i;
      return 0;
    };
    const loopEnd = (): number => (range ? barEnd(range.b) : totalSec);
    const loopStart = (): number => (range ? barStart(range.a) : 0);

    // ---------------------------------------------------------------- UI
    const statusEl = h('div.follow-status.muted.small', { role: 'status' });
    function setStatus(text: string): void {
      statusEl.textContent = text;
    }

    const nowCanvas = h('canvas.follow-diagram.follow-diagram-now') as HTMLCanvasElement;
    const nextCanvas = h('canvas.follow-diagram.follow-diagram-next') as HTMLCanvasElement;
    const nowName = h('div.follow-now-name', null, '—');
    const nextName = h('div.follow-next-name', null, '');
    const comingEl = h('div.follow-coming');
    const nowBox = h('div.follow-now', null, h('div.follow-label', null, 'Ahora'), nowName, nowCanvas);
    const nextBox = h('div.follow-next', null, h('div.follow-label', null, 'Siguiente'), nextName, nextCanvas);
    const stage = h('div.follow-stage', null, nowBox, nextBox, comingEl);

    const playBtn = h('button.btn.btn-primary.follow-play', { type: 'button', onclick: () => void togglePlay() }, '▶ Escuchar') as HTMLButtonElement;
    const skipBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => h('button.btn.btn-sm', { type: 'button', title, 'aria-label': title, onclick: fn }, label) as HTMLButtonElement;
    const rewindBtn = skipBtn('⏮', 'Volver al principio (del tramo elegido, o de la canción)', () => seek(loopStart()));
    const backBtn = skipBtn('⏪ 5 s', 'Retroceder 5 segundos', () => seek(currentSec() - 5));
    const forwardBtn = skipBtn('5 s ⏩', 'Adelantar 5 segundos', () => seek(currentSec() + 5));
    const prevBarBtn = skipBtn('◀ Compás', 'Compás anterior', () => seek(barStart(Math.max(0, barAt(currentSec()) - 1))));
    const nextBarBtn = skipBtn('Compás ▶', 'Compás siguiente', () => seek(barStart(Math.min(bars.length - 1, barAt(currentSec()) + 1))));
    const timeEl = h('span.follow-time', null, '0:00 / 0:00');
    const seekEl = h('input', { type: 'range', min: '0', max: String(Math.max(1, Math.round(totalSec * 20) / 20)), step: '0.05', value: '0', class: 'follow-seek', 'aria-label': 'Posición' }) as HTMLInputElement;
    seekEl.addEventListener('input', () => seek(Number(seekEl.value)));
    const loopBox = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Bucle' }) as HTMLInputElement;
    const loopLabel = h('label.follow-check', { title: 'Al llegar al final del tramo elegido (o de la canción) vuelve a empezar' }, loopBox, h('span', null, 'Bucle'));
    const srcSel = h('select.follow-src', { 'aria-label': 'Qué suena' }, h('option', { value: 'song' }, 'Canción original'), h('option', { value: 'chords' }, 'Acordes sintetizados')) as HTMLSelectElement;
    srcSel.value = src;
    srcSel.hidden = !audioInfo;
    srcSel.addEventListener('change', () => void changeSource(srcSel.value as Src));
    const selInfo = h('span.follow-selinfo.muted.small', null, 'Toca un compás para saltar ahí; arrastra sobre varios para elegir un tramo.');
    const moreBtn = skipBtn('＋ compás', 'Añadir un compás al final del tramo', () => grow(1));
    const lessBtn = skipBtn('− compás', 'Quitar un compás del final del tramo', () => grow(-1));
    const clearBtn = skipBtn('✕ Quitar tramo', 'Quitar la selección: suena la canción entera', () => setRange(null));
    const controls = h(
      'div.follow-controls',
      null,
      h('div.follow-row', null, playBtn, rewindBtn, backBtn, forwardBtn, prevBarBtn, nextBarBtn, loopLabel, srcSel),
      h('div.follow-row', null, timeEl, seekEl),
      h('div.follow-row', null, moreBtn, lessBtn, clearBtn, selInfo),
      statusEl,
    );

    const grid = h('div.follow-grid', { role: 'list' }) as HTMLDivElement;
    const barEls: HTMLElement[] = [];
    let prevSection: string | null = null;
    bars.forEach((bar, i) => {
      const names = bar.chords.filter((c) => c.chord.quality !== 'nc').map((c) => c.chord.name);
      const el = h(
        'div.follow-bar',
        { role: 'listitem', dataset: { i: String(i) }, 'aria-label': `Compás ${i + 1}` },
        h('span.follow-bar-num', null, String(i + 1)),
        bar.section !== null && bar.section !== prevSection ? h('span.follow-bar-sec', null, bar.section) : null,
        h('span.follow-bar-chords', { class: names.length > 1 ? 'is-multi' : '' }, names.length > 0 ? names.join('  ') : '–'),
        h('span.follow-bar-fill'),
      );
      prevSection = bar.section;
      barEls.push(el);
      grid.appendChild(el);
    });

    const header = h('header.screen-header', null, h('a.btn.btn-sm', { href: '#/' }, '← Biblioteca'), h('div.grow', null, h('h2.follow-title', null, song.title || 'Canción'), h('div.muted.small', null, 'Seguir la canción')), h('a.btn.btn-sm', { href: `#/play/${id}`, title: 'Practicar con micrófono' }, 'Practicar'), h('a.btn.btn-sm', { href: `#/edit/${id}` }, 'Editar'));
    const screen = h('main.screen.follow', null, header, stage, controls, grid);
    root.appendChild(screen);

    // ---------------------------------------------------------------- selection
    function paintRange(): void {
      barEls.forEach((el, i) => el.classList.toggle('in-range', !!range && i >= range.a && i <= range.b));
      selInfo.textContent = range
        ? range.a === range.b
          ? `Compás ${range.a + 1} elegido${loopBox.checked ? ': se repite' : ''}`
          : `Compases ${range.a + 1}–${range.b + 1} elegidos${loopBox.checked ? ': se repiten' : ''}`
        : 'Toca un compás para saltar ahí; arrastra sobre varios para elegir un tramo.';
      clearBtn.disabled = !range;
      moreBtn.disabled = !range;
      lessBtn.disabled = !range || range.a === range.b;
    }

    function setRange(next: { a: number; b: number } | null): void {
      range = next ? { a: Math.max(0, Math.min(next.a, next.b)), b: Math.min(bars.length - 1, Math.max(next.a, next.b)) } : null;
      paintRange();
      if (playing && range) {
        const cur = currentSec();
        if (cur < barStart(range.a) || cur >= barEnd(range.b)) seek(barStart(range.a));
      }
    }

    function grow(delta: number): void {
      if (!range) return;
      setRange({ a: range.a, b: Math.max(range.a, Math.min(bars.length - 1, range.b + delta)) });
    }

    function barFromEvent(ev: PointerEvent): number | null {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.follow-bar') as HTMLElement | null;
      return el && el.dataset.i !== undefined ? Number(el.dataset.i) : null;
    }

    grid.addEventListener('pointerdown', (ev) => {
      const i = barFromEvent(ev);
      if (i === null) return;
      if (ev.shiftKey && range) {
        setRange({ a: Math.min(range.a, i), b: Math.max(range.b, i) });
        return;
      }
      dragging = true;
      moved = false;
      anchor = i;
    });
    grid.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const i = barFromEvent(ev);
      if (i === null || (i === anchor && !moved)) return;
      moved = true;
      setRange({ a: anchor, b: i });
    });
    const endDrag = (ev: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        if (range) seek(barStart(range.a));
        return;
      }
      const i = barFromEvent(ev);
      if (i === null) return;
      setRange({ a: i, b: i });
      seek(barStart(i));
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', () => {
      dragging = false;
    });
    grid.style.touchAction = 'pan-y';

    // ---------------------------------------------------------------- playback
    async function ensureTrack(): Promise<BackingTrack | null> {
      const track = tracks[src] ?? (await loadTrack(src));
      if (track || src === 'chords') return track;
      // The recording is missing: fall back to the synthesized chords.
      src = 'chords';
      srcSel.value = 'chords';
      return tracks.chords ?? (await loadTrack('chords'));
    }

    async function startAt(sec: number): Promise<void> {
      const track = await ensureTrack();
      if (!track || disposed) return;
      try {
        await ctx.resume();
      } catch {
        /* the browser refuses until a gesture: play was one */
      }
      posSec = Math.max(0, Math.min(totalSec, sec));
      baseSec = posSec;
      baseWall = ctx.currentTime + START_DELAY_SEC;
      track.start(baseWall, posSec + offsetFor(src), 1);
      playing = true;
      playBtn.textContent = '⏸ Pausa';
      playBtn.classList.add('is-playing');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function stopSound(): void {
      for (const t of Object.values(tracks)) t?.stop();
    }

    function pause(): void {
      if (playing) posSec = currentSec();
      playing = false;
      stopSound();
      cancelAnimationFrame(raf);
      playBtn.textContent = '▶ Escuchar';
      playBtn.classList.remove('is-playing');
      refresh(true);
    }

    async function togglePlay(): Promise<void> {
      if (playing) {
        pause();
        return;
      }
      let from = posSec;
      if (range && (from < barStart(range.a) || from >= barEnd(range.b) - 0.05)) from = barStart(range.a);
      else if (!range && from >= totalSec - 0.05) from = 0;
      await startAt(from);
    }

    function seek(sec: number): void {
      const target = Math.max(0, Math.min(totalSec, sec));
      if (playing) void startAt(target);
      else {
        posSec = target;
        refresh(true);
      }
    }

    async function changeSource(next: Src): Promise<void> {
      const was = playing;
      const at = currentSec();
      if (was) pause();
      src = next;
      if (was) await startAt(at);
    }

    function tick(): void {
      if (!playing || disposed) return;
      const sec = currentSec();
      const end = loopEnd();
      if (sec >= end - 0.005) {
        if (loopBox.checked) {
          void startAt(loopStart());
          return;
        }
        posSec = range ? barStart(range.a) : 0;
        pause();
        return;
      }
      refresh(false);
      raf = requestAnimationFrame(tick);
    }

    // ---------------------------------------------------------------- display
    function drawDiagram(cv: HTMLCanvasElement, name: string | null): void {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const hh = cv.clientHeight;
      if (w <= 0 || hh <= 0) return;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
      const c = cv.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, hh);
      if (!name) return;
      const shape: ChordShape | null = getChordShape(name);
      const boxH = Math.min(hh, w / 1.75);
      const boxW = Math.min(w, boxH * 1.75);
      drawChordDiagramHorizontal(c, shape, { x: (w - boxW) / 2, y: (hh - boxH) / 2, w: boxW, h: boxH }, { title: name, showFingers: true, invertStrings: settings.invertStrings });
    }

    function slotAt(sec: number): number {
      const beat = secToBeat(song.tempoSegments, sec);
      let k = -1;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].startBeat <= beat + 1e-6) k = i;
        else break;
      }
      return k;
    }

    function showChords(slot: number): void {
      const cur = slot >= 0 ? slots[slot] : null;
      const nextSlot = slots.slice(slot + 1).find((s) => s.name !== (cur ? cur.name : ''));
      nowName.textContent = cur ? cur.name : '—';
      nextName.textContent = nextSlot ? nextSlot.name : '';
      drawDiagram(nowCanvas, cur ? cur.name : null);
      drawDiagram(nextCanvas, nextSlot ? nextSlot.name : null);
      clear(comingEl);
      let shown = 0;
      let last = cur ? cur.name : '';
      for (let i = slot + 1; i < slots.length && shown < 6; i++) {
        if (slots[i].name === last) continue;
        last = slots[i].name;
        comingEl.appendChild(h('span.follow-coming-chord', null, slots[i].name));
        shown++;
      }
    }

    function refresh(force: boolean): void {
      const sec = currentSec();
      timeEl.textContent = `${fmt(sec)} / ${fmt(totalSec)}`;
      if (document.activeElement !== seekEl) seekEl.value = String(sec);
      const bi = barAt(sec);
      if (force || bi !== shownBar) {
        if (shownBar >= 0 && barEls[shownBar]) {
          barEls[shownBar].classList.remove('is-now');
          barEls[shownBar].style.removeProperty('--p');
        }
        shownBar = bi;
        const el = barEls[bi];
        if (el) {
          el.classList.add('is-now');
          const top = el.offsetTop - grid.offsetTop;
          const rel = top - grid.scrollTop;
          if (rel < grid.clientHeight * 0.1 || rel > grid.clientHeight * 0.6) grid.scrollTo({ top: Math.max(0, top - grid.clientHeight * 0.3), behavior: force ? 'auto' : 'smooth' });
        }
      }
      const el = barEls[bi];
      if (el && bars[bi]) {
        const len = barEnd(bi) - barStart(bi);
        el.style.setProperty('--p', `${Math.max(0, Math.min(1, len > 0 ? (sec - barStart(bi)) / len : 0)) * 100}%`);
      }
      const k = slotAt(sec);
      if (force || k !== shownSlot) {
        shownSlot = k;
        showChords(k);
      }
    }

    function onKey(ev: KeyboardEvent): void {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        void togglePlay();
      } else if (ev.key === 'ArrowLeft') seek(currentSec() - 5);
      else if (ev.key === 'ArrowRight') seek(currentSec() + 5);
    }
    document.addEventListener('keydown', onKey);
    const onResize = (): void => refresh(true);
    window.addEventListener('resize', onResize);

    paintRange();
    refresh(true);
    if (bars.length === 0) setStatus('Esta canción no tiene compases.');
    else if (audioInfo) void loadTrack('song'); // decode ahead of the first tap

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      stopSound();
      for (const t of Object.values(tracks)) t?.dispose();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerup', endDrag);
    };
  },
};
