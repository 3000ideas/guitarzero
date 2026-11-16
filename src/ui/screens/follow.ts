/**
 * «Seguir» (#/follow/:id): a screen to PLAY ALONG with the song. The recording (or the synthesized chords) sounds
 * and the grid of bars (the same as in the editor: one cell per beat, the chord written where it starts) goes by:
 * the beat that sounds is lit as it plays and the grid scrolls by itself. Player controls:
 * play / pause, back to the start, ±5 s, a position slider and a loop. Click a bar to jump there; drag over
 * several bars (or Shift-click, or the ＋ / − buttons) to select them: that stretch is what plays and loops.
 */
import './follow.css';
import type { Screen, SongBar } from '../../types';
import { parseSong } from '../../song/parser';
import { getSong } from '../../song/storage';
import { getTrack } from '../../song/audioStore';
import { beatToSec, secToBeat, songDurationSec } from '../../song/tempo';
import { getAudioContext } from '../../audio/context';
import { BackingTrack } from '../../audio/backing';
import { renderChordTrack } from '../../audio/chordSynth';
import { h } from '../dom';

const noop = (): void => undefined;
const START_DELAY_SEC = 0.06;

function fmt(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** What the editor grid writes in each beat cell of a bar: the chord where it starts, «·» while it goes on, «–» for a rest. */
export function beatCells(bar: SongBar): string[] {
  const cells: string[] = Array.from({ length: Math.max(1, Math.round(bar.beats)) }, () => '·');
  for (const c of bar.chords) {
    const at = Math.max(0, Math.min(cells.length - 1, Math.floor(c.startBeat - bar.startBeat + 1e-6)));
    cells[at] = c.chord.quality === 'nc' ? (c.chord.name === '-' ? '–' : c.chord.name) : c.chord.name;
  }
  return cells;
}

/**
 * How many columns make ALL the bars fit in a `width` × `height` box with the biggest writing: tries every column
 * count and keeps the one whose chord text can be largest. `fontPx` is capped; when even the best is too small to
 * read (`fits` false) the grid keeps a minimum size and scrolls.
 */
export function fitGrid(count: number, cells: number, width: number, height: number, gap = 6): { cols: number; rows: number; fontPx: number; fits: boolean } {
  const MIN_FONT = 11;
  const MAX_FONT = 30;
  let best = { cols: 1, rows: Math.max(1, count), fontPx: 0 };
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const barW = (width - gap * (cols - 1)) / cols;
    const barH = (height - gap * (rows - 1)) / rows;
    if (barW <= 0 || barH <= 0) continue;
    // A chord must fit its cell: the cell is barW / cells wide and (barH - the little number row) tall.
    const font = Math.min((barW / cells) * 0.4, (barH - 14) * 0.42, MAX_FONT);
    if (font > best.fontPx) best = { cols, rows, fontPx: font };
  }
  return { ...best, fits: best.fontPx >= MIN_FONT };
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
    const totalSec = songDurationSec(song);
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
    let rate = 1; // playback speed (1 = as recorded; the pitch follows it)
    let baseWall = 0; // AudioContext time at which `baseSec` is heard
    let baseSec = 0;
    let range: { a: number; b: number } | null = null; // inclusive bar indices
    let anchor = 0;
    let dragging = false;
    let moved = false;
    let raf = 0;
    let shownBar = -2;
    let shownCell = '';

    const barStart = (i: number): number => beatToSec(song.tempoSegments, bars[i].startBeat);
    const barEnd = (i: number): number => beatToSec(song.tempoSegments, bars[i].startBeat + bars[i].beats);
    const currentSec = (): number => (playing ? Math.min(totalSec, baseSec + Math.max(0, ctx.currentTime - baseWall) * rate) : posSec);
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
    const speedSel = h('select.follow-speed', { 'aria-label': 'Velocidad', title: 'Velocidad: más lento para practicar' }) as HTMLSelectElement;
    for (const pct of [50, 60, 70, 80, 90, 100]) speedSel.appendChild(h('option', { value: String(pct) }, `${pct} %`));
    speedSel.value = '100';
    speedSel.addEventListener('change', () => {
      const was = playing;
      const at = currentSec();
      rate = Number(speedSel.value) / 100;
      if (was) void startAt(at);
    });
    const speedLabel = h('label.follow-check', null, h('span', null, 'Velocidad'), speedSel);
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
      h('div.follow-row', null, playBtn, rewindBtn, backBtn, forwardBtn, prevBarBtn, nextBarBtn, loopLabel, speedLabel, srcSel),
      h('div.follow-row', null, timeEl, seekEl),
      h('div.follow-row', null, moreBtn, lessBtn, clearBtn, selInfo),
      statusEl,
    );

    const grid = h('div.follow-grid', { role: 'list' }) as HTMLDivElement;
    const barEls: HTMLElement[] = [];
    let prevSection: string | null = null;
    const cellEls: HTMLElement[][] = [];
    bars.forEach((bar, i) => {
      const cells = beatCells(bar).map((value) => {
        const kind = value === '·' ? 'is-hold' : value === '–' ? 'is-rest' : 'is-chord';
        return h('div.follow-cell', { class: `${kind}${value.length > 4 ? ' is-long' : ''}` }, h('span.follow-chord', null, value));
      });
      cellEls.push(cells);
      const el = h(
        'div.follow-bar',
        { role: 'listitem', dataset: { i: String(i) }, 'aria-label': `Compás ${i + 1}`, style: `--cells:${cells.length}` },
        h('div.follow-bar-top', null, h('span.follow-bar-num', null, String(i + 1)), bar.section !== null && bar.section !== prevSection ? h('span.follow-bar-sec', null, bar.section) : null),
        h('div.follow-cells', null, cells),
      );
      prevSection = bar.section;
      barEls.push(el);
      grid.appendChild(el);
    });

    const header = h('header.screen-header', null, h('a.btn.btn-sm', { href: '#/' }, '← Biblioteca'), h('div.grow', null, h('h2.follow-title', null, song.title || 'Canción'), h('div.muted.small', null, 'Seguir la canción')), h('a.btn.btn-sm', { href: `#/play/${id}`, title: 'Practicar con micrófono' }, 'Practicar'), h('a.btn.btn-sm', { href: `#/edit/${id}` }, 'Editar'));
    const screen = h('main.screen.follow', null, header, controls, grid);
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
      track.start(baseWall, posSec + offsetFor(src), rate);
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
    function refresh(force: boolean): void {
      const sec = currentSec();
      timeEl.textContent = `${fmt(sec)} / ${fmt(totalSec)}`;
      if (document.activeElement !== seekEl) seekEl.value = String(sec);
      const bi = barAt(sec);
      if (force || bi !== shownBar) {
        if (shownBar >= 0 && barEls[shownBar]) barEls[shownBar].classList.remove('is-now');
        shownBar = bi;
        const el = barEls[bi];
        if (el) {
          el.classList.add('is-now');
          const top = el.offsetTop - grid.offsetTop;
          const rel = top - grid.scrollTop;
          if (rel < grid.clientHeight * 0.1 || rel > grid.clientHeight * 0.6) grid.scrollTo({ top: Math.max(0, top - grid.clientHeight * 0.3), behavior: force ? 'auto' : 'smooth' });
        }
      }
      // The beat that sounds: one cell lit at a time, only while it plays (paused: none).
      const bar = bars[bi];
      let key = '';
      if (bar && playing) {
        const beat = secToBeat(song.tempoSegments, sec) - bar.startBeat;
        const cell = Math.max(0, Math.min(cellEls[bi].length - 1, Math.floor(beat + 1e-6)));
        key = `${bi}:${cell}`;
      }
      if (force || key !== shownCell) {
        if (shownCell) {
          const [b0, c0] = shownCell.split(':').map(Number);
          cellEls[b0]?.[c0]?.classList.remove('is-playing');
        }
        shownCell = key;
        if (key) {
          const [b1, c1] = key.split(':').map(Number);
          cellEls[b1]?.[c1]?.classList.add('is-playing');
        }
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

    /** Sizes the bars so that the whole song is on screen at once (no scrolling) whenever it can be read. */
    function fit(): void {
      if (disposed || bars.length === 0) return;
      const w = grid.clientWidth;
      const hgt = grid.clientHeight;
      if (w <= 0 || hgt <= 0) return;
      const cells = Math.max(1, Math.round(bars[0].beats));
      const f = fitGrid(bars.length, cells, w - 8, hgt - 8);
      if (f.fits) {
        grid.classList.remove('is-scroll');
        grid.style.setProperty('--cols', String(f.cols));
        grid.style.setProperty('--rows', String(f.rows));
        grid.style.setProperty('--fs', `${f.fontPx.toFixed(1)}px`);
      } else {
        grid.classList.add('is-scroll');
        const cols = Math.max(1, Math.floor((w - 8) / 150));
        grid.style.setProperty('--cols', String(cols));
        grid.style.setProperty('--fs', '16px');
      }
    }
    const fitObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;
    fitObserver?.observe(grid);
    window.addEventListener('resize', fit);

    paintRange();
    refresh(true);
    fit();
    if (bars.length === 0) setStatus('Esta canción no tiene compases.');
    else if (audioInfo) void loadTrack('song'); // decode ahead of the first tap

    return () => {
      disposed = true;
      fitObserver?.disconnect();
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(raf);
      stopSound();
      for (const t of Object.values(tracks)) t?.dispose();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', endDrag);
    };
  },
};
