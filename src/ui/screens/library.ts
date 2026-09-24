/**
 * Biblioteca screen (`#/`, SPEC.md section 8).
 *
 * Lists the bundled examples (badge "Ejemplo") and the user's songs with their metadata
 * (tempo, time signature, chord count, duration — computed with parseSong + songDurationSec)
 * and the actions Practicar / Editar (a builtin is duplicated first and the copy is opened) /
 * Duplicar / Borrar (disabled for builtins, asks for confirmation). "Nueva canción" and
 * "Progresión rápida" create a song from their templates and open the editor. Songs with a
 * backing track (StoredSong.audio) carry a "♪ pista" badge.
 *
 * `songMeta` and the formatting helpers are pure (testable in Node).
 */
import './library.css';
import type { Screen, StoredSong } from '../../types';
import { clear, fmtSeconds, h } from '../dom';
import { parseSong } from '../../song/parser';
import { songDurationSec } from '../../song/tempo';
import { QUICK_PROGRESSION_TEMPLATE, deleteSong, duplicateSong, listSongs, newSong } from '../../song/storage';

// ---------------------------------------------------------------- pure helpers

export interface SongMeta {
  id: string;
  /** Parsed `title:` header, falling back to the stored title ('' when both are empty). */
  title: string;
  artist: string;
  builtin: boolean;
  updatedAt: number;
  /** Initial tempo (bpm of the beat unit). */
  tempo: number;
  /** Initial time signature, e.g. "4/4". */
  timeSignature: string;
  /** Distinct chord names as written (rests and N.C. excluded). */
  chordNames: string[];
  chordCount: number;
  /** Bars after expanding repeats and sections. */
  bars: number;
  /** Expanded duration in song seconds (no tempoScale). */
  durationSec: number;
  errors: number;
  warnings: number;
  /** The song has a backing track (StoredSong.audio) -> "♪ pista" badge. */
  hasAudio: boolean;
}

/** Badge text of a song with a backing track. */
export const AUDIO_BADGE = '♪ pista';

export const UNTITLED = 'Sin título';

export function formatTimeSignature(ts: { beatsPerBar: number; beatUnit: number }): string {
  return `${ts.beatsPerBar}/${ts.beatUnit}`;
}

/** Title to display for a song: the parsed/stored title or "Sin título". */
export function displayTitle(title: string): string {
  const t = title.trim();
  return t === '' ? UNTITLED : t;
}

/** "1 acorde" / "5 acordes". */
export function chordCountText(n: number): string {
  return n === 1 ? '1 acorde' : `${n} acordes`;
}

/** "1 compás" / "12 compases". */
export function barCountText(n: number): string {
  return n === 1 ? '1 compás' : `${n} compases`;
}

/** Metadata of a stored song computed from its source (never throws: the parser is total). */
export function songMeta(stored: StoredSong): SongMeta {
  const { song, errors } = parseSong(stored.source, { id: stored.id });
  let errorCount = 0;
  let warningCount = 0;
  for (const e of errors) {
    if (e.severity === 'error') errorCount++;
    else warningCount++;
  }
  return {
    id: stored.id,
    title: song.title.trim() !== '' ? song.title : stored.title,
    artist: song.artist.trim() !== '' ? song.artist : stored.artist,
    builtin: stored.builtin === true,
    updatedAt: stored.updatedAt,
    tempo: song.tempo,
    timeSignature: formatTimeSignature(song.timeSignature),
    chordNames: [...song.chordNames],
    chordCount: song.chordNames.length,
    bars: song.bars.length,
    durationSec: song.bars.length > 0 ? songDurationSec(song) : 0,
    errors: errorCount,
    warnings: warningCount,
    hasAudio: stored.audio !== null && stored.audio !== undefined,
  };
}

