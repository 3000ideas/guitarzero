/**
 * «Analizar un tramo»: a small modal where the user marks a stretch of the recording (an intro, a verse…) ON THE
 * WAVEFORM, sees its tempo and where its bars start (drawn on the wave), and turns it into a section of the song.
 * Nothing of it lives on the editor screen: the button that opens it is one of the transport's extra controls.
 */
import { analyzeSpan, suggestSpan, type SpanResult } from '../dsp/spanAnalysis';
import { h } from './dom';
import { createSpanPicker } from './spanPicker';

export interface SpanAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SpanDialogOpts {
  /** The loaded track (decoded), or null. */
  getAudio(): SpanAudio | null;
  /** Beats per bar of the song. */
  getBeatsPerBar(): number;
  /** Plays the marked stretch from `fromSec` to `toSec` (audio seconds), with a click at each of `clicks` when given. */
  play(fromSec: number, toSec: number, clicks: ReadonlyArray<{ t: number; accent: boolean }>): void;
  stop(): void;
  /** Audio seconds being played, or null when nothing plays. */
  getPlayingSec(): number | null;
  /** Writes the section. Returns an error text (Spanish) or null when it worked, plus what to tell the user. */
  onCreate(result: SpanResult, label: string, chords: string[]): { error: string | null; message: string };
}

