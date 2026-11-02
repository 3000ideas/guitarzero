/**
 * «Comprobar» view: one bar at a time, to check the written chords and strum against the audio.
 *
 * A canvas shows, for the chosen bar (plus one beat of context on each side), the waveform of
 * the audio, the beat lines of the grid, the chord cells of the bar, the strikes the text asks
 * for (↓ ↑ ✕, from the `strum:` pattern) and the loudness peaks the audio seems to have. If the
 * strikes line up with the peaks, the text fits the audio. The host plays the bar in a loop.
 */
import type { Song } from '../types';
import { h } from './dom';
import { beatToSec, secToBeat } from '../song/tempo';
import {
  audioRhythm,
  barCells,
  barStrums,
  spacedRhythm,
  textRhythm,
  barWindow,
  energyAttacks,
  strumCaption,
  windowPeaks,
  type BarStrum,
} from '../song/barCheck';
import { WAVEFORM_COLORS, STRUM_MARK_COLORS } from './waveform';
import type { PlaySource } from './chordGrid';
import { createAutoSyncBox, type AutoSyncBox, type AutoSyncOpts } from './autoSyncBox';
import type { BarDrift, DriftJump } from '../dsp/syncFit';

export interface BarCheckAudio {
  offsetSec: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface BarCheckOpts {
  onPlayToggle: () => void;
  /** The shown bar changed (the host stops a playback in progress). */
  onBarChange: (barIndex: number) => void;
  /** Nudges where the song starts in the audio. */
  onNudgeOffset: (deltaSec: number) => void;
  /** Beat (absolute) being heard now, or null when nothing plays. */
  getPlayBeat: () => number | null;
  autoSync: AutoSyncOpts;
  /** «Ver dónde se pierde la sincronía»: the host analyses the whole audio and calls `setDrift`. */
  onAnalyzeDrift: () => void;
  /** «Corregir» a jump with a tempo change of its bar. */
  onFixJump: (jump: DriftJump) => void;
  /** «Usar el ritmo del audio en este compás»: the host writes `strum:` for that bar only. */
  onUseRhythm: (barIndex: number, pattern: string) => void;
  /** «Seguir el audio»: compute a tempo for every line (the result and what to do next come back through `setFollow`). */
  onFollowRun: () => void;
}

export interface FollowAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface BarCheckView {
  el: HTMLElement;
  autoSync: AutoSyncBox;
  /** Result of the bar-by-bar analysis (null clears it); `note` is a message for the user. */
  setDrift(drift: readonly BarDrift[] | null, jumps: readonly DriftJump[], note?: string): void;
  /** Result of «Seguir el audio» (null hides it). */
  setFollow(result: { text: string; bad?: boolean; actions: FollowAction[] } | null, busy?: boolean): void;
  /** New text / audio: redraws, keeping the bar when it still exists. */
  setContext(song: Song, audio: BarCheckAudio | null): void;
  setBar(index: number): void;
  getBar(): number;
  setPlaying(playing: boolean): void;
  getPlaySource(): PlaySource;
  getMetronome(): boolean;
  /** Start and end of the bar in song beats (what the host loops). */
  getBarRange(): { startBeat: number; endBeat: number } | null;
  dispose(): void;
}

const CANVAS_H = 250;
const WAVE_TOP = 6;
const WAVE_H = 120;
const RULER_Y = WAVE_TOP + WAVE_H;
const CELL_Y = RULER_Y + 22;
const CELL_H = 38;
const STRUM_Y = CELL_Y + CELL_H + 8;
const ATTACK_COLOR = '#fb923c';

export function createBarCheck(opts: BarCheckOpts): BarCheckView {
  let song: Song | null = null;
  let audio: BarCheckAudio | null = null;
  let bar = 0;
  let playing = false;
  let raf = 0;
  let disposed = false;
  let attacks: number[] = [];

  const title = h('div.check-title');
  const caption = h('div.check-caption.muted.small');
  const prevBtn = h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Compás anterior', onclick: () => setBar(bar - 1) }, '◀') as HTMLButtonElement;
  const nextBtn = h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Compás siguiente', onclick: () => setBar(bar + 1) }, '▶') as HTMLButtonElement;
  const playBtn = h('button.btn.btn-sm.btn-primary.check-play', { type: 'button', onclick: () => opts.onPlayToggle() }, '▶ Escuchar este compás') as HTMLButtonElement;
  const sourceSel = h('select', { 'aria-label': 'Qué escuchar' }) as HTMLSelectElement;
  for (const [value, label] of [['song', 'Canción original'], ['both', 'Canción + acordes'], ['chords', 'Solo acordes']] as Array<[PlaySource, string]>) {
    sourceSel.appendChild(h('option', { value }, label));
  }
  const metro = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Clic de metrónomo' }) as HTMLInputElement;
  const canvas = h('canvas', { class: 'check-canvas', 'aria-label': 'Onda del compás con los pulsos, los acordes y los golpes' }) as HTMLCanvasElement;
  const wrap = h('div.check-wave', null, canvas);
  const note = h('p.check-note.muted.small');
  const nudgeBtn = (label: string, deltaMs: number): HTMLElement =>
    h('button.grid-mini', { type: 'button', title: `${deltaMs > 0 ? 'Retrasa' : 'Adelanta'} la cuadrícula ${Math.abs(deltaMs)} ms`, onclick: () => opts.onNudgeOffset(deltaMs / 1000) }, label);

  const autoSync = createAutoSyncBox(opts.autoSync);
  const followBtn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => opts.onFollowRun() }, '✨ Seguir el audio') as HTMLButtonElement;
  const followText = h('div.auto-sync-text');
  const followActions = h('div.auto-sync-actions');
  const followResult = h('div.auto-sync-result', { role: 'status' }, followText, followActions);
  followResult.hidden = true;
  const driftBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => opts.onAnalyzeDrift() }, '🔎 Ver dónde se pierde la sincronía') as HTMLButtonElement;
  const driftStrip = h('div.drift-strip');
  const driftText = h('div.drift-text');
  const driftBox = h(
    'div.check-drift',
    null,
    h('div.auto-sync-row', null, followBtn, h('span.muted.small', null, 'Si una persona toca, el tempo nunca es exacto: esto pone un tempo a cada línea para que el texto siga a la grabación. Es la forma sencilla de arreglar muchos desfases.')),
    followResult,
    h('div.auto-sync-row', null, driftBtn, h('span.muted.small', null, 'Solo para mirar: el desfase de cada compás.')),
    driftStrip,
    driftText,
  );
  const rhythmText = h('code.rhythm-text');
  const rhythmAudio = h('code.rhythm-audio');
  const rhythmUse = h('button.btn.btn-sm', { type: 'button' }) as HTMLButtonElement;
  const rhythmBox = h(
    'div.check-rhythm',
    null,
    h('div.rhythm-row', null, h('span.rhythm-label', null, 'Tu texto'), rhythmText),
    h('div.rhythm-row', null, h('span.rhythm-label', null, 'En el audio'), rhythmAudio),
    h('div.rhythm-row', null, rhythmUse, h('span.muted.small', null, 'D = ↓ (en el pulso), U = ↑ (entre pulsos), - = nada. Cuatro huecos por pulso.')),
  );
  const legend = h(
    'ul.check-legend',
    null,
    h('li', null, h('span.sw.sw-wave'), ' Onda de tu audio'),
    h('li', null, h('span.sw.sw-beat'), ' Pulsos (1, 2, 3, 4…)'),
    h('li', null, h('span.sw.sw-down'), ' ↓ y ', h('span.sw.sw-up'), ' ↑ ', h('span.sw.sw-mute'), ' ✕: golpes que pide tu texto'),
    h('li', null, h('span.sw.sw-attack'), ' ▲ Golpes que parece haber en el audio'),
  );
  const help = h(
    'details.check-help',
    null,
    h('summary', null, '¿Cómo se lee esto? ¿Dónde hay que rasguear?'),
    h('p', null, 'Cada casilla de abajo es un pulso. La letra del acorde indica en qué pulso EMPIEZA ese acorde, no el único pulso donde se toca.'),
    h('p', null, 'Los golpes los marca el patrón de rasgueo (strum:), con las flechas ↓ ↑ ✕ de la fila inferior: cada flecha suena con el acorde que esté vigente en ese momento. Un hueco («-») del patrón no suena, salvo que justo ahí cambie el acorde: entonces se toca un ↓ extra.'),
    h('p', null, 'Para comprobar el texto, mira si las flechas caen sobre los picos de la onda (y sobre los ▲ naranjas). Si todas van un poco antes o después, ajusta el inicio con −/+ ms; si cada vez se separan más, el tempo no es exacto (usa decimales: tempo: 96.5).'),
  );
  const nudges = h('div.check-nudge', null, h('span', null, 'Si todo va antes o después:'), nudgeBtn('−100', -100), nudgeBtn('−10', -10), nudgeBtn('+10', 10), nudgeBtn('+100', 100), h('span.muted.small', null, '(mueve la cuadrícula respecto al audio)'));

  const el = h(
    'div.bar-check',
    null,
    h('div.check-head', null, prevBtn, title, nextBtn),
    caption,
    h('div.check-transport', null, playBtn, sourceSel, h('label.grid-check', null, metro, h('span', null, 'Clic en cada pulso'))),
    autoSync.el,
    driftBox,
    wrap,
    legend,
    rhythmBox,
    note,
    nudges,
    help,
  );

  // ---------------------------------------------------------------- drawing

  function strumColor(kind: BarStrum['kind']): string {
    return STRUM_MARK_COLORS[kind === 'down' ? 'down' : kind === 'up' ? 'up' : 'muted'];
  }

  function draw(): void {
    if (disposed || !song) return;
    const win = barWindow(song, bar);
    if (!win) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const W = Math.max(240, Math.floor(wrap.clientWidth || 320));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(CANVAS_H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const span = win.w1 - win.w0;
    const xOf = (beat: number): number => ((beat - win.w0) / span) * W;

    ctx.fillStyle = WAVEFORM_COLORS.bg;
    ctx.fillRect(0, 0, W, CANVAS_H);

    // The bar itself, a little lighter than its context.
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(xOf(win.startBeat), 0, xOf(win.endBeat) - xOf(win.startBeat), CANVAS_H);

    // Waveform.
    const midY = WAVE_TOP + WAVE_H / 2;
    if (audio) {
      const peaks = windowPeaks(audio.samples, audio.sampleRate, song, audio.offsetSec, win.w0, win.w1, W);
      let top = 0;
      for (let i = 0; i < W; i++) top = Math.max(top, peaks.max[i], -peaks.min[i]);
      const gain = top > 0.001 ? 1 / top : 1;
      ctx.fillStyle = WAVEFORM_COLORS.wave;
      for (let x = 0; x < W; x++) {
        const y1 = midY - peaks.max[x] * gain * (WAVE_H / 2 - 2);
        const y2 = midY - peaks.min[x] * gain * (WAVE_H / 2 - 2);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } else {
      ctx.fillStyle = WAVEFORM_COLORS.empty;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Carga un audio en «Pista de audio» para ver su onda aquí', W / 2, midY);
    }
    ctx.strokeStyle = WAVEFORM_COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(W, midY + 0.5);
    ctx.stroke();

    // Beat lines + numbers.
    const n = song.bars[bar].beats;
    ctx.textAlign = 'center';
    ctx.font = '12px system-ui, sans-serif';
    for (let k = Math.ceil(win.w0 - 1e-9); k <= win.w1 + 1e-9; k++) {
      const x = Math.round(xOf(k)) + 0.5;
      const inBar = k >= win.startBeat - 1e-9 && k < win.endBeat - 1e-9;
      const edge = Math.abs(k - win.startBeat) < 1e-9 || Math.abs(k - win.endBeat) < 1e-9;
      ctx.strokeStyle = edge ? WAVEFORM_COLORS.bar : WAVEFORM_COLORS.beat;
      ctx.lineWidth = edge ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, WAVE_TOP);
      ctx.lineTo(x, CANVAS_H - 6);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (k < win.endBeat - 1e-9 || k < win.w1 - 1e-9) {
        const num = ((((k - win.startBeat) % n) + n) % n) + 1;
        ctx.fillStyle = inBar ? WAVEFORM_COLORS.barText : 'rgba(170,178,192,0.4)';
        ctx.fillText(String(num), xOf(k + 0.5), RULER_Y + 14);
      }
    }

    // Chord cells of the bar.
    ctx.textBaseline = 'middle';
    for (const cell of barCells(song, bar)) {
      const x0 = xOf(cell.beat) + 2;
      const x1 = xOf(cell.beat + 1) - 2;
      ctx.fillStyle = cell.chord && !cell.rest ? 'rgba(34,211,238,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.strokeStyle = cell.chord && !cell.rest ? 'rgba(34,211,238,0.6)' : WAVEFORM_COLORS.beat;
      ctx.beginPath();
      ctx.roundRect(x0, CELL_Y, x1 - x0, CELL_H, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = cell.chord && !cell.rest ? '#e6edf7' : WAVEFORM_COLORS.empty;
      ctx.font = cell.chord && !cell.rest ? 'bold 16px system-ui, sans-serif' : '16px system-ui, sans-serif';
      ctx.fillText(cell.chord === null ? '·' : cell.rest ? '–' : cell.chord, (x0 + x1) / 2, CELL_Y + CELL_H / 2);
    }
    ctx.textBaseline = 'alphabetic';

    // Strikes asked by the text: a dashed line up through the wave and an arrow below the cells.
    const strums = barStrums(song, bar);
    for (const s of strums) {
      const x = Math.round(xOf(s.beat)) + 0.5;
      const color = strumColor(s.kind);
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, WAVE_TOP);
      ctx.lineTo(x, RULER_Y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillText(s.kind === 'down' ? '↓' : s.kind === 'up' ? '↑' : '✕', x, STRUM_Y + 22);
      if (s.chordChange) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = WAVEFORM_COLORS.barText;
        ctx.fillText(s.chord, x, STRUM_Y + 38);
      }
    }

    // What the audio seems to do.
    if (audio) {
      ctx.fillStyle = ATTACK_COLOR;
      for (const sec of attacks) {
        const beat = secToBeat(song.tempoSegments, sec - audio.offsetSec);
        if (beat < win.w0 || beat > win.w1) continue;
        const x = xOf(beat);
        ctx.beginPath();
        ctx.moveTo(x, WAVE_TOP + 2);
        ctx.lineTo(x - 5, WAVE_TOP + 12);
        ctx.lineTo(x + 5, WAVE_TOP + 12);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Playhead.
    const pb = opts.getPlayBeat();
    if (pb !== null && pb >= win.w0 && pb <= win.w1) {
      const x = Math.round(xOf(pb)) + 0.5;
      ctx.strokeStyle = WAVEFORM_COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  function loop(): void {
    raf = 0;
    if (disposed) return;
    draw();
    if (playing) raf = requestAnimationFrame(loop);
  }

  function refreshTexts(): void {
    if (!song || song.bars.length === 0) {
      title.textContent = 'Aún no hay compases';
      caption.textContent = 'Escribe acordes en la cuadrícula para poder comprobarlos.';
      prevBtn.disabled = nextBtn.disabled = playBtn.disabled = true;
      return;
    }
    const b = song.bars[bar];
    const names = [...new Set(b.chords.filter((c) => c.chord.name !== '-').map((c) => c.chord.name))];
    title.textContent = `Compás ${bar + 1} de ${song.bars.length}${b.section ? ` · ${b.section}` : ''}${names.length ? ` · ${names.join(' → ')}` : ''}`;
    caption.textContent = `Golpes del texto: ${strumCaption(barStrums(song, bar))}`;
    prevBtn.disabled = bar <= 0;
    nextBtn.disabled = bar >= song.bars.length - 1;
    playBtn.disabled = false;
    note.textContent = audio
      ? 'Los ▲ naranjas son una estimación sencilla del volumen del audio: sirven para comparar a ojo, no son exactos.'
      : 'Sin audio solo se ve el texto (acordes y golpes). Carga una canción en «Pista de audio» para ver su onda.';
    for (const o of Array.from(sourceSel.options)) if (o.value !== 'chords') o.disabled = !audio;
    if (!audio) sourceSel.value = 'chords';
  }

  /** The rhythm of the text and of the audio for the shown bar, and the button that copies the audio's. */
  function refreshRhythm(): void {
    if (!song || song.bars.length === 0) return;
    const written = textRhythm(song, bar);
    rhythmText.textContent = written ? spacedRhythm(written) : '—';
    const heard = audio ? audioRhythm(song, bar, attacks, audio.offsetSec) : '';
    rhythmAudio.textContent = heard ? spacedRhythm(heard) : audio ? '(sin golpes claros)' : '(sin audio)';
    const differs = heard !== '' && heard !== written;
    rhythmUse.hidden = !differs;
    rhythmUse.textContent = 'Usar el ritmo del audio en este compás';
    rhythmUse.onclick = () => opts.onUseRhythm(bar, heard);
    rhythmAudio.classList.toggle('is-diff', differs);
  }

  function recompute(): void {
    attacks = [];
    if (song && audio) {
      const win = barWindow(song, bar);
      if (win) {
        const { tempoSegments } = song;
        // Audio seconds of the visible window.
        const from = audio.offsetSec + beatToSec(tempoSegments, win.w0);
        const to = audio.offsetSec + beatToSec(tempoSegments, win.w1);
        attacks = energyAttacks(audio.samples, audio.sampleRate, from, to);
      }
    }
    refreshTexts();
    refreshRhythm();
    draw();
  }

  function setBar(index: number): void {
    if (!song || song.bars.length === 0) return;
    const clamped = Math.max(0, Math.min(song.bars.length - 1, Math.round(index)));
    const changed = clamped !== bar;
    bar = clamped;
    if (changed) opts.onBarChange(bar);
    recompute();
  }

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  observer?.observe(wrap);

  function renderDrift(drift: readonly BarDrift[] | null, jumps: readonly DriftJump[], note?: string): void {
    driftStrip.replaceChildren();
    driftText.replaceChildren();
    if (!drift) {
      if (note) driftText.appendChild(h('p', null, note));
      return;
    }
    for (const d of drift) {
      const ms = d.deltaSec === null ? null : Math.round(d.deltaSec * 1000);
      const level = ms === null ? 'none' : Math.abs(ms) <= 25 ? 'ok' : Math.abs(ms) <= 60 ? 'warn' : 'bad';
      driftStrip.appendChild(
        h(
          'button.drift-chip',
          {
            type: 'button',
            class: `lvl-${level}${d.bar === bar ? ' is-current' : ''}`,
            title: ms === null ? `Compás ${d.bar + 1}: sin respuesta clara (silencio u otro ritmo)` : `Compás ${d.bar + 1}: el audio va ${ms > 0 ? 'detrás' : 'delante'} ${Math.abs(ms)} ms`,
            onclick: () => setBar(d.bar),
          },
          h('span.drift-n', null, String(d.bar + 1)),
          h('span.drift-ms', null, ms === null ? '?' : `${ms > 0 ? '+' : ''}${ms}`),
        ),
      );
    }
    if (note) driftText.appendChild(h('p', null, note));
    if (jumps.length === 0) {
      driftText.appendChild(h('p', null, 'No hay saltos bruscos: el audio y el texto avanzan juntos (los «?» son compases con otro ritmo o sin audio).'));
      return;
    }
    const advanced = h('details.drift-advanced', null, h('summary', null, `Cambios bruscos detectados: ${jumps.length} (avanzado; «Seguir el audio» ya los tiene en cuenta)`));
    driftText.appendChild(advanced);
    for (const j of jumps) {
      const ms = Math.round(Math.abs(j.jumpSec) * 1000);
      advanced.appendChild(
        h(
          'div.drift-jump',
          null,
          h(
            'p',
            null,
            `Entre los compases ${j.fromBar + 1} y ${j.toBar + 1} el audio se desplaza ${ms} ms. El compás ${j.culpritBar + 1} dura ${ms} ms ${j.jumpSec > 0 ? 'MÁS' : 'MENOS'} en el audio que en el texto; por eso lo que va después deja de coincidir.`,
          ),
          h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => opts.onFixJump(j) }, `Corregir el compás ${j.culpritBar + 1} con un cambio de tempo`),
        ),
      );
    }
  }

  return {
    el,
    autoSync,
    setDrift: renderDrift,
    setFollow(result, busy) {
      followBtn.disabled = !!busy;
      followBtn.textContent = busy ? 'Analizando…' : '✨ Seguir el audio';
      if (!result) {
        followResult.hidden = true;
        return;
      }
      followResult.hidden = false;
      followResult.classList.toggle('is-bad', !!result.bad);
      followText.textContent = result.text;
      followActions.replaceChildren(
        ...result.actions.map((a) => h(a.primary ? 'button.btn.btn-sm.btn-primary' : 'button.btn.btn-sm', { type: 'button', onclick: a.run }, a.label)),
        h('button.btn.btn-sm', { type: 'button', onclick: () => { followResult.hidden = true; } }, 'Cerrar'),
      );
    },
    setContext(nextSong, nextAudio) {
      song = nextSong;
      audio = nextAudio;
      bar = Math.max(0, Math.min(Math.max(0, song.bars.length - 1), bar));
      recompute();
    },
    setBar,
    getBar() {
      return bar;
    },
    setPlaying(p) {
      playing = p;
      playBtn.textContent = p ? '■ Parar' : '▶ Escuchar este compás';
      if (p && !raf) raf = requestAnimationFrame(loop);
      if (!p) draw();
    },
    getPlaySource() {
      return sourceSel.value as PlaySource;
    },
    getMetronome() {
      return metro.checked;
    },
    getBarRange() {
      const win = song ? barWindow(song, bar) : null;
      return win ? { startBeat: win.startBeat, endBeat: win.endBeat } : null;
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    },
  };
}
