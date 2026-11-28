/**
 * «Tablatura» (#/tab/:id): a guitar tablature (a punteo) to learn slowly. The six strings are drawn big, a mark
 * walks along the notes at the speed you choose (the note that goes NOW is lit, the NEXT one is outlined), and you
 * can loop a phrase (tap a phrase; Shift-click extends). The notes sound (a plucked-string sound, the pitch of
 * each string and fret in standard tuning) so you hear what you are going to play; «Sonido» turns it off.
 */
import './follow.css';
import './tab.css';
import type { Screen } from '../../types';
import { getSong } from '../../song/storage';
import { eventAt, parseTab, TAB_STRING_NAMES } from '../../song/tab';
import { getAudioContext } from '../../audio/context';
import { Metronome } from '../../audio/metronome';
import { pluckBuffer, tabNoteMidi } from '../../audio/noteSynth';
import { h } from '../dom';

const noop = (): void => undefined;
const COUNTDOWN_SEC = 5;
const COUNTDOWN_KEY = 'gz.tabCountdown';
const SOUND_KEY = 'gz.tabSound';
const START_DELAY_SEC = 0.06;
const LOOKAHEAD_SEC = 0.15;
const SPEEDS = [25, 35, 50, 65, 80, 100, 125];

export const tabScreen: Screen = {
  mount(root: HTMLElement, params: Record<string, string>): () => void {
    const id = params.id ?? '';
    const stored = id ? getSong(id) : null;
    if (!stored || !stored.tab) {
      location.replace('#/');
      return noop;
    }
    const tab = parseTab(stored.tab);
    const blocks = tab.blocks;
    const events = tab.events;
    const totalSec = tab.totalSec;
    const maxCols = Math.max(1, ...blocks.map((b) => b.cols));
    let disposed = false;

    // ---------------------------------------------------------------- state
    let playing = false;
    let counting = false;
    let countTimer = 0;
    let posSec = 0; // seconds at 100 % speed, kept while paused
    let baseSec = 0;
    let baseMs = 0;
    let speed = 0.5;
    let range: { a: number; b: number } | null = null; // inclusive block indices
    let anchor = 0;
    let raf = 0;
    let shownEvent = -2;
    const ctx = getAudioContext();
    const metronome = new Metronome(ctx);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    let soundOn = true;
    try {
      soundOn = localStorage.getItem(SOUND_KEY) !== '0';
    } catch {
      /* default on */
    }
    let baseCtx = 0; // AudioContext time at which `baseSec` sounds
    let schedIdx = 0; // next event to hand to the audio clock
    const active = new Set<AudioBufferSourceNode>();
    const outputLatency = (): number => {
      const l = (ctx as { outputLatency?: number }).outputLatency;
      return typeof l === 'number' && Number.isFinite(l) && l > 0 ? l : 0.03;
    };

    const loopStart = (): number => (range ? tab.blockStartSec[range.a] : 0);
    const loopEnd = (): number => (range ? tab.blockEndSec[range.b] : totalSec);
    const currentSec = (): number => (playing ? Math.min(totalSec, baseSec + (Math.max(0, performance.now() - baseMs) / 1000) * speed) : posSec);

    // ---------------------------------------------------------------- controls
    const playBtn = h('button.btn.btn-primary.follow-play', { type: 'button', onclick: () => void togglePlay() }, '▶ Empezar') as HTMLButtonElement;
    const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => h('button.btn.btn-sm', { type: 'button', title, 'aria-label': title, onclick: fn }, label) as HTMLButtonElement;
    const rewindBtn = btn('⏮ Inicio', 'Volver al principio (del tramo elegido, o de la tablatura)', () => seek(loopStart()));
    const prevBtn = btn('◀', 'Frase anterior', () => seek(tab.blockStartSec[Math.max(0, blockAt(currentSec()) - 1)]));
    const nextBtn = btn('▶', 'Frase siguiente', () => seek(tab.blockStartSec[Math.min(blocks.length - 1, blockAt(currentSec()) + 1)]));
    const timeEl = h('span.follow-time', null, '');
    const seekEl = h('input', { type: 'range', min: '0', max: String(Math.round(totalSec * 20) / 20), step: '0.05', value: '0', class: 'follow-seek', 'aria-label': 'Posición' }) as HTMLInputElement;
    seekEl.addEventListener('input', () => seek(Number(seekEl.value)));

    const loopBox = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Bucle' }) as HTMLInputElement;
    const loopLabel = h('label.follow-chip.btn.btn-sm', { title: 'Bucle: al llegar al final de la frase elegida (o de la tablatura) vuelve a empezar' }, loopBox, h('span', null, '🔁 Bucle'));
    loopLabel.classList.toggle('is-on', loopBox.checked);
    loopBox.addEventListener('change', () => loopLabel.classList.toggle('is-on', loopBox.checked));

    let countdownOn = true;
    try {
      countdownOn = localStorage.getItem(COUNTDOWN_KEY) !== '0';
    } catch {
      /* default on */
    }
    const countdownBtn = h('button.btn.btn-sm.follow-chip.follow-countdown', {
      type: 'button',
      title: 'Cuenta atrás de 5 segundos (con clics) antes de empezar',
      onclick: () => {
        countdownOn = !countdownOn;
        countdownBtn.classList.toggle('is-on', countdownOn);
        try {
          localStorage.setItem(COUNTDOWN_KEY, countdownOn ? '1' : '0');
        } catch {
          /* not remembered */
        }
      },
    }, `⏱ Cuenta atrás ${COUNTDOWN_SEC} s`) as HTMLButtonElement;
    countdownBtn.classList.toggle('is-on', countdownOn);
    const soundBtn = h('button.btn.btn-sm.follow-chip', {
      type: 'button',
      title: 'Que suenen las notas (con un sonido de guitarra sencillo) para oír cómo va',
      onclick: () => {
        soundOn = !soundOn;
        soundBtn.classList.toggle('is-on', soundOn);
        if (!soundOn) stopNotes();
        try {
          localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
        } catch {
          /* not remembered */
        }
      },
    }, '🔊 Sonido') as HTMLButtonElement;
    soundBtn.classList.toggle('is-on', soundOn);
    const countOverlay = h('div.follow-count', { role: 'status', 'aria-live': 'polite' });
    countOverlay.hidden = true;

    const speedSel = h('select.follow-speed', { 'aria-label': 'Velocidad' }) as HTMLSelectElement;
    for (const pct of SPEEDS) speedSel.appendChild(h('option', { value: String(pct) }, `${pct} %`));
    speedSel.value = '50';
    speedSel.addEventListener('change', () => {
      const at = currentSec();
      speed = Number(speedSel.value) / 100;
      if (playing) resync(at);
    });

    const rangeInfo = h('span.follow-selinfo.muted.small', null, '');
    const clearBtn = btn('✕ Toda la tablatura', 'Quitar la frase elegida', () => setRange(null));
    const rangeRow = h('div.follow-row.follow-rangerow', null, rangeInfo, clearBtn);
    rangeRow.hidden = true;
    const hint = h('div.muted.small.tab-hint', null, 'Toca una frase para practicarla en bucle. Mayús+clic para elegir varias.');
    const helpBody = h(
      'div.tab-help-body',
      null,
      h('p', null, 'Las 6 líneas son las 6 cuerdas: arriba la más fina (la 1ª, «e») y abajo la más gruesa (la 6ª, «E»).'),
      h('p', null, 'El número es el traste donde pones el dedo: 0 es la cuerda al aire; 12 es el traste 12. Los números se tocan de izquierda a derecha.'),
      h('p', null, '«/» entre dos números: desliza el dedo por la cuerda de uno al otro. «~»: vibrato (mueve el dedo un poquito).'),
      h('p', null, 'Las notas suenan para que oigas cómo va (botón «Sonido»). El número en verde es el que toca AHORA; el que tiene el borde naranja es el SIGUIENTE. Empieza lento (25–35 %) y sube.'),
    );
    const help = h('details.tab-help', null, h('summary.btn.btn-sm', null, '¿Cómo se lee?'), helpBody);
    const controls = h(
      'div.follow-controls',
      null,
      h('div.follow-row.follow-toolbar', null, h('strong.follow-title', null, stored.title || 'Tablatura'), playBtn, h('div.follow-group', null, rewindBtn), h('div.follow-group', null, prevBtn, h('span.follow-group-label', null, 'Frase'), nextBtn), h('span.follow-sep'), loopLabel, soundBtn, countdownBtn, h('label.follow-speedbox', { title: 'Velocidad: más lento para aprender' }, h('span', null, 'Velocidad'), speedSel), help),
      h('div.follow-row', null, timeEl, seekEl),
      rangeRow,
      hint,
    );

    // ---------------------------------------------------------------- the tablature
    const wrap = h('div.tab-blocks') as HTMLDivElement;
    const blockEls: HTMLElement[] = [];
    const noteEls: HTMLElement[][] = events.map(() => []);
    const eventIndexOf = new Map<string, number>();
    events.forEach((e, i) => eventIndexOf.set(`${e.block}:${e.col}`, i));
    blocks.forEach((b, bi) => {
      const rows = TAB_STRING_NAMES.map((name, row) => {
        const rowEl = h('div.tab-row', null, h('span.tab-name', null, name));
        const line = h('div.tab-line', { style: `--cols:${b.cols}` });
        for (const n of b.notes.filter((x) => x.row === row)) {
          const el = h('span.tab-note', { style: `left:calc(${n.col} * 1.5ch)`, class: n.slide ? 'has-slide' : n.vib ? 'has-vib' : '' }, String(n.fret));
          const ei = eventIndexOf.get(`${bi}:${n.col}`);
          if (ei !== undefined) noteEls[ei].push(el);
          line.appendChild(el);
        }
        rowEl.appendChild(line);
        return rowEl;
      });
      const el = h('div.tab-block', { dataset: { b: String(bi) }, role: 'group', 'aria-label': `Frase ${bi + 1}` }, h('div.tab-block-num', null, `Frase ${bi + 1}`), ...rows);
      blockEls.push(el);
      wrap.appendChild(el);
    });
    wrap.style.setProperty('--maxcols', String(maxCols));

    const screen = h('main.screen.follow.tabscreen', null, controls, wrap, countOverlay);
    root.appendChild(screen);

    /** Font size so that the widest phrase fits the width of the screen. */
    function fit(): void {
      if (disposed) return;
      const w = wrap.clientWidth;
      if (w <= 0) return;
      const fs = Math.max(11, Math.min(26, (w - 56) / (maxCols * 0.93 + 2)));
      wrap.style.setProperty('--tfs', `${fs.toFixed(1)}px`);
    }
    const fitObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;
    fitObserver?.observe(wrap);
    window.addEventListener('resize', fit);

    const blockAt = (sec: number): number => {
      const e = eventAt(tab, sec);
      if (e >= 0) return events[e].block;
      return 0;
    };

    // ---------------------------------------------------------------- range
    function paintRange(): void {
      blockEls.forEach((el, i) => el.classList.toggle('in-range', !!range && i >= range.a && i <= range.b));
      rangeRow.hidden = !range;
      hint.hidden = !!range;
      rangeInfo.textContent = range ? (range.a === range.b ? `Frase ${range.a + 1} elegida` : `Frases ${range.a + 1}–${range.b + 1} elegidas`) + (loopBox.checked ? ': se repite' : '') : '';
    }

    function setRange(next: { a: number; b: number } | null): void {
      range = next ? { a: Math.min(next.a, next.b), b: Math.max(next.a, next.b) } : null;
      paintRange();
      if (range) seek(tab.blockStartSec[range.a]);
    }

    wrap.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest('.tab-block') as HTMLElement | null;
      if (!el || el.dataset.b === undefined) return;
      const i = Number(el.dataset.b);
      if (ev.shiftKey && range) setRange({ a: Math.min(range.a, i), b: Math.max(range.b, i) });
      else {
        anchor = i;
        setRange({ a: i, b: i });
      }
    });
    void anchor;

    // ---------------------------------------------------------------- playback
    function stopNotes(): void {
      for (const src of active) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      active.clear();
    }

    /** Puts the audio clock and the screen clock on the same instant, `sec` of the tablature. */
    function resync(sec: number): void {
      baseSec = sec;
      baseCtx = ctx.currentTime + START_DELAY_SEC;
      // The screen is shown when the sound reaches the ear, a little after it was handed to the audio clock.
      baseMs = performance.now() + (START_DELAY_SEC + outputLatency()) * 1000;
      const first = events.findIndex((e) => e.atSec >= sec - 1e-6);
      schedIdx = first < 0 ? events.length : first;
    }

    function playEvent(e: (typeof events)[number], when: number): void {
      e.notes.forEach((n, i) => {
        const src = ctx.createBufferSource();
        src.buffer = pluckBuffer(ctx, tabNoteMidi(n.row, n.fret));
        const g = ctx.createGain();
        g.gain.value = 0.8;
        src.connect(g).connect(master);
        src.start(when + i * 0.008); // the strings of a chord are not struck at the very same instant
        active.add(src);
        src.onended = () => {
          active.delete(src);
          src.disconnect();
          g.disconnect();
        };
      });
    }

    /** Hands the notes of the next fraction of a second to the audio clock (exact timing, whatever the frame rate). */
    function schedule(): void {
      if (ctx.state !== 'running') return; // the browser has not let the audio start yet: nothing to hand over
      const next = events[schedIdx];
      // The audio clock stood still while it was suspended: if it has jumped ahead, start counting again from here.
      if (next && baseCtx + (next.atSec - baseSec) / speed < ctx.currentTime - 0.3) resync(currentSec());
      const horizon = ctx.currentTime + LOOKAHEAD_SEC;
      while (schedIdx < events.length) {
        const e = events[schedIdx];
        const when = baseCtx + (e.atSec - baseSec) / speed;
        if (when > horizon) break;
        if (soundOn && when > ctx.currentTime - 0.08) playEvent(e, Math.max(when, ctx.currentTime));
        schedIdx++;
      }
    }

    function startRun(sec: number): void {
      posSec = Math.max(0, Math.min(totalSec, sec));
      void ctx.resume();
      stopNotes();
      resync(posSec);
      schedule();
      playing = true;
      playBtn.textContent = '⏸ Pausa';
      playBtn.classList.add('is-playing');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function cancelCount(): void {
      if (!counting) return;
      counting = false;
      window.clearTimeout(countTimer);
      metronome.clear();
      countOverlay.hidden = true;
      playBtn.textContent = '▶ Empezar';
    }

    async function countThenStart(from: number): Promise<void> {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
      counting = true;
      playBtn.textContent = '✕ Cancelar';
      const t0 = ctx.currentTime + 0.1;
      for (let k = 0; k < COUNTDOWN_SEC; k++) metronome.scheduleClick(t0 + k, k === COUNTDOWN_SEC - 1);
      let n = COUNTDOWN_SEC;
      const step = (): void => {
        if (!counting || disposed) return;
        if (n === 0) {
          counting = false;
          countOverlay.hidden = true;
          startRun(from);
          return;
        }
        countOverlay.textContent = String(n);
        countOverlay.hidden = false;
        n--;
        countTimer = window.setTimeout(step, 1000);
      };
      step();
    }

    function pause(): void {
      if (playing) posSec = currentSec();
      playing = false;
      stopNotes();
      cancelAnimationFrame(raf);
      playBtn.textContent = '▶ Seguir';
      playBtn.classList.remove('is-playing');
      refresh(true);
    }

    async function togglePlay(): Promise<void> {
      if (counting) {
        cancelCount();
        return;
      }
      if (playing) {
        pause();
        return;
      }
      let from = posSec;
      if (from < loopStart() || from >= loopEnd() - 0.05) from = loopStart();
      if (countdownOn) await countThenStart(from);
      else {
        try {
          await ctx.resume();
        } catch {
          /* a tap is a gesture; ignore */
        }
        startRun(from);
      }
    }

    function seek(sec: number): void {
      cancelCount();
      const target = Math.max(0, Math.min(totalSec, sec));
      posSec = target;
      if (playing) {
        stopNotes();
        resync(target);
        schedule();
      }
      refresh(true);
    }

    function tick(): void {
      if (!playing || disposed) return;
      const sec = currentSec();
      if (sec >= loopEnd() - 0.005) {
        if (loopBox.checked) {
          startRun(loopStart());
          return;
        }
        posSec = loopStart();
        pause();
        return;
      }
      schedule();
      refresh(false);
      raf = requestAnimationFrame(tick);
    }

    // ---------------------------------------------------------------- display
    function refresh(force: boolean): void {
      const sec = currentSec();
      const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      timeEl.textContent = `${fmt(sec / speed)} / ${fmt(totalSec / speed)}`;
      if (document.activeElement !== seekEl) seekEl.value = String(sec);
      const ei = eventAt(tab, sec);
      if (!force && ei === shownEvent) return;
      if (shownEvent >= 0) {
        for (const el of noteEls[shownEvent] ?? []) el.classList.remove('is-playing');
        for (const el of noteEls[shownEvent + 1] ?? []) el.classList.remove('is-next');
      }
      shownEvent = ei;
      // Lit only while it runs; paused or before the first note nothing is «playing», only the next one waits.
      if (playing && ei >= 0) for (const el of noteEls[ei]) el.classList.add('is-playing');
      for (const el of noteEls[ei + 1] ?? []) el.classList.add('is-next');
      const bi = ei >= 0 ? events[ei].block : blockAt(sec);
      blockEls.forEach((el, i) => el.classList.toggle('is-now', i === bi));
      const el = blockEls[bi];
      if (el) {
        const top = el.offsetTop - wrap.offsetTop;
        const rel = top - wrap.scrollTop;
        if (rel < 0 || rel > wrap.clientHeight * 0.45) wrap.scrollTo({ top: Math.max(0, top - 8), behavior: force ? 'auto' : 'smooth' });
      }
    }

    function onKey(ev: KeyboardEvent): void {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        void togglePlay();
      }
    }
    document.addEventListener('keydown', onKey);

    paintRange();
    fit();
    refresh(true);

    return () => {
      disposed = true;
      window.clearTimeout(countTimer);
      cancelAnimationFrame(raf);
      stopNotes();
      master.disconnect();
      metronome.clear();
      fitObserver?.disconnect();
      window.removeEventListener('resize', fit);
      document.removeEventListener('keydown', onKey);
    };
  },
};
