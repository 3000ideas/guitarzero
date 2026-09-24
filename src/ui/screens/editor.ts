/**
 * Editor screen (`#/edit/:id`, SPEC.md section 8 + section 11 "Pista de audio").
 *
 * A big monospace textarea plus a side panel with: errors and warnings (line + message,
 * click moves the caret to that line), the chords used with mini diagrams (yellow
 * "sin digitación" when getChordShape is null), bar count and expanded duration, and the
 * buttons Probar (flush + `#/play/:id`), Guardar (flush + "Guardado" feedback) and Volver.
 * Autosave: saveSong debounced 500 ms, flushed on unmount. A collapsible <details> "Formato"
 * summarises the song grammar. `#/edit/ex:*` (read-only examples) redirects to the library.
 *
 * Under the textarea, the "Pista de audio" panel attaches a backing track to the song: the
 * file goes to IndexedDB (song/audioStore.ts), its metadata (`StoredSong.audio`) to the song.
 * A WaveformView shows the audio with the beat grid of the current text; the start of bar 1
 * (`offsetSec`) is adjusted by dragging the marker, with the numeric field and step buttons,
 * "Marcar inicio" or "Detectar tempo e inicio" (dsp/tempoEstimate.ts, whose "Aplicar tempo"
 * rewrites the `tempo:` header). A test listen plays the track with metronome clicks on the
 * grid. Offset and gain changes are saved with a 300 ms debounce.
 *
 * `analyzeSource`, `lineRange`, `lineOfOffset`, `rewriteTempoHeader`, `formatTempoEstimate`,
 * `previewClickTimes` and the help data are pure (testable in Node).
 */
import './editor.css';
import type { AudioTrackInfo, ChordShape, ParseError, Screen, Song, StoredSong, TempoEstimate } from '../../types';
import { clear, fmtSeconds, h } from '../dom';
import { drawChordDiagram } from '../chordDiagram';
import { WaveformView } from '../waveform';
import { getChordShape } from '../../music/chords';
import { parseSong } from '../../song/parser';
import { songDurationSec } from '../../song/tempo';
import { isExampleId } from '../../song/examples';
import { getSong, saveSong } from '../../song/storage';
import { deleteTrack, getTrack, hasIndexedDb, putTrack } from '../../song/audioStore';
import { getAudioContext } from '../../audio/context';
import { BackingTrack } from '../../audio/backing';
import { Metronome } from '../../audio/metronome';
import { estimateTempo } from '../../dsp/tempoEstimate';

// ---------------------------------------------------------------- constants

/** Debounce of the autosave after the last keystroke. */
export const AUTOSAVE_DELAY_MS = 500;
/** Debounce of the save after an offset / gain change of the backing track. */
export const AUDIO_SAVE_DELAY_MS = 300;
/** How long the "Guardado" feedback stays highlighted after pressing Guardar. */
export const SAVED_FLASH_MS = 1500;
/** CSS size of a mini chord diagram in the side panel. */
export const MINI_DIAGRAM_W = 96;
export const MINI_DIAGRAM_H = 112;
/** Linear gain of a freshly loaded backing track. */
export const DEFAULT_TRACK_GAIN = 0.8;
/** Bars with metronome clicks in "Escuchar con metrónomo" (after the one-bar lead-in). */
export const PREVIEW_BARS = 8;
/** Seconds between the click and the start of a test listen. */
export const PREVIEW_LEAD_SEC = 0.1;
/** Fine offset steps of the sync row, in seconds. */
export const OFFSET_STEPS_SEC: readonly number[] = [-0.1, -0.01, 0.01, 0.1];

// ---------------------------------------------------------------- pure helpers

export interface ChordEntry {
  /** Chord name as written by the user. */
  name: string;
  /** Library or generated fingering, or null when none exists ("sin digitación"). */
  shape: ChordShape | null;
}

export interface EditorAnalysis {
  song: Song;
  /** Errors and warnings, sorted by line (as returned by parseSong). */
  issues: ParseError[];
  errorCount: number;
  warningCount: number;
  chords: ChordEntry[];
  /** Bars after expansion. */
  bars: number;
  /** Expanded duration in song seconds; 0 for a song without bars. */
  durationSec: number;
}

/** Parses the source and resolves the fingering of every chord used. Never throws. */
export function analyzeSource(source: string, id = ''): EditorAnalysis {
  const { song, errors } = parseSong(source, { id });
  let errorCount = 0;
  let warningCount = 0;
  for (const e of errors) {
    if (e.severity === 'error') errorCount++;
    else warningCount++;
  }
  const chords = song.chordNames.map((name): ChordEntry => ({ name, shape: getChordShape(name) }));
  return {
    song,
    issues: errors,
    errorCount,
    warningCount,
    chords,
    bars: song.bars.length,
    durationSec: song.bars.length > 0 ? songDurationSec(song) : 0,
  };
}

/**
 * Character range `[start, end)` of a 1-based line (without its line break). Lines are split
 * on `\n`; a trailing `\r` is excluded from the range. `line` is clamped to `1..lineCount`.
 */
export function lineRange(source: string, line: number): { start: number; end: number } {
  const lines = source.split('\n');
  const index = Math.min(Math.max(1, Math.floor(line)), lines.length) - 1;
  let start = 0;
  for (let i = 0; i < index; i++) start += lines[i].length + 1;
  let end = start + lines[index].length;
  if (end > start && source.charCodeAt(end - 1) === 13) end--; // '\r'
  return { start, end };
}

