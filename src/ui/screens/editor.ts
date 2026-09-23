/**
 * Editor screen (`#/edit/:id`, SPEC.md section 8).
 *
 * A big monospace textarea plus a side panel with: errors and warnings (line + message,
 * click moves the caret to that line), the chords used with mini diagrams (yellow
 * "sin digitación" when getChordShape is null), bar count and expanded duration, and the
 * buttons Probar (flush + `#/play/:id`), Guardar (flush + "Guardado" feedback) and Volver.
 * Autosave: saveSong debounced 500 ms, flushed on unmount. A collapsible <details> "Formato"
 * summarises the song grammar. `#/edit/ex:*` (read-only examples) redirects to the library.
 *
 * `analyzeSource`, `lineRange`, `lineOfOffset` and the help data are pure (testable in Node).
 */
import './editor.css';
import type { ChordShape, ParseError, Screen, Song } from '../../types';
import { clear, fmtSeconds, h } from '../dom';
import { drawChordDiagram } from '../chordDiagram';
import { getChordShape } from '../../music/chords';
import { parseSong } from '../../song/parser';
import { songDurationSec } from '../../song/tempo';
import { isExampleId } from '../../song/examples';
import { getSong, saveSong } from '../../song/storage';

// ---------------------------------------------------------------- constants

/** Debounce of the autosave after the last keystroke. */
export const AUTOSAVE_DELAY_MS = 500;
/** How long the "Guardado" feedback stays highlighted after pressing Guardar. */
export const SAVED_FLASH_MS = 1500;
/** CSS size of a mini chord diagram in the side panel. */
export const MINI_DIAGRAM_W = 96;
export const MINI_DIAGRAM_H = 112;

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

export const editorScreen: Screen = {
  mount(root: HTMLElement, params: Record<string, string>): () => void {
    const id = params.id ?? '';
    const noop = (): void => {};
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

    /** Persists pending changes now. Returns true when something was written. */
    function flush(): boolean {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!dirty) return false;
      const { song } = analysis;
      saveSong({ id, title: song.title, artist: song.artist, source: textarea.value, updatedAt: 0 });
      dirty = false;
      setStatus('saved');
      return true;
    }

    function scheduleSave(): void {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        flush();
      }, AUTOSAVE_DELAY_MS);
    }

    function saveWithFeedback(): void {
      flush();
      setStatus('flash');
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        flashTimer = null;
        if (!dirty) setStatus('saved');
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

    renderStats();
    renderIssues();
    renderChords();
    setStatus('saved');
    updateCaret();

    return () => {
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
    };
  },
};
