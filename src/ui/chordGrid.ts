/**
 * Chord grid editor: the song text as bars of cells, one cell per beat (4 in 4/4).
 *
 * A thin view over `song/grid.ts`. The text stays the single source of truth: every change
 * serialises the chart and hands the new text to `onChange`; the host calls `setSource` when
 * the text changes by any other route (typing in the text view, undo, chord detection...).
 *
 * Writing a chord only on the beat where it changes is enough: an empty cell holds the
 * previous chord ("C . . ." in the text). Select a cell, then tap a chord of the pad (chips of
 * the chords already used, the seven roots with ♭/♯ and a quality, or the text field).
 */
import type { ParseError } from '../types';
import { clear, h } from './dom';
import { createAutoSyncBox, type AutoSyncBox, type AutoSyncOpts } from './autoSyncBox';
import {
  GRID_BARS_PER_LINE,
  NC_CELL,
  REST_CELL,
  addBarAtEnd,
  appendBar,
  barNumbers,
  chartBeatsPerBar,
  chartChords,
  deleteBar,
  duplicateBar,
  headerValue,
  insertBar,
  moveBar,
  normalizeCellValue,
  parseGrid,
  serializeGrid,
  setCell,
  setHeader,
  removeSectionStart,
  sectionIndexAt,
  sectionStartOf,
  setSectionRepeat,
  startSectionAt,
  type GridChart,
  type GridHeaderKey,
  type GridItem,
} from '../song/grid';

export interface ChordGridOpts {
  /** Called with the new song text after every change made in the grid. */
  onChange: (source: string) => void;
  /** The play / pause button was pressed. */
  onTogglePlay?: () => void;
  /** The stop button was pressed (the host goes back to the start of the selected bar). */
  onStop?: () => void;
  /** The position slider moved to `sec` (song seconds). */
  onSeek?: (sec: number) => void;
  /** ⏮ / ⏪ / ⏩: jump by `deltaSec` (negative = back) from where the music is. */
  onSkip?: (deltaSec: number) => void;
  /** ⏮: back to the start of the song. */
  onRewind?: () => void;
  /** A cell was selected by the user (the host moves the playback position there). */
  onSelectCell?: (pos: { item: number; bar: number; cell: number }) => void;
  /** The loop choice changed. */
  onLoopChange?: () => void;
  /** «Añadir compás de entrada» of the banner shown when the audio starts before bar 1. */
  onLeadIn?: () => void;
  /** «No, empieza aquí» of that banner: stop offering it for this song. */
  onLeadInDismiss?: () => void;
  /** The «qué escuchar» choice changed (the host stops a playback in progress). */
  onSourceChange?: () => void;
  /** The «inicio de la canción» (where bar 1 sits in the audio) was nudged by `deltaSec`. */
  onNudgeOffset?: (deltaSec: number) => void;
  /** «Ajustar automáticamente» of the sync panel. */
  autoSync?: AutoSyncOpts;
  /** «Tramo…»: analyse a stretch of the audio and make a section of it. */
  onSpan?: () => void;
}

/** localStorage key of the visual delay of the playing mark, in ms. */
export const VISUAL_DELAY_KEY = 'gz.gridVisualMs';
export const VISUAL_DELAY_LIMIT_MS = 500;

export type PlaySource = 'chords' | 'song' | 'both';
/** What «Escuchar» repeats: nothing, the selected bar, or the section of the selected bar. */
export type LoopMode = 'off' | 'bar' | 'section';

export interface ChordGridView {
  el: HTMLElement;
  autoSync: AutoSyncBox;
  /** Where the host mounts the studio viewer (between the transport bar and the bars). */
  viewerSlot: HTMLElement;
  /** Offers (or, with null, hides) the lead-in banner: the audio sounds for `seconds` before bar 1. */
  setLeadInOffer(offer: { seconds: number; beats: number; bars: number } | null): void;
  /** Current / total position shown in the transport bar and its slider (song seconds). */
  setTime(curSec: number, totalSec: number, minSec?: number): void;
  /** True when the «cuenta atrás» option (3 s before the music) is on. */
  getCountdown(): boolean;
  getLoop(): LoopMode;
  /** The text changed (or its diagnostics did): re-read it. Cheap when it is the grid's own text. */
  setSource(source: string, issues: readonly ParseError[]): void;
  /** Marks the cell being played (null = none) without redrawing the grid. */
  setPlayhead(pos: { item: number; bar: number; cell: number } | null): void;
  /** What «Escuchar» plays: the synthesized chords, the loaded song audio, or both together. */
  getPlaySource(): PlaySource;
  /** Enables the audio options when a song track is loaded. */
  setAudioAvailable(available: boolean): void;
  /** True when the «clic de metrónomo» option is on. */
  getMetronome(): boolean;
  /** Seconds the playing mark is shown later than the audio clock says (compensates screen / Bluetooth lag). */
  getVisualDelaySec(): number;
  /** Shows the current start of the song in the audio (null without a track). */
  setOffsetInfo(offsetSec: number | null): void;
  /** Selects a cell (e.g. when coming back from the check view). */
  selectCell(pos: { item: number; bar: number; cell: number }): void;
  /** The selected cell (where playback starts), or null. */
  getSelection(): { item: number; bar: number; cell: number } | null;
  /** Switches the «Escuchar» button between play and stop. */
  setPlaying(playing: boolean): void;
  dispose(): void;
}