/** 1-based line containing the character `offset` (clamped to the text). */
export function lineOfOffset(source: string, offset: number): number {
  const limit = Math.min(Math.max(0, offset), source.length);
  let line = 1;
  for (let i = 0; i < limit; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Pluralised counter used in the panel headings. */
export function issuesSummary(errorCount: number, warningCount: number): string {
  if (errorCount === 0 && warningCount === 0) return 'Sin errores ni avisos';
  const parts: string[] = [];
  if (errorCount > 0) parts.push(errorCount === 1 ? '1 error' : `${errorCount} errores`);
  if (warningCount > 0) parts.push(warningCount === 1 ? '1 aviso' : `${warningCount} avisos`);
  return parts.join(' · ');
}

/** "96" or "96.5": bpm rounded to a tenth, without a trailing ".0". */
export function formatBpm(bpm: number): string {
  const r = Math.round(bpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const TEMPO_HEADER_LINE_RE = /^([ \t]*tempo[ \t]*:[ \t]*)([^\s#]*)(.*)$/i;
const OTHER_HEADER_LINE_RE = /^[ \t]*(title|artist|time|strum|capo)[ \t]*:/i;
/** Lines that are not bars: blank, comment, section header, lyric. */
const NON_BAR_LINE_RE = /^\s*(#|\[|>|$)/;

/**
 * Returns `source` with its initial `tempo:` header set to `bpm`: the first `tempo:` line
 * found before the first bar line is rewritten in place (comments and `bpm` suffixes are
 * kept); when there is none, `tempo: N` is inserted after the leading headers (or at the
 * top). Later `tempo:` changes between bars are left untouched. Line endings are preserved.
 * Used by "Aplicar tempo" (SPEC section 11); `applyTempoHeader` is an alias.
 */
export function rewriteTempoHeader(source: string, bpm: number): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const value = formatBpm(bpm);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TEMPO_HEADER_LINE_RE.exec(line);
    if (m) {
      lines[i] = `${m[1]}${value}${m[3]}`;
      return lines.join(eol);
    }
    if (OTHER_HEADER_LINE_RE.test(line)) {
      insertAt = i + 1;
      continue;
    }
    if (NON_BAR_LINE_RE.test(line)) continue;
    break; // first bar line: the header block is over
  }
  lines.splice(insertAt, 0, `tempo: ${value}`);
  return lines.join(eol);
}

/** Alias of `rewriteTempoHeader` (the "Aplicar tempo" action). */
export const applyTempoHeader = rewriteTempoHeader;

export type ConfidenceLabel = 'alta' | 'media' | 'baja';

/** ≥ 0.6 alta, ≥ 0.3 media, otherwise baja. */
export function confidenceLabel(confidence: number): ConfidenceLabel {
  if (confidence >= 0.6) return 'alta';
  if (confidence >= 0.3) return 'media';
  return 'baja';
}

/** "≈ 96 BPM (confianza alta), inicio 1.32 s". */
export function formatTempoEstimate(e: Pick<TempoEstimate, 'bpm' | 'confidence' | 'firstBeatSec'>): string {
  return `≈ ${formatBpm(e.bpm)} BPM (confianza ${confidenceLabel(e.confidence)}), inicio ${e.firstBeatSec.toFixed(2)} s`;
}

/** "3.4 MB" (always in MB, one decimal). */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, bytes) / 1048576;
  return `${mb.toFixed(1)} MB`;
}

/** Start of the test listen: one bar before the offset when that is ≥ 0, otherwise 0. */
export function previewStartSec(offsetSec: number, bpm: number, beatsPerBar: number): number {
  if (!(bpm > 0) || !(beatsPerBar > 0)) return Math.max(0, offsetSec);
  const start = offsetSec - (beatsPerBar * 60) / bpm;
  return start >= 0 ? start : 0;
}

export interface PreviewClick {
  /** Audio time of the click. */
  sec: number;
  /** First beat of a bar. */
  accent: boolean;
}

/**
 * Metronome clicks of a test listen that starts at `fromSec`: every grid beat from the lead-in
 * bar (beat -beatsPerBar) to the end of bar `bars`, keeping only those at or after `fromSec`.
 */
export function previewClickTimes(offsetSec: number, bpm: number, beatsPerBar: number, fromSec: number, bars: number = PREVIEW_BARS): PreviewClick[] {
  const out: PreviewClick[] = [];
  if (!(bpm > 0) || !(beatsPerBar > 0) || !(bars > 0)) return out;
  const beatSec = 60 / bpm;
  for (let k = -beatsPerBar; k < bars * beatsPerBar; k++) {
    const sec = offsetSec + k * beatSec;
    if (sec < fromSec - 1e-6) continue;
    out.push({ sec, accent: ((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0 });
  }
  return out;
}

/** Short example shown inside the "Formato" help. */
export const FORMAT_EXAMPLE = `title: Mi canción
artist: Yo
tempo: 100
time: 4/4
strum: D-DU-UDU
capo: 0

[Intro]
C . . . | G . . . | x2
[Estrofa]
C G | Am F |          # dos beats cada uno
Am*3 F | N.C. | - - G . |
> Letra de la estrofa
[Estribillo]
F . . . | G . . . |
[Estrofa]             # vuelve a insertar la estrofa
[Estribillo] x2`;

/** Grammar summary rows: [token, description]. Rendered as a <dl> in the "Formato" help. */
export const FORMAT_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['title: / artist:', 'Título y artista.'],
  ['tempo: 100', 'Pulsos por minuto (20–400). Se puede cambiar entre compases.'],
  ['time: 4/4', 'Compás: 4/4 (por defecto), 3/4, 2/4 o 6/8 (en x/8 el pulso es la corchea).'],
  [
    'strum: D-DU-UDU',
    'Patrón de rasgueo por compás: D abajo, U arriba, x apagado, - nada. Longitud = beats del compás, el doble (corcheas) o el cuádruple (semicorcheas).',
  ],
  ['capo: 2', 'Cejilla (0–12): se muestra y la detección se desplaza.'],
  ['[Estrofa]', 'Sección. Con compases debajo la define; vacía vuelve a insertar la última definición.'],
  ['[Estribillo] x2', 'Inserta la sección dos veces.'],
  ['C . . . |', 'Compases separados por |. Cada . prolonga el acorde un beat. Un . al inicio prolonga el acorde del compás anterior.'],
  ['C G |', 'Acordes «desnudos»: el compás se reparte a partes iguales (2 + 2 en 4/4).'],
  ['Am*3 F |', 'Duración explícita: Am durante 3 beats, F el beat restante.'],
  ['-', 'Silencio de 1 beat (sin rasgueo).'],
  ['N.C.', 'Sin acorde: la pelota bota pero no se juzga.'],
  ['| x2', 'Al final de una línea: repite sus compases 2 veces (1–32).'],
  ['> letra', 'Letra asociada a la línea de compases anterior.'],
  ['# comentario', 'Comentario (al inicio de línea o tras un espacio, para no romper F#m).'],
  ['Acordes', 'C, Am, F#m, Bb, G/B, Dsus4, Cadd9, Am7, Cmaj7, C7, Cdim, C+, C5… Los desconocidos no son error, pero salen sin digitación.'],
];

// ---------------------------------------------------------------- DOM helpers

const noop = (): void => {};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return fallback;
}

function drawMini(canvas: HTMLCanvasElement, entry: ChordEntry): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(MINI_DIAGRAM_W * dpr);
  canvas.height = Math.round(MINI_DIAGRAM_H * dpr);
  canvas.style.width = `${MINI_DIAGRAM_W}px`;
  canvas.style.height = `${MINI_DIAGRAM_H}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MINI_DIAGRAM_W, MINI_DIAGRAM_H);
  drawChordDiagram(ctx, entry.shape, { x: 0, y: 0, w: MINI_DIAGRAM_W, h: MINI_DIAGRAM_H }, { title: entry.name, showFingers: false });
}

function chordChip(entry: ChordEntry): HTMLElement {
  const canvas = h('canvas', { width: MINI_DIAGRAM_W, height: MINI_DIAGRAM_H });
  const chip = h(
    'div.chord-chip',
    {
      class: entry.shape ? '' : 'is-missing',
      title: entry.shape
        ? entry.shape.generated
          ? `${entry.name}: cejilla generada en el traste ${entry.shape.baseFret}`
          : `${entry.name}: digitación de la biblioteca`
        : `${entry.name}: sin digitación conocida (se mostrará en amarillo en la autopista)`,
    },
    canvas,
    entry.shape ? null : h('span.chord-chip-note', null, 'sin digitación'),
  );
  drawMini(canvas, entry);
  return chip;
}

function stat(label: string): { el: HTMLElement; value: HTMLElement } {
  const value = h('span.stat-value', null, '—');
  const el = h('div.stat', null, h('span.stat-label', null, label), value);
  return { el, value };
}

function formatHelp(): HTMLElement {
  const dl = h('dl');
  for (const [token, description] of FORMAT_HELP_ROWS) {
    dl.appendChild(h('dt', null, token));
    dl.appendChild(h('dd', null, description));
  }
  return h(
    'details.card.format-help',
    null,
    h('summary', null, 'Formato'),
    h('p.muted', null, 'Cabeceras al principio, una sección por bloque y los compases separados por barras verticales.'),
    h('pre', null, FORMAT_EXAMPLE),
    dl,
  );
}

// ---------------------------------------------------------------- screen

type SaveStatus = 'saved' | 'dirty' | 'flash';

type PreviewMode = 'metronome' | 'free';

interface Preview {
  mode: PreviewMode;
  /** AudioContext time at which `fromSec` of the audio starts playing. */
  whenWall: number;
  fromSec: number;
}

export const editorScreen: Screen = {
  mount(root: HTMLElement, params: Record<string, string>): () => void {
    const id = params.id ?? '';
    if (id === '' || isExampleId(id)) {
      location.replace('#/');
      return noop;
    }
    const stored = getSong(id);
    if (!stored) {
      location.replace('#/');
      return noop;
    }

    // ------------------------------------------------------------ state
    let analysis = analyzeSource(stored.source, id);
    let dirty = false;
    let saveTimer: number | null = null;
    let flashTimer: number | null = null;
    let lastChordKey = '';
    let unmounted = false;

    // Backing track state (metadata lives in the song; the blob in IndexedDB).
    let audio: AudioTrackInfo | null = stored.audio ?? null;
    let audioDirty = false;
    let audioSaveTimer: number | null = null;
    let backing: BackingTrack | null = null;
    let sampleRate = 0;
    let lastSeekSec = 0;
    let preview: Preview | null = null;
    let previewRaf = 0;
    let estimate: TempoEstimate | null = null;
    let busy = false;
    let metronome: Metronome | null = null;

    // ------------------------------------------------------------ elements
    const textarea = h('textarea', {
      class: 'editor-source',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      wrap: 'off',
      rows: 20,
      'aria-label': 'Texto de la canción',
      placeholder: 'title: Mi canción\ntempo: 100\n\nC . . . | G . . . |',
    });
    textarea.value = stored.source;

    const titleEl = h('h2.editor-title', null, displayTitle(analysis.song.title));
    const statusEl = h('span.save-status', null, 'Guardado');
    const caretEl = h('span', null, 'Línea 1');

    const statBars = stat('Compases');
    const statDuration = stat('Duración');
    const statTempo = stat('Tempo');
    const statTime = stat('Compás');

    const issuesHeading = h('div.card-title', null, 'Errores y avisos');
    const issuesList = h('div.issues');
    const chordsHeading = h('div.card-title', null, 'Acordes');
    const chordGrid = h('div.chord-grid');

    // Audio panel elements
    const fileInput = h('input', { type: 'file', accept: 'audio/*', hidden: true, 'aria-label': 'Archivo de audio', onchange: () => void onFileChosen() });
    const loadBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => fileInput.click() }, 'Cargar audio…') as HTMLButtonElement;
    const emptyView = h(
      'div.audio-empty',
      null,
      loadBtn,
      h('p.muted.small', null, 'MP3, WAV, OGG, M4A. Se guarda en este navegador, no se sube a ningún sitio.'),
    );

    const trackName = h('span.audio-name');
    const trackMeta = h('span.audio-meta.muted.small');
    const replaceBtn = h('button.btn.btn-sm', { type: 'button', title: 'Sustituir el archivo de audio', onclick: () => fileInput.click() }, 'Cambiar…') as HTMLButtonElement;
    const removeBtn = h('button.btn.btn-sm.btn-danger', { type: 'button', title: 'Quitar la pista de esta canción', onclick: () => void removeTrack() }, 'Quitar') as HTMLButtonElement;
    const trackInfo = h('div.audio-info', null, h('span.audio-icon', null, '♪'), trackName, trackMeta, h('span.spacer'), replaceBtn, removeBtn);

    const waveCanvas = h('canvas', { class: 'audio-wave-canvas', 'aria-label': 'Forma de onda de la pista' });
    const waveWrap = h('div.audio-wave', null, waveCanvas);
    const waveHint = h(
      'div.audio-wave-hint.muted.small',
      null,
      'Clic: situar el cursor · Mayús+clic o arrastrar la marca: fijar el inicio · Rueda: zoom · Alt+arrastrar: desplazar',
    );

    const offsetInput = h('input', { type: 'number', step: '0.01', class: 'audio-offset-input', 'aria-label': 'Inicio del compás 1 (s)', inputMode: 'decimal' });
    offsetInput.addEventListener('change', () => {
      const v = Number(offsetInput.value.replace(',', '.'));
      if (Number.isFinite(v)) setOffset(v);
      else if (audio) offsetInput.value = audio.offsetSec.toFixed(2);
    });
    const stepButtons = OFFSET_STEPS_SEC.map(
      (d) =>
        h(
          'button.btn.btn-sm',
          { type: 'button', title: `${d > 0 ? 'Retrasar' : 'Adelantar'} el inicio ${Math.abs(d)} s`, onclick: () => nudgeOffset(d) },
          `${d > 0 ? '+' : '−'}${Math.abs(d)}`,
        ) as HTMLButtonElement,
    );
    const minusBeatBtn = h('button.btn.btn-sm', { type: 'button', title: 'Un pulso antes (60 / tempo)', onclick: () => nudgeOffset(-beatSec()) }, '−1 pulso') as HTMLButtonElement;
    const plusBeatBtn = h('button.btn.btn-sm', { type: 'button', title: 'Un pulso después (60 / tempo)', onclick: () => nudgeOffset(beatSec()) }, '+1 pulso') as HTMLButtonElement;
    const markBtn = h(
      'button.btn.btn-sm',
      { type: 'button', title: 'Fija el inicio en la posición actual (mientras suena) o en la del último clic en la forma de onda', onclick: () => markStart() },
      'Marcar inicio',
    ) as HTMLButtonElement;
    const syncRow = h(
      'div.audio-row',
      null,
      h('label.audio-offset-label', null, 'Inicio del compás 1 (s)', offsetInput),
      h('div.audio-btn-group', null, ...stepButtons),
      h('div.audio-btn-group', null, minusBeatBtn, plusBeatBtn),
      markBtn,
    );

    const detectBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => void detect() }, 'Detectar tempo e inicio') as HTMLButtonElement;
    const detectResult = h('span.audio-detect-result');
    const applyTempoBtn = h(
      'button.btn.btn-sm',
      { type: 'button', hidden: true, title: 'Reescribe (o inserta) la cabecera tempo: del texto', onclick: () => applyTempo() },
      'Aplicar tempo',
    ) as HTMLButtonElement;
    const applyStartBtn = h(
      'button.btn.btn-sm',
      { type: 'button', hidden: true, title: 'Fija el inicio del compás 1 en el primer pulso detectado', onclick: () => applyStart() },
      'Aplicar inicio',
    ) as HTMLButtonElement;
    const detectRow = h('div.audio-row', null, detectBtn, detectResult, applyTempoBtn, applyStartBtn);
    const constantTempoWarn = h('div.audio-warn', { hidden: true }, 'La pista solo se sincroniza con tempo constante: el texto cambia de tempo entre compases.');

    const playMetroBtn = h(
      'button.btn.btn-sm',
      { type: 'button', title: 'Reproduce desde un compás antes del inicio con clics en cada pulso', onclick: () => startPreview('metronome') },
      '▶ Escuchar con metrónomo',
    ) as HTMLButtonElement;
    const playHereBtn = h(
      'button.btn.btn-sm',
      { type: 'button', title: 'Reproduce desde el último clic en la forma de onda, sin clics', onclick: () => startPreview('free') },
      '▶ Desde aquí',
    ) as HTMLButtonElement;
    const stopBtn = h('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => stopPreview() }, '■ Parar') as HTMLButtonElement;
    const volumeInput = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'audio-volume', 'aria-label': 'Volumen de la pista' });
    const volumeValue = h('span.audio-volume-value.muted.small', null, '80 %');
    volumeInput.addEventListener('input', () => onVolumeInput());
    const previewRow = h(
      'div.audio-row',
      null,
      playMetroBtn,
      playHereBtn,
      stopBtn,
      h('label.audio-volume-label', null, 'Volumen', volumeInput, volumeValue),
    );

    const audioStatus = h('div.audio-status', { hidden: true });
    const storageNote = h('div.audio-warn', { hidden: true });
    const trackView = h('div.audio-track', { hidden: true }, trackInfo, waveWrap, waveHint, syncRow, detectRow, constantTempoWarn, previewRow);
    const audioPanel = h('section.card.audio-panel', null, h('div.card-title', null, 'Pista de audio'), fileInput, emptyView, trackView, audioStatus, storageNote);

    const waveform = new WaveformView(waveCanvas, {
      onOffsetChange: (sec) => setOffset(sec),
      onSeek: (sec) => onSeek(sec),
    });

    // ------------------------------------------------------------ helpers
    function displayTitle(title: string): string {
      const t = title.trim();
      return t === '' ? 'Sin título' : t;
    }

    function setStatus(status: SaveStatus): void {
      statusEl.classList.toggle('is-dirty', status === 'dirty');
      statusEl.classList.toggle('is-flash', status === 'flash');
      statusEl.textContent = status === 'dirty' ? 'Sin guardar' : status === 'flash' ? 'Guardado ✓' : 'Guardado';
    }

    function updateCaret(): void {
      caretEl.textContent = `Línea ${lineOfOffset(textarea.value, textarea.selectionStart)}`;
    }

    function goToLine(line: number): void {
      const { start, end } = lineRange(textarea.value, line);
      textarea.focus();
      textarea.setSelectionRange(start, end);
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
      textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight / 2 + lineHeight);
      updateCaret();
    }

    function renderIssues(): void {
      clear(issuesList);
      issuesHeading.textContent = `Errores y avisos · ${issuesSummary(analysis.errorCount, analysis.warningCount)}`;
      if (analysis.issues.length === 0) {
        issuesList.appendChild(h('div.issues-empty', null, 'Sin errores ni avisos. ¡Listo para practicar!'));
        return;
      }
      for (const issue of analysis.issues) {
        issuesList.appendChild(
          h(
            'button.issue',
            {
              type: 'button',
              class: issue.severity,
              title: `Ir a la línea ${issue.line}`,
              onclick: () => goToLine(issue.line),
            },
            h('span.issue-line', null, `L${issue.line}`),
            h('span.issue-msg', null, issue.message),
          ),
        );
      }
    }

    function renderChords(): void {
      const key = analysis.chords.map((c) => c.name).join('\u0000');
      if (key === lastChordKey) return;
      lastChordKey = key;
      clear(chordGrid);
      const missing = analysis.chords.filter((c) => c.shape === null).length;
      chordsHeading.textContent =
        analysis.chords.length === 0
          ? 'Acordes'
          : `Acordes · ${analysis.chords.length}${missing > 0 ? ` (${missing} sin digitación)` : ''}`;
      if (analysis.chords.length === 0) {
        chordGrid.appendChild(h('div.muted.small', null, 'Escribe acordes en los compases para verlos aquí.'));
        return;
      }
      for (const entry of analysis.chords) chordGrid.appendChild(chordChip(entry));
    }

    function renderStats(): void {
      statBars.value.textContent = String(analysis.bars);
      statDuration.value.textContent = fmtSeconds(analysis.durationSec);
      statTempo.value.textContent = `${analysis.song.tempo} bpm${analysis.song.tempoSegments.length > 1 ? ' +' : ''}`;
      statTime.value.textContent = `${analysis.song.timeSignature.beatsPerBar}/${analysis.song.timeSignature.beatUnit}`;
      const title = displayTitle(analysis.song.title);
      titleEl.textContent = title;
      document.title = `GuitarZero — ${title}`;
    }

    function refresh(): void {
      analysis = analyzeSource(textarea.value, id);
      renderStats();
      renderIssues();
      renderChords();
    }

    /** The song as it should be persisted right now (text + backing track metadata). */
    function currentStored(): StoredSong {
      const { song } = analysis;
      return { id, title: song.title, artist: song.artist, source: textarea.value, updatedAt: 0, audio };
    }

    /** Persists pending changes (text and/or audio metadata) now. Returns true when something was written. */
    function flush(): boolean {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (audioSaveTimer !== null) {
        clearTimeout(audioSaveTimer);
        audioSaveTimer = null;
      }
      if (!dirty && !audioDirty) return false;
      saveSong(currentStored());
      dirty = false;
      audioDirty = false;
      setStatus('saved');
      return true;
    }

    function scheduleSave(): void {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        flush();
        syncGrid();
      }, AUTOSAVE_DELAY_MS);
    }

    function scheduleAudioSave(): void {
      audioDirty = true;
      setStatus('dirty');
      if (audioSaveTimer !== null) clearTimeout(audioSaveTimer);
      audioSaveTimer = window.setTimeout(() => {
        audioSaveTimer = null;
        flush();
      }, AUDIO_SAVE_DELAY_MS);
    }

    function saveWithFeedback(): void {
      flush();
      syncGrid();
      setStatus('flash');
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        flashTimer = null;
        if (!dirty && !audioDirty) setStatus('saved');
      }, SAVED_FLASH_MS);
    }

    function onInput(): void {
      dirty = true;
      setStatus('dirty');
      refresh();
      scheduleSave();
      updateCaret();
    }

    function onKeyDown(ev: KeyboardEvent): void {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        saveWithFeedback();
      }
    }

    const flushOnHide = (): void => {
      flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    // ------------------------------------------------------------ audio panel

    function bpm(): number {
      return analysis.song.tempo;
    }

    function beatsPerBar(): number {
      return analysis.song.timeSignature.beatsPerBar;
    }

    function beatSec(): number {
      const b = bpm();
      return b > 0 ? 60 / b : 0;
    }

    function setAudioStatus(text: string, isError = false): void {
      audioStatus.textContent = text;
      audioStatus.hidden = text === '';
      audioStatus.classList.toggle('is-error', isError);
    }

    /** Beat grid of the current text over the waveform; also toggles the constant-tempo warning. */
    function syncGrid(): void {
      if (!audio) {
        waveform.setGrid(null);
        constantTempoWarn.hidden = true;
        return;
      }
      waveform.setGrid({ bpm: bpm(), beatsPerBar: beatsPerBar(), offsetSec: audio.offsetSec, totalBeats: analysis.song.totalBeats });
      constantTempoWarn.hidden = analysis.song.tempoSegments.length <= 1;
    }

    function renderTrackInfo(): void {
      const has = audio !== null;
      emptyView.hidden = has;
      trackView.hidden = !has;
      if (!audio) return;
      trackName.textContent = audio.name || 'audio';
      trackName.title = audio.name;
      trackMeta.textContent = `${fmtSeconds(audio.durationSec)} · ${formatMegabytes(audio.size)}`;
      offsetInput.value = audio.offsetSec.toFixed(2);
      const pct = Math.round(clamp(audio.gain, 0, 1) * 100);
      volumeInput.value = String(pct);
      volumeValue.textContent = `${pct} %`;
    }

    function updateButtons(): void {
      const ready = backing !== null && !busy;
      loadBtn.disabled = busy;
      replaceBtn.disabled = busy;
      removeBtn.disabled = busy;
      for (const b of [playMetroBtn, playHereBtn, detectBtn, markBtn, minusBeatBtn, plusBeatBtn, ...stepButtons]) b.disabled = !ready;
      stopBtn.disabled = preview === null;
      applyTempoBtn.disabled = busy;
      applyStartBtn.disabled = busy;
    }

    function hideEstimate(): void {
      estimate = null;
      detectResult.textContent = '';
      applyTempoBtn.hidden = true;
      applyStartBtn.hidden = true;
    }

    function setOffset(sec: number): void {
      if (!audio) return;
      const limit = Math.max(audio.durationSec, 0);
      const v = Math.round(clamp(sec, -limit, limit) * 1000) / 1000;
      offsetInput.value = v.toFixed(2);
      if (v === audio.offsetSec) return;
      audio = { ...audio, offsetSec: v };
      syncGrid();
      scheduleAudioSave();
    }

    function nudgeOffset(deltaSec: number): void {
      if (!audio || !Number.isFinite(deltaSec)) return;
      setOffset(audio.offsetSec + deltaSec);
    }

    function currentPreviewSec(): number | null {
      if (!preview) return null;
      const ctx = getAudioContext();
      return Math.max(preview.fromSec, preview.fromSec + (ctx.currentTime - preview.whenWall));
    }

    function markStart(): void {
      if (!audio) return;
      const sec = currentPreviewSec();
      setOffset(sec === null ? lastSeekSec : sec);
    }

    function onSeek(sec: number): void {
      lastSeekSec = sec;
      if (preview) startPreview('free');
      else waveform.setPlayhead(sec);
    }

    function onVolumeInput(): void {
      if (!audio) return;
      const pct = clamp(Math.round(Number(volumeInput.value)), 0, 100);
      if (!Number.isFinite(pct)) return;
      volumeValue.textContent = `${pct} %`;
      const gain = pct / 100;
      if (gain === audio.gain) return;
      audio = { ...audio, gain };
      backing?.setGain(gain);
      scheduleAudioSave();
    }

    /** Decodes `blob` into a new BackingTrack (the caller commits or disposes it). */
    async function decode(blob: Blob): Promise<{ track: BackingTrack; durationSec: number; sampleRate: number }> {
      const track = new BackingTrack(getAudioContext());
      try {
        const info = await track.load(blob);
        return { track, durationSec: info.durationSec, sampleRate: info.sampleRate };
      } catch (err) {
        track.dispose();
        throw err;
      }
    }

    function commitTrack(track: BackingTrack, rate: number): void {
      stopPreview();
      backing?.dispose();
      backing = track;
      sampleRate = rate;
      track.setGain(audio ? audio.gain : DEFAULT_TRACK_GAIN);
      waveform.setAudio(track.monoSamples(), rate);
      lastSeekSec = 0;
      waveform.setPlayhead(null);
    }

    async function loadStoredTrack(): Promise<void> {
      if (!audio) return;
      busy = true;
      updateButtons();
      setAudioStatus('Cargando pista…');
      try {
        const blob = await getTrack(id);
        if (unmounted) return;
        if (!blob) {
          setAudioStatus('No se encontró el archivo de audio en este navegador (¿otro navegador o datos borrados?). Vuelve a cargarlo con «Cambiar…» o quita la pista.', true);
          return;
        }
        const { track, durationSec, sampleRate: rate } = await decode(blob);
        if (unmounted) {
          track.dispose();
          return;
        }
        commitTrack(track, rate);
        if (Math.abs(durationSec - audio.durationSec) > 0.01) {
          audio = { ...audio, durationSec };
          scheduleAudioSave();
        }
        renderTrackInfo();
        syncGrid();
        setAudioStatus('');
      } catch (err) {
        if (!unmounted) setAudioStatus(errorMessage(err, 'No se pudo cargar la pista de audio'), true);
      } finally {
        busy = false;
        if (!unmounted) updateButtons();
      }
    }

    async function onFileChosen(): Promise<void> {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || busy) return;
      busy = true;
      updateButtons();
      setAudioStatus(`Cargando «${file.name}»…`);
      let decoded: { track: BackingTrack; durationSec: number; sampleRate: number } | null = null;
      try {
        try {
          decoded = await decode(file);
        } catch {
          throw new Error('Formato de audio no soportado o archivo dañado (prueba con MP3, WAV, OGG o M4A)');
        }
        if (unmounted) return;
        try {
          await putTrack(id, file, { name: file.name, type: file.type, size: file.size });
        } catch (err) {
          throw new Error(errorMessage(err, 'No se pudo guardar el audio en este navegador (¿sin espacio?)'));
        }
        if (unmounted) return;
        const previous = audio;
        audio = {
          name: file.name,
          type: file.type,
          size: file.size,
          durationSec: decoded.durationSec,
          offsetSec: previous ? clamp(previous.offsetSec, -decoded.durationSec, decoded.durationSec) : 0,
          gain: previous ? previous.gain : DEFAULT_TRACK_GAIN,
        };
        commitTrack(decoded.track, decoded.sampleRate);
        decoded = null;
        hideEstimate();
        audioDirty = true;
        flush();
        renderTrackInfo();
        syncGrid();
        setAudioStatus(hasIndexedDb() ? '' : 'Este navegador no permite guardar archivos: la pista se perderá al recargar la página.', !hasIndexedDb());
      } catch (err) {
        if (!unmounted) setAudioStatus(errorMessage(err, 'No se pudo cargar el archivo'), true);
      } finally {
        decoded?.track.dispose();
        busy = false;
        if (!unmounted) updateButtons();
      }
    }

    async function removeTrack(): Promise<void> {
      if (!audio || busy) return;
      if (!confirm('¿Quitar la pista de audio de esta canción? El archivo se borrará de este navegador.')) return;
      stopPreview();
      busy = true;
      updateButtons();
      try {
        await deleteTrack(id);
      } catch (err) {
        console.warn('No se pudo borrar la pista de IndexedDB', err);
      }
      if (unmounted) return;
      audio = null;
      backing?.dispose();
      backing = null;
      sampleRate = 0;
      waveform.setAudio(new Float32Array(0), 44100);
      hideEstimate();
      audioDirty = true;
      flush();
      renderTrackInfo();
      syncGrid();
      setAudioStatus('');
      busy = false;
      updateButtons();
    }

    async function detect(): Promise<void> {
      if (!backing || busy) return;
      busy = true;
      updateButtons();
      applyTempoBtn.hidden = true;
      applyStartBtn.hidden = true;
      detectResult.textContent = 'Analizando…';
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      try {
        if (unmounted || !backing) return;
        estimate = estimateTempo(backing.monoSamples(), sampleRate);
        detectResult.textContent = formatTempoEstimate(estimate);
        applyTempoBtn.hidden = false;
        applyStartBtn.hidden = false;
      } catch (err) {
        estimate = null;
        detectResult.textContent = errorMessage(err, 'No se pudo analizar la pista');
      } finally {
        busy = false;
        if (!unmounted) updateButtons();
      }
    }

    function applyTempo(): void {
      if (!estimate) return;
      const next = rewriteTempoHeader(textarea.value, estimate.bpm);
      if (next !== textarea.value) {
        textarea.value = next;
        onInput();
      }
      syncGrid();
    }

    function applyStart(): void {
      if (!estimate) return;
      setOffset(estimate.firstBeatSec);
    }

    function ensureMetronome(): Metronome {
      if (!metronome) metronome = new Metronome(getAudioContext());
      return metronome;
    }

    function startPreview(mode: PreviewMode): void {
      if (!audio || !backing) return;
      const ctx = getAudioContext();
      void ctx.resume().catch(noop); // synchronously, inside the click handler (iOS)
      stopPreview();
      const fromSec = mode === 'metronome' ? previewStartSec(audio.offsetSec, bpm(), beatsPerBar()) : clamp(lastSeekSec, 0, audio.durationSec);
      if (fromSec >= audio.durationSec) return;
      const whenWall = ctx.currentTime + PREVIEW_LEAD_SEC;
      backing.setGain(audio.gain);
      backing.start(whenWall, fromSec, 1);
      if (mode === 'metronome') {
        const clicks = ensureMetronome();
        for (const c of previewClickTimes(audio.offsetSec, bpm(), beatsPerBar(), fromSec, PREVIEW_BARS)) {
          clicks.scheduleClick(whenWall + (c.sec - fromSec), c.accent);
        }
      }
      preview = { mode, whenWall, fromSec };
      updateButtons();
      const durationSec = audio.durationSec;
      const track = backing;
      const tick = (): void => {
        previewRaf = 0;
        if (!preview || unmounted) return;
        const sec = preview.fromSec + (ctx.currentTime - preview.whenWall);
        if (sec >= durationSec || (sec > preview.fromSec + 0.5 && !track.isPlaying())) {
          stopPreview();
          return;
        }
        waveform.setPlayhead(Math.max(preview.fromSec, sec));
        previewRaf = requestAnimationFrame(tick);
      };
      previewRaf = requestAnimationFrame(tick);
    }

    function stopPreview(): void {
      if (previewRaf) {
        cancelAnimationFrame(previewRaf);
        previewRaf = 0;
      }
      if (!preview) return;
      preview = null;
      backing?.stop();
      metronome?.clear();
      waveform.setPlayhead(null);
      updateButtons();
    }

    // ------------------------------------------------------------ layout
    const header = h(
      'header.screen-header',
      null,
      h('a.btn', { href: '#/', title: 'Volver a la biblioteca' }, '← Volver'),
      h('div.grow', null, titleEl, h('div.muted.small', null, 'Editor · los cambios se guardan solos')),
      statusEl,
      h('button.btn', { type: 'button', onclick: saveWithFeedback, title: 'Guardar ahora (Ctrl+S)' }, 'Guardar'),
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          title: 'Guardar y abrir la autopista',
          onclick: () => {
            flush();
            location.hash = `#/play/${id}`;
          },
        },
        'Probar',
      ),
    );

    const main = h(
      'div.editor-main',
      null,
      textarea,
      h('div.editor-hint', null, caretEl, h('span', null, 'Ctrl+S guarda al instante'), h('span', null, 'Pulsa en un error para ir a su línea')),
      audioPanel,
    );

    const panel = h(
      'aside.editor-panel',
      null,
      h('div.card', null, h('div.card-title', null, 'Resumen'), h('div.stats', null, statBars.el, statDuration.el, statTempo.el, statTime.el)),
      h('div.card', null, issuesHeading, issuesList),
      h('div.card', null, chordsHeading, chordGrid),
      formatHelp(),
    );

    const screen = h('main.screen.editor', null, header, h('div.editor-body', null, main, panel));
    root.appendChild(screen);

    textarea.addEventListener('input', onInput);
    textarea.addEventListener('keydown', onKeyDown);
    textarea.addEventListener('keyup', updateCaret);
    textarea.addEventListener('click', updateCaret);
    textarea.addEventListener('select', updateCaret);
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', onVisibility);

    const onWaveResize = (): void => waveform.resize();
    const waveObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onWaveResize) : null;
    if (waveObserver) waveObserver.observe(waveWrap);
    else window.addEventListener('resize', onWaveResize);

    renderStats();
    renderIssues();
    renderChords();
    setStatus('saved');
    updateCaret();
    renderTrackInfo();
    syncGrid();
    updateButtons();
    if (!hasIndexedDb()) {
      storageNote.textContent = 'Este navegador no permite guardar archivos (IndexedDB no disponible): una pista cargada se perderá al recargar la página.';
      storageNote.hidden = false;
    }
    if (audio) void loadStoredTrack();

    return () => {
      unmounted = true;
      stopPreview();
      flush();
      if (flashTimer !== null) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('keyup', updateCaret);
      textarea.removeEventListener('click', updateCaret);
      textarea.removeEventListener('select', updateCaret);
      window.removeEventListener('pagehide', flushOnHide);
      document.removeEventListener('visibilitychange', onVisibility);
      if (waveObserver) waveObserver.disconnect();
      else window.removeEventListener('resize', onWaveResize);
      waveform.dispose();
      backing?.dispose();
      backing = null;
      metronome?.clear();
    };
  },
};
