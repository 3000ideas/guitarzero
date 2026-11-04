/**
 * «Analizar un tramo»: a small modal where the user marks a stretch of the recording (an intro, a verse…),
 * sees its tempo and where its bars start, and turns it into a section of the song. Nothing of it lives on
 * the editor screen: the button that opens it is one of the transport's extra controls.
 */
import { analyzeSpan, suggestSpan, type SpanResult } from '../dsp/spanAnalysis';
import { h } from './dom';

export interface SpanAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SpanDialogOpts {
  /** The loaded track (decoded), or null. */
  getAudio(): SpanAudio | null;
  /** Audio seconds of the playhead (where the music is, or where it was paused), or null. */
  getPlayheadAudioSec(): number | null;
  /** Beats per bar of the song. */
  getBeatsPerBar(): number;
  /** Writes the section. Returns an error text (Spanish) or null when it worked, plus what to tell the user. */
  onCreate(result: SpanResult, label: string, chords: string[]): { error: string | null; message: string };
}

export interface SpanDialog {
  el: HTMLDialogElement;
  open(): void;
}

/** «0:14.2» / «14.2» / «1:02» → seconds, or null. */
export function parseTime(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const v = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  return Number.isFinite(v) ? v : null;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function createSpanDialog(opts: SpanDialogOpts): SpanDialog {
  const fromInput = h('input', { type: 'text', class: 'span-time', inputMode: 'decimal', autocomplete: 'off', 'aria-label': 'Desde' }) as HTMLInputElement;
  const toInput = h('input', { type: 'text', class: 'span-time', inputMode: 'decimal', autocomplete: 'off', 'aria-label': 'Hasta' }) as HTMLInputElement;
  const barsInput = h('input', { type: 'number', class: 'span-bars', min: '1', max: '64', step: '1', placeholder: 'auto', 'aria-label': 'Número de compases' }) as HTMLInputElement;
  const status = h('div.span-status', { role: 'status' });
  const result = h('div.span-result');
  const labelInput = h('input', { type: 'text', class: 'span-label', value: 'Intro', autocomplete: 'off', 'aria-label': 'Nombre de la sección' }) as HTMLInputElement;
  const chordsInput = h('input', { type: 'text', class: 'span-chords', placeholder: 'D F#m D A D F#m+E D D', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Acordes, uno por compás' }) as HTMLInputElement;
  const createBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => create() }, 'Crear sección') as HTMLButtonElement;
  const make = h('div.span-make', null, h('label', null, h('span', null, 'Nombre'), labelInput), h('label', null, h('span', null, 'Acordes (uno por compás)'), chordsInput), h('div.muted.small', null, 'F#m+E = dos acordes en el mismo compás, dos tiempos cada uno.'), createBtn);
  make.hidden = true;
  let current: SpanResult | null = null;
  const analyzeBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => analyze() }, 'Analizar') as HTMLButtonElement;
  // A change of the marks makes the last result stale: it must not be turned into a section.
  const stale = (): void => {
    current = null;
    make.hidden = true;
    clearNode(result);
  };
  for (const input of [fromInput, toInput, barsInput]) input.addEventListener('input', stale);

  const playheadBtn = (target: HTMLInputElement): HTMLButtonElement =>
    h(
      'button.btn.btn-sm',
      {
        type: 'button',
        title: 'Poner la posición actual de la música',
        onclick: () => {
          const sec = opts.getPlayheadAudioSec();
          if (sec === null) {
            status.textContent = 'Reproduce o pausa la música donde quieras y pulsa de nuevo.';
            return;
          }
          target.value = formatTime(sec);
          status.textContent = '';
        },
      },
      'Aquí',
    ) as HTMLButtonElement;

  const body = h(
    'div.span-body',
    null,
    h('p.muted.small', null, 'Marca dónde empieza el primer compás y dónde acaba el tramo. Pon la música donde quieras y pulsa «Aquí», o escribe el tiempo.'),
    h('div.span-row', null, h('label', null, h('span', null, 'Desde'), fromInput), playheadBtn(fromInput)),
    h('div.span-row', null, h('label', null, h('span', null, 'Hasta'), toInput), playheadBtn(toInput)),
    h('div.span-row', null, h('label', null, h('span', null, '¿Cuántos compases son?'), barsInput), h('span.muted.small', null, 'Si lo sabes, ponlo: así acierta el tempo.')),
    analyzeBtn,
    status,
    result,
    make,
  );
  const dialog = h(
    'dialog.span-dialog',
    null,
    h('div.span-head', null, h('strong', null, 'Analizar un tramo'), h('button.btn.btn-sm', { type: 'button', onclick: () => dialog.close(), 'aria-label': 'Cerrar' }, '✕')),
    body,
  ) as HTMLDialogElement;

  function analyze(): void {
    current = null;
    make.hidden = true;
    clearNode(result);
    const audio = opts.getAudio();
    if (!audio) {
      status.textContent = 'Carga primero el audio de la canción.';
      return;
    }
    const from = parseTime(fromInput.value);
    const to = parseTime(toInput.value);
    if (from === null || to === null) {
      status.textContent = 'Escribe «desde» y «hasta» como 0:14.5 o 14.5.';
      return;
    }
    if (to - from < 2) {
      status.textContent = 'El tramo tiene que durar al menos 2 segundos.';
      return;
    }
    const bars = barsInput.value.trim() === '' ? undefined : Math.max(1, Math.round(Number(barsInput.value)));
    status.textContent = 'Analizando…';
    analyzeBtn.disabled = true;
    // After a tick so «Analizando…» paints before the (synchronous) analysis.
    window.setTimeout(() => {
      const beats = opts.getBeatsPerBar();
      const r = analyzeSpan({ samples: audio.samples, sampleRate: audio.sampleRate, fromSec: from, toSec: to, beatsPerBar: beats, bars });
      analyzeBtn.disabled = false;
      if (!r.ok) {
        status.textContent = r.reason;
        return;
      }
      current = r;
      status.textContent = '';
      showResult(r, bars === undefined);
      make.hidden = false;
    }, 30);
  }

  function showResult(r: SpanResult, autoBars: boolean): void {
    clearNode(result);
    result.appendChild(h('div.span-summary', null, h('strong', null, `${String(r.bpm).replace('.', ',')} bpm`), ` · ${r.bars} compases de ${r.beatsPerBar} tiempos · cada compás dura ${((60 / r.bpm) * r.beatsPerBar).toFixed(2).replace('.', ',')} s`));
    const chips = h('div.span-chips');
    r.barStarts.forEach((t, i) => chips.appendChild(h('span.span-chip', null, h('b', null, String(i + 1)), ` ${formatTime(t)}`)));
    result.appendChild(chips);
    if (autoBars) result.appendChild(h('div.muted.small', null, `Si en realidad son más compases (por ejemplo ${r.bars * 2}), escríbelo arriba y vuelve a analizar.`));
    if (r.confidence < 0.3) result.appendChild(h('div.span-warn', null, 'Los golpes no marcan el pulso con claridad: comprueba el resultado antes de usarlo.'));
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
    current = null;
  }

  function clearNode(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  return {
    el: dialog,
    open() {
      status.textContent = '';
      status.classList.remove('is-error');
      make.hidden = true;
      clearNode(result);
      current = null;
      const audio = opts.getAudio();
      if (audio && fromInput.value === '' && toInput.value === '') {
        const s = suggestSpan(audio.samples, audio.sampleRate);
        if (s) {
          fromInput.value = formatTime(s.fromSec);
          toInput.value = formatTime(s.toSec);
        }
      }
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    },
  };
}