/** Formats `updatedAt` as a short Spanish date, or '' when unknown. */
export function formatUpdatedAt(updatedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const diffSec = Math.max(0, (now - updatedAt) / 1000);
  if (diffSec < 60) return 'hace un momento';
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    return hours === 1 ? 'hace 1 hora' : `hace ${hours} horas`;
  }
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return days === 1 ? 'ayer' : `hace ${days} días`;
  try {
    return new Date(updatedAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return new Date(updatedAt).toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------- screen

function navigate(hash: string): void {
  location.hash = hash;
}

function metaItem(label: string, value: string): HTMLElement {
  return h('span', null, h('b', null, value), ` ${label}`);
}

export const libraryScreen: Screen = {
  mount(root: HTMLElement): () => void {
    const userList = h('div.lib-list');
    const exampleList = h('div.lib-list');
    const userCount = h('span.muted.small');
    /** Id of a song just created by "Duplicar", highlighted once in the list. */
    let highlightId: string | null = null;

    function songCard(meta: SongMeta): HTMLElement {
      const title = displayTitle(meta.title);
      const chips = meta.chordNames.slice(0, 12).map((name) => h('span.chip', null, name));
      if (meta.chordNames.length > 12) chips.push(h('span.chip', null, `+${meta.chordNames.length - 12}`));

      const head = h(
        'div.song-head',
        null,
        h('div.grow', null, h('div.song-title', null, title), meta.artist ? h('div.song-artist', null, meta.artist) : null),
        meta.hasAudio ? h('span.badge.badge-ok', { title: 'Tiene pista de audio' }, AUDIO_BADGE) : null,
        meta.builtin ? h('span.badge.badge-accent', null, 'Ejemplo') : null,
      );

      const info = h(
        'div.song-meta',
        null,
        metaItem('bpm', String(meta.tempo)),
        h('span', null, h('b', null, meta.timeSignature)),
        h('span', null, chordCountText(meta.chordCount)),
        h('span', null, barCountText(meta.bars)),
        h('span', null, h('b', null, fmtSeconds(meta.durationSec))),
        meta.errors > 0 ? h('span.badge.badge-bad', null, meta.errors === 1 ? '1 error' : `${meta.errors} errores`) : null,
        meta.warnings > 0 && meta.errors === 0
          ? h('span.badge.badge-warn', null, meta.warnings === 1 ? '1 aviso' : `${meta.warnings} avisos`)
          : null,
        !meta.builtin && meta.updatedAt > 0 ? h('span.muted', null, `editada ${formatUpdatedAt(meta.updatedAt)}`) : null,
      );

      const practice = h('a.btn.btn-primary', { href: `#/play/${meta.id}`, title: 'Practicar esta canción' }, 'Practicar');

      const edit = meta.builtin
        ? h(
            'button.btn',
            {
              type: 'button',
              title: 'Los ejemplos son de solo lectura: se crea una copia editable',
              onclick: () => {
                const copy = duplicateSong(meta.id);
                navigate(`#/edit/${copy.id}`);
              },
            },
            'Editar',
          )
        : h('a.btn', { href: `#/edit/${meta.id}`, title: 'Editar el texto de la canción' }, 'Editar');

      const duplicate = h(
        'button.btn',
        {
          type: 'button',
          title: 'Crear una copia',
          onclick: () => {
            const copy = duplicateSong(meta.id);
            highlightId = copy.id;
            renderLists();
          },
        },
        'Duplicar',
      );

      const remove = h(
        'button.btn.btn-danger',
        {
          type: 'button',
          disabled: meta.builtin,
          title: meta.builtin ? 'Los ejemplos no se pueden borrar' : 'Borrar la canción',
          onclick: () => {
            if (meta.builtin) return;
            if (!confirm(`¿Borrar «${title}»? Esta acción no se puede deshacer.`)) return;
            deleteSong(meta.id);
            renderLists();
          },
        },
        'Borrar',
      );

      const card = h(
        'article.card.song-card',
        { dataset: { id: meta.id } },
        head,
        info,
        chips.length > 0 ? h('div.song-chords', null, chips) : null,
        h('div.song-actions', null, practice, edit, duplicate, remove),
      );
      if (highlightId === meta.id) card.classList.add('is-new');
      return card;
    }

    function renderLists(): void {
      clear(userList);
      clear(exampleList);
      const songs = listSongs();
      let userTotal = 0;
      for (const stored of songs) {
        const meta = songMeta(stored);
        if (meta.builtin) {
          exampleList.appendChild(songCard(meta));
        } else {
          userTotal++;
          userList.appendChild(songCard(meta));
        }
      }
      if (userTotal === 0) {
        userList.appendChild(
          h(
            'div.empty',
            { style: 'grid-column: 1 / -1' },
            'Aún no tienes canciones. Crea una nueva, empieza con una progresión rápida o edita un ejemplo para obtener una copia.',
          ),
        );
      }
      userCount.textContent = userTotal === 0 ? '' : `(${userTotal})`;
      if (highlightId) {
        const card = userList.querySelector<HTMLElement>(`[data-id="${highlightId}"]`);
        highlightId = null;
        if (card) {
          card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          window.setTimeout(() => card.classList.remove('is-new'), 1800);
        }
      }
    }

    const header = h(
      'header.screen-header',
      null,
      h('div.col', { style: 'gap: 2px' }, h('h1.brand', null, 'GuitarZero'), h('span.brand-tagline', null, 'Practica acordes al ritmo de la pelota')),
      h('span.spacer'),
      h('a.btn', { href: '#/settings', title: 'Micrófono, latencia y afinación' }, 'Ajustes'),
    );

    const toolbar = h(
      'div.lib-toolbar',
      null,
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          onclick: () => {
            const song = newSong();
            navigate(`#/edit/${song.id}`);
          },
        },
        'Nueva canción',
      ),
      h(
        'button.btn',
        {
          type: 'button',
          title: 'Cuatro compases C | G | Am | F con patrón D-DU-UDU',
          onclick: () => {
            const song = newSong(QUICK_PROGRESSION_TEMPLATE);
            navigate(`#/edit/${song.id}`);
          },
        },
        'Progresión rápida',
      ),
    );

    const screen = h(
      'main.screen.library',
      null,
      header,
      toolbar,
      h('section.lib-section', null, h('div.lib-section-title', null, h('h2', null, 'Mis canciones'), userCount), userList),
      h(
        'section.lib-section',
        null,
        h('div.lib-section-title', null, h('h2', null, 'Ejemplos'), h('span.muted.small', null, 'solo lectura: «Editar» crea una copia')),
        exampleList,
      ),
    );

    root.appendChild(screen);
    renderLists();

    return () => {
      /* nothing to release: no window listeners or timers outlive the DOM */
    };
  },
};