export interface SpanDialog {
  el: HTMLDialogElement;
  open(): void;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function createSpanDialog(opts: SpanDialogOpts): SpanDialog {
  const picker = createSpanPicker({ onChange: () => analyze() });
  const barsInput = h('input', { type: 'number', class: 'span-bars', min: '1', max: '64', step: '1', placeholder: 'auto', 'aria-label': 'Número de compases' }) as HTMLInputElement;
  const status = h('div.span-status', { role: 'status' });
  const result = h('div.span-result');
  const labelInput = h('input', { type: 'text', class: 'span-label', value: 'Intro', autocomplete: 'off', 'aria-label': 'Nombre de la sección' }) as HTMLInputElement;
  const chordsInput = h('input', { type: 'text', class: 'span-chords', placeholder: 'D F#m D A D F#m+E D D', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Acordes, uno por compás' }) as HTMLInputElement;
  const createBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => create() }, 'Crear sección') as HTMLButtonElement;
  const make = h('div.span-make', null, h('label', null, h('span', null, 'Nombre'), labelInput), h('label', null, h('span', null, 'Acordes (uno por compás)'), chordsInput), h('div.muted.small', null, 'F#m+E = dos acordes en el mismo compás, dos tiempos cada uno.'), createBtn);
  make.hidden = true;
  let current: SpanResult | null = null;
  let loadedSamples: Float32Array | null = null;
  let timer = 0;
  let raf = 0;
  let playing = false;

  barsInput.addEventListener('input', () => analyze());

  const clickBox = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const playBtn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => togglePlay() }, '▶ Oír el tramo') as HTMLButtonElement;
  const playRow = h('div.span-play', null, playBtn, h('label.grid-check', { title: 'Un clic en cada pulso (más fuerte en el primero de cada compás) para oír si las líneas caen en los golpes' }, clickBox, h('span', null, 'Con clics de compás')));

  function stopPlay(): void {
    if (playing) opts.stop();
    playing = false;
    cancelAnimationFrame(raf);
    picker.setPlayhead(null);
    playBtn.textContent = '▶ Oír el tramo';
  }

  function togglePlay(): void {
    if (playing) {
      stopPlay();
      return;
    }
    const sel = picker.getSelection();
    if (!opts.getAudio() || !sel) return;
    const clicks: Array<{ t: number; accent: boolean }> = [];
    if (clickBox.checked && current) {
      const beat = 60 / current.bpm;
      for (const b of current.barStarts) for (let k = 0; k < current.beatsPerBar; k++) clicks.push({ t: b + k * beat, accent: k === 0 });
    }
    opts.play(sel.fromSec, sel.toSec, clicks);
    playing = true;
    playBtn.textContent = '■ Parar';
    const tick = (): void => {
      if (!playing) return;
      const t = opts.getPlayingSec();
      if (t === null || t > sel.toSec + 0.05) {
        stopPlay();
        return;
      }
      picker.setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  const body = h(
    'div.span-body',
    null,
    picker.el,
    playRow,
    h('div.span-row', null, h('label.span-bars-label', null, h('span', null, 'Compases'), barsInput), h('div.span-result-slot', null, status, result)),
    make,
  );
  const dialog = h(
    'dialog.span-dialog',
    null,
    h('div.span-head', null, h('strong', null, 'Marca un tramo'), h('button.btn.btn-sm', { type: 'button', onclick: () => dialog.close(), 'aria-label': 'Cerrar' }, '✕')),
    body,
  ) as HTMLDialogElement;

  function clearNode(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function stale(): void {
    stopPlay();
    current = null;
    make.hidden = true;
    clearNode(result);
    picker.setBars([]);
  }

  /** Analyses the marked stretch (after a short pause, so dragging stays smooth) and draws its bars on the wave. */
  function analyze(): void {
    window.clearTimeout(timer);
    stale();
    const audio = opts.getAudio();
    const sel = picker.getSelection();
    if (!audio || !sel) {
      status.textContent = audio ? 'Arrastra sobre la onda para marcar el tramo.' : 'Carga primero el audio de la canción.';
      return;
    }
    if (sel.toSec - sel.fromSec < 2) {
      status.textContent = 'El tramo tiene que durar al menos 2 segundos.';
      return;
    }
    status.textContent = 'Analizando…';
    timer = window.setTimeout(() => {
      const bars = barsInput.value.trim() === '' ? undefined : Math.max(1, Math.round(Number(barsInput.value)));
      const r = analyzeSpan({ samples: audio.samples, sampleRate: audio.sampleRate, fromSec: sel.fromSec, toSec: sel.toSec, beatsPerBar: opts.getBeatsPerBar(), bars });
      if (!r.ok) {
        status.textContent = r.reason;
        return;
      }
      current = r;
      status.textContent = '';
      picker.setBars(r.barStarts);
      showResult(r, bars === undefined);
      make.hidden = false;
    }, 40);
  }

  function showResult(r: SpanResult, autoBars: boolean): void {
    clearNode(result);
    result.appendChild(h('div.span-summary', null, h('strong', null, `${String(r.bpm).replace('.', ',')} bpm`), ` · ${r.bars} compases de ${r.beatsPerBar} tiempos`));
    if (autoBars) {
      // A beat grid fits half and double speed alike: one tap switches to the other reading.
      result.appendChild(
        h('button.btn.btn-sm', { type: 'button', onclick: () => { barsInput.value = String(r.bars * 2); analyze(); } }, `¿Son ${r.bars * 2} compases? Pulsa aquí`),
      );
    }
    if (r.confidence < 0.3) result.appendChild(h('div.span-warn', null, 'Los golpes no marcan el pulso con claridad: comprueba las líneas de compás.'));
  }

  function create(): void {
    if (!current) return;
    const chords = chordsInput.value
      .replace(/\s*\+\s*/g, '+')
      .split(/[\s,|]+/)
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const out = opts.onCreate(current, labelInput.value, chords);
    if (out.error) {
      status.textContent = out.error;
      status.classList.add('is-error');
      return;
    }
    status.classList.remove('is-error');
    status.textContent = out.message;
    make.hidden = true;
    clearNode(result);
    picker.setBars([]);
    current = null;
  }

  dialog.addEventListener('close', () => {
    window.clearTimeout(timer);
    stopPlay();
  });

  return {
    el: dialog,
    open() {
      status.classList.remove('is-error');
      stale();
      const audio = opts.getAudio();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      if (!audio) {
        status.textContent = 'Carga primero el audio de la canción.';
        picker.redraw();
        return;
      }
      if (loadedSamples !== audio.samples) {
        loadedSamples = audio.samples;
        picker.setAudio(audio.samples, audio.sampleRate);
        const s = suggestSpan(audio.samples, audio.sampleRate);
        if (s) picker.setSelection(s.fromSec, s.toSec);
      } else {
        picker.redraw();
      }
      analyze();
    },
  };
}