/** Quality chips of the pad: label shown, suffix appended to the root. */
export const PAD_QUALITIES: ReadonlyArray<{ label: string; suffix: string }> = [
  { label: 'Mayor', suffix: '' },
  { label: 'menor', suffix: 'm' },
  { label: '7', suffix: '7' },
  { label: 'm7', suffix: 'm7' },
  { label: 'maj7', suffix: 'maj7' },
  { label: 'sus4', suffix: 'sus4' },
  { label: 'sus2', suffix: 'sus2' },
  { label: 'add9', suffix: 'add9' },
  { label: 'dim', suffix: 'dim' },
  { label: '5', suffix: '5' },
];

const ROOTS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

export type AdvanceMode = 'bar' | 'beat' | 'stay';

const ADVANCE_LABELS: Record<AdvanceMode, string> = { bar: 'al siguiente compás', beat: 'al siguiente pulso', stay: 'quedarse' };

/** Chord written by the pad for a root letter, accidental ('', '#', 'b') and quality suffix. */
export function padChord(root: string, accidental: '' | '#' | 'b', suffix: string): string {
  return `${root}${accidental}${suffix}`;
}

interface Sel {
  item: number;
  bar: number;
  cell: number;
}

export function createChordGrid(opts: ChordGridOpts): ChordGridView {
  let chart: GridChart = parseGrid('');
  let lastText = '';
  let issues: readonly ParseError[] = [];
  let sel: Sel | null = null;
  let accidental: '' | '#' | 'b' = '';
  let quality = '';
  let advance: AdvanceMode = 'bar';
  let notice = '';
  let disposed = false;
  let headOpen: boolean | null = null;
  let issuesKey = '';

  let playhead: Sel | null = null;
  let lastPlayheadBar = '';
  let audioReady = false;
  const playBtn = h('button.btn.btn-sm.btn-primary.grid-play', { type: 'button', title: 'Reproducir / pausar (espacio)', onclick: () => opts.onTogglePlay?.() }, '▶ Escuchar') as HTMLButtonElement;
  const skipBtn = (label: string, title: string, onclick: () => void): HTMLButtonElement =>
    h('button.btn.btn-sm.grid-skip', { type: 'button', title, 'aria-label': title, onclick }, label) as HTMLButtonElement;
  const rewindBtn = skipBtn('⏮', 'Volver al principio de la canción', () => opts.onRewind?.());
  const backBtn = skipBtn('⏪ 5 s', 'Retroceder 5 segundos', () => opts.onSkip?.(-5));
  const forwardBtn = skipBtn('5 s ⏩', 'Adelantar 5 segundos', () => opts.onSkip?.(5));
  const stopBtn = h('button.btn.btn-sm.grid-stop', { type: 'button', title: 'Parar y volver al compás seleccionado', onclick: () => opts.onStop?.() }, '■') as HTMLButtonElement;
  const timeEl = h('span.grid-time', null, '0:00 / 0:00');
  const seekEl = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0', class: 'grid-seek', 'aria-label': 'Posición' }) as HTMLInputElement;
  seekEl.addEventListener('input', () => opts.onSeek?.(Number(seekEl.value)));
  const loopSel = h('select.grid-loop', { 'aria-label': 'Repetir' }) as HTMLSelectElement;
  for (const [value, label] of [['off', 'Sin bucle'], ['bar', 'Repetir el compás'], ['section', 'Repetir la sección']]) loopSel.appendChild(h('option', { value }, label));
  loopSel.addEventListener('change', () => opts.onLoopChange?.());
  const sourceSel = h('select', { 'aria-label': 'Qué escuchar' }) as HTMLSelectElement;
  const sourceOptions: Array<[PlaySource, string]> = [
    ['chords', 'Solo acordes'],
    ['song', 'Canción original'],
    ['both', 'Canción + acordes'],
  ];
  for (const [value, label] of sourceOptions) sourceSel.appendChild(h('option', { value }, label));
  const audioHint = h('span.muted.small.grid-audio-hint', null, 'Empieza en el compás seleccionado');
  let visualMs = 0;
  try {
    const v = Number(localStorage.getItem(VISUAL_DELAY_KEY));
    if (Number.isFinite(v)) visualMs = Math.max(-VISUAL_DELAY_LIMIT_MS, Math.min(VISUAL_DELAY_LIMIT_MS, Math.round(v)));
  } catch {
    /* storage unavailable: the delay lasts for this screen */
  }
  const metroBox = h('input', { type: 'checkbox', 'aria-label': 'Clic de metrónomo' }) as HTMLInputElement;
  let countdownOn = true;
  try {
    countdownOn = localStorage.getItem('gz.countdown') !== '0';
  } catch {
    /* default on */
  }
  const countdownBox = h('input', { type: 'checkbox', checked: countdownOn, 'aria-label': 'Cuenta atrás de 3 segundos' }) as HTMLInputElement;
  countdownBox.addEventListener('change', () => {
    try {
      localStorage.setItem('gz.countdown', countdownBox.checked ? '1' : '0');
    } catch {
      /* ignored */
    }
  });
  const countdownLabel = h('label.grid-check', { title: 'Tres segundos de cuenta atrás (clics) antes de que empiece la música' }, countdownBox, h('span', null, 'Cuenta atrás'));
  const metroLabel = h('label.grid-check', { title: 'Un clic en cada pulso para oír si la cuadrícula cae en los golpes' }, metroBox, h('span', null, 'Clic'));
  const offsetValue = h('strong.sync-value', null, '—');
  const visualValue = h('strong.sync-value', null, `${visualMs} ms`);
  const stepBtn = (label: string, title: string, fn: () => void): HTMLElement =>
    h('button.grid-mini', { type: 'button', title, onclick: fn }, label);
  const nudge = (ms: number) => (): void => opts.onNudgeOffset?.(ms / 1000);
  const nudgeVisual = (ms: number) => (): void => {
    visualMs = Math.max(-VISUAL_DELAY_LIMIT_MS, Math.min(VISUAL_DELAY_LIMIT_MS, visualMs + ms));
    visualValue.textContent = `${visualMs} ms`;
    try {
      localStorage.setItem(VISUAL_DELAY_KEY, String(visualMs));
    } catch {
      /* ignored */
    }
  };
  const autoSync = createAutoSyncBox(opts.autoSync ?? { onRun: () => {}, onApply: () => {}, onDiscard: () => {} });
  const syncBox = h(
    'details.grid-sync',
    null,
    h('summary', null, '⚙ Sincronía'),
    autoSync.el,
    h(
      'p.muted.small',
      null,
      'Activa el clic y escucha «Canción + acordes»: el clic cae justo en cada pulso de la cuadrícula. Si el clic suena ANTES que el golpe de la canción, pulsa «+» (retrasa la cuadrícula); si suena DESPUÉS, pulsa «−». Cuando clic y golpe coincidan, la cuadrícula está bien alineada con la canción.',
    ),
    h(
      'div.sync-row',
      null,
      h('span', null, 'Inicio de la canción (compás 1) '),
      offsetValue,
      stepBtn('−100', 'Adelanta la cuadrícula 100 ms', nudge(-100)),
      stepBtn('−10', 'Adelanta la cuadrícula 10 ms', nudge(-10)),
      stepBtn('+10', 'Retrasa la cuadrícula 10 ms', nudge(10)),
      stepBtn('+100', 'Retrasa la cuadrícula 100 ms', nudge(100)),
    ),
    h(
      'div.sync-row',
      null,
      h('span', null, 'Marca verde '),
      visualValue,
      stepBtn('−20', 'La marca verde se muestra antes', nudgeVisual(-20)),
      stepBtn('+20', 'La marca verde se muestra después', nudgeVisual(20)),
      h('span.muted.small', null, 'Solo mueve la marca, no el sonido: úsalo si la marca va por delante o por detrás de lo que oyes (p. ej. con auriculares Bluetooth).'),
    ),
  );
  // Landscape phone: the secondary controls (countdown, click, loop, sync) hide behind this button.
  const moreCtl = h('button.btn.btn-sm.grid-more', { type: 'button', title: 'Más controles: cuenta atrás, clic, repetir, sincronía', 'aria-label': 'Más controles', onclick: () => moreCtl.classList.toggle('is-open', transport.classList.toggle('is-expanded')) }, '⋯') as HTMLButtonElement;
  const spanBtn = h('button.btn.btn-sm.grid-span', { type: 'button', title: 'Analizar un tramo del audio (su tempo y dónde empiezan los compases) y crear una sección con él', onclick: () => opts.onSpan?.() }, 'Tramo…') as HTMLButtonElement;
  const transport = h('div.grid-transport', null, h('div.grid-transport-row', null, playBtn, stopBtn, rewindBtn, backBtn, forwardBtn, sourceSel, moreCtl, countdownLabel, metroLabel, loopSel, spanBtn), audioHint, syncBox);
  const viewerSlot = h('div.grid-viewer-slot');
  // The position bar sits right under the strip with the wave and the chords.
  const seekRow = h(
    'div.grid-seekrow',
    null,
    timeEl,
    seekEl,
    h('div.muted.small.grid-seekhint', null, 'Clic derecho sobre un golpe de la onda: «Aquí empieza el compás…»'),
  );
  const leadText = h('span', null);
  const leadBtn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => opts.onLeadIn?.() }, 'Añadir compás de entrada') as HTMLButtonElement;
  const leadSkip = h('button.btn.btn-sm', { type: 'button', title: 'El principio del audio es ruido: el compás 1 está donde está', onclick: () => opts.onLeadInDismiss?.() }, 'No, empieza aquí') as HTMLButtonElement;
  const leadBanner = h('div.grid-leadin', { role: 'status' }, leadText, leadBtn, leadSkip);
  leadBanner.hidden = true;
  viewerSlot.appendChild(leadBanner);
  sourceSel.addEventListener('change', () => opts.onSourceChange?.());
  const root = h('div.chord-grid-editor');
  const body = h('div.grid-body');
  const pad = h('div.grid-pad');
  root.append(transport, viewerSlot, seekRow, body, pad);

  // ---------------------------------------------------------------- state helpers

  /**
   * Writes the chart to the text. `redraw: false` is for edits of a text field: the field keeps
   * its DOM node (and the tap that blurred it still lands) because nothing else changed on screen.
   */
  function commit(redraw = true): void {
    const text = serializeGrid(chart);
    lastText = text;
    opts.onChange(text);
    if (redraw) render();
  }

  /** Re-reads the text after an edit the grid cannot express as a cell change (a raw line). */
  function reparse(text: string): void {
    chart = parseGrid(text);
    lastText = text;
    opts.onChange(text);
    render();
  }

  interface Pos {
    item: number;
    bar: number;
  }

  /** Every bar of the chart in reading order. */
  function allBars(): Pos[] {
    const out: Pos[] = [];
    chart.items.forEach((it, item) => {
      if (it.kind === 'bars') it.bars.forEach((_, bar) => out.push({ item, bar }));
    });
    return out;
  }

  function validSel(s: Sel | null): s is Sel {
    if (!s) return false;
    const it = chart.items[s.item];
    return !!it && it.kind === 'bars' && !!it.bars[s.bar] && s.cell >= 0 && s.cell < it.bars[s.bar].cells.length;
  }

  function select(next: Sel | null, notify = true): void {
    sel = next && validSel(next) ? next : null;
    notice = '';
    render();
    const el = body.querySelector('.grid-cell.is-selected');
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    if (notify && sel) opts.onSelectCell?.({ ...sel });
  }

  function moveCell(delta: number): void {
    if (!validSel(sel)) return;
    const bars = allBars();
    const at = bars.findIndex((b) => b.item === sel!.item && b.bar === sel!.bar);
    const cells = (chart.items[sel.item] as Extract<GridItem, { kind: 'bars' }>).bars[sel.bar].cells.length;
    let cell = sel.cell + delta;
    let barAt = at;
    if (cell >= cells) {
      barAt++;
      cell = 0;
    } else if (cell < 0) {
      barAt--;
      cell = -1;
    }
    const target = bars[barAt];
    if (!target) return;
    const tcells = (chart.items[target.item] as Extract<GridItem, { kind: 'bars' }>).bars[target.bar].cells.length;
    select({ item: target.item, bar: target.bar, cell: cell < 0 ? tcells - 1 : cell });
  }

  function moveBarSel(delta: number): void {
    if (!validSel(sel)) return;
    const bars = allBars();
    const at = bars.findIndex((b) => b.item === sel!.item && b.bar === sel!.bar);
    const target = bars[at + delta];
    if (target) select({ item: target.item, bar: target.bar, cell: sel.cell });
  }

  /** After writing a cell: move the selection as the pad's "Siguiente" asks. */
  function afterWrite(from: Sel, wasNewBar: boolean): void {
    if (advance === 'stay') return;
    if (advance === 'beat') {
      sel = from;
      moveCell(1);
      return;
    }
    const bars = allBars();
    const at = bars.findIndex((b) => b.item === from.item && b.bar === from.bar);
    const next = bars[at + 1];
    if (next) {
      sel = { item: next.item, bar: next.bar, cell: 0 };
      return;
    }
    // Past the last bar: only a bar that was still empty means "keep writing"; correcting a chord must not grow the song.
    if (!wasNewBar) return;
    const added = appendBar(chart, from.item);
    if (added) sel = { item: added.item, bar: added.bar, cell: 0 };
  }

  /** Writes `value` into the selected cell ('' holds). Returns false (with a notice) when not allowed. */
  function write(value: string): boolean {
    if (!validSel(sel)) {
      notice = 'Toca primero una casilla de la cuadrícula';
      renderPad();
      return false;
    }
    const v = normalizeCellValue(value);
    if (v === null) {
      notice = `«${value}» no es un acorde válido`;
      renderPad();
      return false;
    }
    const from = { ...sel };
    const barNow = (chart.items[from.item] as Extract<GridItem, { kind: 'bars' }>).bars[from.bar];
    const wasNewBar = barNow.cells.every((c) => c === '');
    setCell(chart, from.item, from.bar, from.cell, v);
    notice = '';
    afterWrite(from, wasNewBar);
    commit();
    return true;
  }

  // ---------------------------------------------------------------- rendering: grid

  function cellButton(item: number, bar: number, cell: number, value: string): HTMLElement {
    const selected = !!sel && sel.item === item && sel.bar === bar && sel.cell === cell;
    const kind = value === '' ? 'is-hold' : value === REST_CELL ? 'is-rest' : value === NC_CELL ? 'is-nc' : 'is-chord';
    const label = value === '' ? '·' : value === REST_CELL ? '–' : value;
    return h(
      'button.grid-cell',
      {
        type: 'button',
        class: `${kind}${selected ? ' is-selected' : ''}${label.length > 4 ? ' is-long' : ''}${playhead && playhead.item === item && playhead.bar === bar && playhead.cell === cell ? ' is-playing' : ''}`,
        dataset: { i: String(item), b: String(bar), c: String(cell) },
        'aria-label': `Pulso ${cell + 1}: ${value === '' ? 'sigue el acorde anterior' : value === REST_CELL ? 'silencio' : value}`,
        'aria-pressed': selected ? 'true' : 'false',
        onclick: () => select({ item, bar, cell }),
      },
      h('span.grid-beat', null, String(cell + 1)),
      h('span.grid-chord', null, label),
    );
  }

  function stepper(value: number, label: string, onSet: (n: number) => void): HTMLElement {
    return h(
      'span.grid-stepper',
      { title: label },
      h('button.grid-mini', { type: 'button', 'aria-label': `${label}: menos`, disabled: value <= 1, onclick: () => onSet(value - 1) }, '−'),
      h('span.grid-stepper-value', null, `×${value}`),
      h('button.grid-mini', { type: 'button', 'aria-label': `${label}: más`, disabled: value >= 32, onclick: () => onSet(value + 1) }, '+'),
    );
  }

  function issueFor(line: number): HTMLElement | null {
    const found = issues.filter((i) => i.line === line);
    if (found.length === 0) return null;
    const worst = found.some((i) => i.severity === 'error') ? 'error' : 'warning';
    return h('div.grid-issue', { class: worst }, found.map((i) => i.message).join(' · '));
  }

  function textField(value: string, label: string, onSet: (v: string) => void, extra: Record<string, unknown> = {}): HTMLInputElement {
    const input = h('input', {
      type: 'text',
      value,
      'aria-label': label,
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
      ...extra,
    }) as HTMLInputElement;
    input.addEventListener('change', () => onSet(input.value));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
    });
    return input;
  }

  function renderHeaderCard(): HTMLElement {
    const field = (key: GridHeaderKey, label: string, kind: 'text' | 'number' = 'text'): HTMLElement => {
      const input = textField(headerValue(chart, key), label, (v) => {
        setHeader(chart, key, v);
        commit(false);
      }, kind === 'number' ? { inputMode: 'numeric', class: 'is-narrow' } : {});
      return h('label.grid-field', null, h('span', null, label), input);
    };
    const time = h('select', { 'aria-label': 'Compás' }) as HTMLSelectElement;
    for (const t of ['4/4', '3/4', '2/4', '6/8']) time.appendChild(h('option', { value: t, selected: headerValue(chart, 'time') === t || (headerValue(chart, 'time') === '' && t === '4/4') }, t));
    time.addEventListener('change', () => {
      setHeader(chart, 'time', time.value);
      sel = null;
      commit();
    });
    return h(
      'details.grid-head',
      { open: headOpen ?? chart.items.every((i) => i.kind !== 'bars'), ontoggle: (ev: Event) => { headOpen = (ev.target as HTMLDetailsElement).open; } },
      h('summary', null, 'Datos de la canción'),
      h('div.grid-head-fields', null, field('title', 'Título'), field('artist', 'Artista'), field('tempo', 'Tempo', 'number'), h('label.grid-field', null, h('span', null, 'Compás'), time), field('capo', 'Cejilla', 'number')),
    );
  }

  function renderRaw(item: number, it: Extract<GridItem, { kind: 'raw' }>): HTMLElement {
    return h(
      'div.grid-raw',
      null,
      h('span.grid-raw-tag', null, 'Línea de texto'),
      textField(it.text, 'Línea de texto', (v) => {
        chart.items[item] = { kind: 'raw', text: v };
        reparse(serializeGrid(chart));
      }, { class: 'grid-raw-input' }),
      issueFor(item + 1) ?? h('div.grid-issue.warning', null, 'No se muestra como cuadrícula; edítala aquí o en la vista Texto'),
    );
  }

  /** Tempo / strum / meter changes written between the bars, shown as small badges on the bar they apply to. */
  function badgeFor(it: Extract<GridItem, { kind: 'header' }>): string {
    if (it.key === 'tempo') return `♩${it.value}`;
    if (it.key === 'strum') return `↕ ${it.value}`;
    if (it.key === 'time') return it.value;
    return '';
  }

  /** The song as ONE continuous run of bars: sections are markers on the bar where they start, not breaks. */
  function renderFlow(): HTMLElement {
    const flow = h('div.grid-flow', { style: `--cells:${chartBeatsPerBar(chart)}` });
    const numbers = barNumbers(chart);
    const first = firstContentIndex();
    let sectionNo = -1;
    let sectionLabel = '';
    let sectionRepeat = 1;
    let startPending: number | null = null;
    let badges: string[] = [];
    chart.items.forEach((it, item) => {
      if (item < first) return;
      if (it.kind === 'section') {
        // A header with no bars under it recalls an earlier section: shown as a small note in the run.
        const next = chart.items.slice(item + 1).find((o) => o.kind === 'section' || o.kind === 'bars' || o.kind === 'raw');
        if (!next || next.kind === 'section') {
          flow.appendChild(h('div.grid-recall', { title: 'Vuelve a insertar esta sección (se edita en la vista Texto)' }, `↻ ${it.label}${it.repeat > 1 ? ` ×${it.repeat}` : ''}`));
          return;
        }
        sectionNo++;
        sectionLabel = it.label;
        sectionRepeat = it.repeat;
        startPending = item;
        return;
      }
      if (it.kind === 'header') {
        const badge = badgeFor(it);
        if (badge !== '') badges.push(badge);
        return;
      }
      if (it.kind === 'raw') {
        flow.appendChild(renderRaw(item, it));
        return;
      }
      if (it.kind !== 'bars') return;
      const problems = issues.filter((i) => i.line === item + 1);
      it.bars.forEach((bar, b) => {
        const selectedBar = !!sel && sel.item === item && sel.bar === b;
        const starts = b === 0 && startPending !== null;
        const number = numbers[item] + b;
        const tags: HTMLElement[] = [];
        if (starts) tags.push(h('span.grid-sec-tag', { title: 'Inicio de sección: selecciona este compás y usa «Sección» a la derecha para cambiarla' }, `${sectionLabel}${sectionRepeat > 1 ? ` ×${sectionRepeat}` : ''}`));
        if (b === 0) for (const t of badges) tags.push(h('span.grid-badge', null, t));
        if (b === it.bars.length - 1 && it.repeat > 1) tags.push(h('span.grid-badge', { title: 'Esta línea se repite' }, `×${it.repeat}`));
        const cls = ['grid-bar', sectionNo >= 0 ? `sec-${sectionNo % 6}` : 'sec-none'];
        if (selectedBar) cls.push('is-selected');
        if (starts) cls.push('is-start');
        if (problems.length > 0) cls.push('has-issue');
        flow.appendChild(
          h(
            'div',
            {
              class: cls.join(' '),
              role: 'group',
              'aria-label': `Compás ${number}${starts ? `, empieza ${sectionLabel}` : ''}`,
              style: `--cells:${it.beats}`,
              title: problems.map((i) => i.message).join(' · '),
            },
            h('div.grid-bar-top', null, h('span.grid-bar-num', null, String(number)), ...tags),
            h('div.grid-cells', null, bar.cells.map((value, c) => cellButton(item, b, c, value))),
          ),
        );
        if (b === 0) badges = [];
        if (starts) startPending = null;
      });
    });
    flow.appendChild(h('button.grid-add-bar', { type: 'button', title: 'Añadir un compás al final', onclick: addLine }, '+ compás'));
    return flow;
  }

  function render(): void {
    if (disposed) return;
    const active = document.activeElement as HTMLElement | null;
    const hadFocus = !!active && root.contains(active);
    const refocusPad = hadFocus && active.classList.contains('pad-input');
    const refocusCell = hadFocus && active.classList.contains('grid-cell');
    const scroll = body.scrollTop;
    clear(body);
    body.appendChild(renderHeaderCard());
    // Problems that are not on a bar (headers, comments...) are listed once; those on a bar mark the bar itself.
    const hidden = issues.filter((i) => {
      const it = chart.items[i.line - 1];
      return !it || it.kind !== 'bars';
    });
    if (hidden.length > 0) body.appendChild(h('div.grid-issue.error', null, hidden.map((i) => `Línea ${i.line}: ${i.message}`).join(' · ')));
    const hasBars = chart.items.some((it) => it.kind === 'bars');
    if (!hasBars) body.appendChild(h('p.muted.grid-empty', null, 'Aún no hay compases. Pulsa «+ compás» para empezar y toca una casilla para ponerle un acorde.'));
    body.appendChild(renderFlow());
    renderPad();
    body.scrollTop = scroll;
    if (refocusPad) pad.querySelector<HTMLInputElement>('.pad-input')?.focus();
    else if (refocusCell) body.querySelector<HTMLElement>('.grid-cell.is-selected')?.focus({ preventScroll: true });
  }

  /** Index of the first item that is not a leading header, blank or comment. */
  function firstContentIndex(): number {
    const at = chart.items.findIndex((it) => it.kind !== 'header' && it.kind !== 'blank' && it.kind !== 'comment');
    return at < 0 ? chart.items.length : at;
  }

  function addLine(): void {
    const at = addBarAtEnd(chart);
    if (!at) {
      notice = 'La última sección repite otra anterior: añade antes una sección nueva';
      renderPad();
      return;
    }
    sel = { item: at.item, bar: at.bar, cell: 0 };
    commit();
    const el = body.querySelector('.grid-cell.is-selected');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- rendering: pad

  function chordButton(name: string, extra = ''): HTMLElement {
    return h('button.pad-btn', { type: 'button', class: extra, onclick: () => write(name) }, name);
  }

  function barAction(label: string, title: string, fn: (s: Sel) => void, disabled = false): HTMLElement {
    return h(
      'button.pad-btn.pad-action',
      {
        type: 'button',
        title,
        disabled: disabled || !validSel(sel),
        onclick: () => {
          if (validSel(sel)) fn(sel);
        },
      },
      label,
    );
  }

  const SECTION_NAMES = ['Intro', 'Estrofa', 'Estribillo', 'Puente', 'Final'];

  /** «Sección» row of the dock: mark / rename / remove the start of a section at the selected bar. */
  function renderSectionRow(selected: Sel | null): HTMLElement {
    if (!selected) return h('div.pad-section.is-idle', null, h('span.muted.small', null, 'Toca un compás para marcar dónde empieza una sección'));
    const startItem = selected.bar === 0 ? sectionStartOf(chart, selected.item) : -1;
    const governing = sectionIndexAt(chart, selected.item);
    const current = startItem >= 0 ? (chart.items[startItem] as Extract<GridItem, { kind: 'section' }>) : null;
    const used = chart.items.filter((i) => i.kind === 'section').length;
    const suggested = SECTION_NAMES[used % SECTION_NAMES.length];
    const input = h('input', {
      type: 'text',
      class: 'pad-section-name',
      value: current ? current.label : '',
      placeholder: current ? 'Nombre de la sección' : suggested,
      'aria-label': 'Nombre de la sección',
      autocomplete: 'off',
      spellcheck: false,
    }) as HTMLInputElement;
    const apply = (): void => {
      const name = input.value.trim() || (current ? current.label : suggested);
      if (!startSectionAt(chart, selected.item, selected.bar, name)) {
        notice = 'No se puede aquí: esa línea o su sección se repite (×n) o se reutiliza más abajo';
        renderPad();
        return;
      }
      commit();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        apply();
      }
    });
    const where = governing >= 0 ? (chart.items[governing] as Extract<GridItem, { kind: 'section' }>).label : 'sin sección';
    const row = h('div.pad-section', null, h('span.pad-section-label', null, current ? 'Empieza la sección' : `Sección: ${where}`), input);
    if (current) {
      row.append(
        h('button.pad-btn.pad-action', { type: 'button', title: 'Cambia el nombre', onclick: apply }, 'Renombrar'),
        h(
          'button.pad-btn.pad-action',
          {
            type: 'button',
            title: 'Quita el inicio: estos compases se unen a la sección anterior',
            onclick: () => {
              if (!removeSectionStart(chart, startItem)) {
                notice = 'No se puede quitar: la sección se repite (×n) o su nombre se usa en otro sitio';
                renderPad();
                return;
              }
              commit();
            },
          },
          'Quitar inicio',
        ),
      );
      row.append(
        stepper(current.repeat, 'Repetir la sección', (n) => {
          setSectionRepeat(chart, startItem, n);
          commit();
        }),
      );
    } else {
      row.append(h('button.pad-btn.pad-action', { type: 'button', title: 'Esta sección empieza en el compás seleccionado', onclick: apply }, 'Empezar aquí'));
    }
    return row;
  }

  const padOpen = new Set<string>();
  function renderPad(): void {
    clear(pad);
    const selected = validSel(sel) ? sel : null;
    const bars = selected ? allBars() : [];
    const barNo = selected ? (barNumbers(chart)[selected.item] ?? 1) + selected.bar : 0;
    const used = chartChords(chart);

    const advanceSel = h('select', { 'aria-label': 'Después de escribir un acorde' }) as HTMLSelectElement;
    (Object.keys(ADVANCE_LABELS) as AdvanceMode[]).forEach((k) => advanceSel.appendChild(h('option', { value: k, selected: k === advance }, ADVANCE_LABELS[k])));
    advanceSel.addEventListener('change', () => {
      advance = advanceSel.value as AdvanceMode;
    });

    // Nothing to say until a cell is chosen: the idle hint only took room.
    const info = h('div.pad-info', { hidden: !selected }, h('span.pad-where', null, selected ? `Compás ${barNo} · pulso ${selected.cell + 1}` : ''));

    const sectionRow = renderSectionRow(selected);
    const usedRow = h('div.pad-row.pad-scroll', { 'aria-label': 'Acordes de la canción' }, used.length === 0 ? h('span.muted.small', null, 'Aquí saldrán los acordes que uses') : used.map((n) => chordButton(n, 'is-used')));

    const rootsRow = h('div.pad-row.pad-roots', null);
    for (const r of ROOTS) rootsRow.appendChild(chordButton(padChord(r, accidental, quality)));
    const acc = (value: '#' | 'b', label: string): HTMLElement =>
      h(
        'button.pad-btn.pad-toggle',
        {
          type: 'button',
          'aria-pressed': accidental === value ? 'true' : 'false',
          class: accidental === value ? 'is-on' : '',
          title: value === '#' ? 'Sostenido' : 'Bemol',
          onclick: () => {
            accidental = accidental === value ? '' : value;
            renderPad();
          },
        },
        label,
      );
    rootsRow.append(acc('b', '♭'), acc('#', '♯'));

    const qualityRow = h('div.pad-row.pad-scroll', { 'aria-label': 'Tipo de acorde' });
    for (const q of PAD_QUALITIES) {
      qualityRow.appendChild(
        h(
          'button.pad-btn.pad-quality',
          {
            type: 'button',
            'aria-pressed': quality === q.suffix ? 'true' : 'false',
            class: quality === q.suffix ? 'is-on' : '',
            onclick: () => {
              quality = q.suffix;
              renderPad();
            },
          },
          q.label,
        ),
      );
    }

    const typed = h('input', {
      type: 'text',
      class: 'pad-input',
      placeholder: 'Otro acorde (Dm7, G/B…)',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
      'aria-label': 'Escribir un acorde',
    }) as HTMLInputElement;
    const submitTyped = (): void => {
      if (typed.value.trim() === '') return;
      if (write(typed.value)) typed.value = '';
    };
    typed.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitTyped();
      }
    });

    const symbols = h(
      'div.pad-row',
      null,
      h('button.pad-btn.pad-action', { type: 'button', title: 'Esta casilla sigue con el acorde anterior', onclick: () => write('') }, '· Mantener'),
      h('button.pad-btn.pad-action', { type: 'button', title: 'Silencio', onclick: () => write(REST_CELL) }, '– Silencio'),
      h('button.pad-btn.pad-action', { type: 'button', title: 'Sin acorde', onclick: () => write(NC_CELL) }, 'N.C.'),
    );
    const typedRow = h('div.pad-row', null, typed, h('button.pad-btn.pad-action', { type: 'button', onclick: submitTyped }, 'OK'));

    const barRow = h(
      'div.pad-row.pad-scroll',
      { 'aria-label': 'Acciones del compás' },
      barAction('Duplicar', 'Copia este compás justo después', (s) => {
        duplicateBar(chart, s.item, s.bar);
        sel = { ...s, bar: s.bar + 1 };
        commit();
      }),
      barAction('Insertar', 'Compás vacío después de este', (s) => {
        insertBar(chart, s.item, s.bar);
        sel = { ...s, bar: s.bar + 1, cell: 0 };
        commit();
      }),
      barAction('◀', 'Mover el compás a la izquierda', (s) => {
        const to = moveBar(chart, s.item, s.bar, -1);
        sel = { ...s, bar: to };
        commit();
      }, !!selected && selected.bar === 0),
      barAction('▶', 'Mover el compás a la derecha', (s) => {
        const to = moveBar(chart, s.item, s.bar, 1);
        sel = { ...s, bar: to };
        commit();
      }, !!selected && selected.bar >= ((chart.items[selected.item] as Extract<GridItem, { kind: 'bars' }>)?.bars.length ?? 1) - 1),
      barAction('Eliminar', 'Borra este compás', (s) => {
        const wholeLine = deleteBar(chart, s.item, s.bar);
        const left = allBars();
        const near = left.find((b) => b.item >= s.item && (wholeLine || b.item > s.item || b.bar >= s.bar)) ?? left[left.length - 1];
        sel = near ? { item: near.item, bar: near.bar, cell: 0 } : null;
        commit();
      }),
    );
    if (bars.length === 0 && !selected) barRow.classList.add('is-idle');

    // What is needed on every edit stays in view (chords, roots, hold/rest); the rest folds away, and stays as left.
    const fold = (key: string, title: string, ...kids: Array<HTMLElement | null>): HTMLElement => {
      const d = h('details.pad-fold', { open: padOpen.has(key) }, h('summary', null, title), ...kids) as HTMLDetailsElement;
      d.addEventListener('toggle', () => {
        if (d.open) padOpen.add(key);
        else padOpen.delete(key);
      });
      return d;
    };
    pad.append(
      info,
      usedRow,
      rootsRow,
      symbols,
      fold('quality', 'Tipo de acorde (m, 7, maj7…)', qualityRow),
      fold('typed', 'Escribir otro acorde', typedRow),
      fold('advance', 'Después de escribir un acorde', h('label.pad-advance', null, advanceSel)),
      fold('bar', 'Compás: duplicar, mover, borrar', barRow),
      fold('section', 'Sección', sectionRow),
    );
    if (notice !== '') pad.appendChild(h('div.pad-notice', { role: 'status' }, notice));
  }

  // ---------------------------------------------------------------- keyboard

  function onKeyDown(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (root.hidden || !root.isConnected || !validSel(sel)) return;
    switch (ev.key) {
      case 'ArrowRight':
        moveCell(1);
        break;
      case 'ArrowLeft':
        moveCell(-1);
        break;
      case 'ArrowDown':
        moveBarSel(1);
        break;
      case 'ArrowUp':
        moveBarSel(-1);
        break;
      case 'Delete':
      case 'Backspace':
      case '.':
        write('');
        break;
      case '-':
        write(REST_CELL);
        break;
      case 'Enter': {
        const input = pad.querySelector<HTMLInputElement>('.pad-input');
        if (input) input.focus();
        break;
      }
      default: {
        const letter = ev.key.length === 1 ? ev.key.toUpperCase() : '';
        if (letter >= 'A' && letter <= 'G' && letter.length === 1) {
          write(padChord(letter, accidental, quality));
          break;
        }
        return;
      }
    }
    ev.preventDefault();
  }
  // On the document: after a tap the focused node may be gone, and the shortcuts must still work.
  document.addEventListener('keydown', onKeyDown);

  render();

  return {
    el: root,
    autoSync,
    setSource(source, nextIssues) {
      const key = nextIssues.map((i) => `${i.line}:${i.severity}:${i.message}`).join('|');
      const textChanged = source !== lastText;
      if (!textChanged && key === issuesKey) return;
      issues = nextIssues;
      issuesKey = key;
      if (textChanged) {
        chart = parseGrid(source);
        lastText = source;
        if (!validSel(sel)) sel = null;
      }
      render();
    },
    setPlayhead(pos) {
      const old = body.querySelector('.grid-cell.is-playing');
      if (old) old.classList.remove('is-playing');
      playhead = pos ? { ...pos } : null;
      if (!pos) {
        lastPlayheadBar = '';
        return;
      }
      const el = body.querySelector<HTMLElement>(`.grid-cell[data-i="${pos.item}"][data-b="${pos.bar}"][data-c="${pos.cell}"]`);
      if (!el) return;
      el.classList.add('is-playing');
      const barKey = `${pos.item}:${pos.bar}`;
      if (barKey !== lastPlayheadBar) {
        lastPlayheadBar = barKey;
        // Keep the playing bar in the middle band of the list (scroll the list itself, never the page).
        const row = el.closest('.grid-bar') as HTMLElement | null;
        if (row && body.scrollHeight > body.clientHeight) {
          const top = row.offsetTop - body.offsetTop;
          const rel = top - body.scrollTop;
          if (rel < body.clientHeight * 0.15 || rel > body.clientHeight * 0.65) body.scrollTo({ top: Math.max(0, top - body.clientHeight * 0.35), behavior: 'smooth' });
        }
      }
    },
    getMetronome() {
      return metroBox.checked;
    },
    getVisualDelaySec() {
      return visualMs / 1000;
    },
    setOffsetInfo(offsetSec) {
      offsetValue.textContent = offsetSec === null ? '—' : `${offsetSec.toFixed(3)} s`;
    },
    getPlaySource() {
      return sourceSel.value as PlaySource;
    },
    setAudioAvailable(available) {
      const wasAvailable = audioReady;
      audioReady = available;
      for (const o of Array.from(sourceSel.options)) if (o.value !== 'chords') o.disabled = !available;
      spanBtn.disabled = !available;
      if (available && !wasAvailable) sourceSel.value = 'both'; // a track was just loaded: compare it with the chords
      if (!available && sourceSel.value !== 'chords') sourceSel.value = 'chords';
      audioHint.textContent = available
        ? 'Empieza en el compás seleccionado'
        : 'Carga un audio en «Pista de audio» (abajo) para compararlo con los acordes';
    },
    selectCell(pos) {
      select(pos);
    },
    getSelection() {
      return validSel(sel) ? { ...sel } : null;
    },
    setPlaying(playing) {
      playBtn.textContent = playing ? '⏸ Pausa' : '▶ Escuchar';
      playBtn.classList.toggle('is-playing', playing);
    },
    viewerSlot,
    setLeadInOffer(offer) {
      leadBanner.hidden = offer === null;
      if (!offer) return;
      leadText.textContent = `El audio suena ${offer.seconds.toFixed(1)} s antes del compás 1 (unos ${offer.beats} pulsos): falta el inicio.`;
      leadBtn.textContent = `Añadir ${offer.bars} compás${offer.bars === 1 ? '' : 'es'} de entrada`;
    },
    setTime(curSec, totalSec, minSec = 0) {
      const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      // Shown from the start of the slider (the start of the song / audio) to its end.
      timeEl.textContent = `${fmt(Math.max(0, curSec - minSec))} / ${fmt(Math.max(0, totalSec - minSec))}`;
      const max = String(Math.round(Math.max(minSec + 1, totalSec) * 20) / 20);
      const min = String(Math.round(minSec * 20) / 20);
      if (seekEl.max !== max) seekEl.max = max;
      if (seekEl.min !== min) seekEl.min = min;
      if (document.activeElement !== seekEl) seekEl.value = String(Math.max(minSec, Math.min(totalSec, curSec)));
    },
    getCountdown() {
      return countdownBox.checked;
    },
    getLoop() {
      return loopSel.value as LoopMode;
    },
    dispose() {
      disposed = true;
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}

/** Bars per text line the grid fills before it starts a new line (re-exported for the help text). */
export const BARS_PER_LINE = GRID_BARS_PER_LINE;
