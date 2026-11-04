/**
 * Practice screen (`#/play/:id`) — SPEC.md section 8 "Practicar", including the "Resumen" view
 * that replaces the play view once the session phase is 'ended'.
 *
 * The screen owns the audio pipeline (MicInput -> MicDetectorSource, Metronome), the
 * PracticeSession, the HighwayRenderer and the rAF loop: every animation frame calls
 * session.update(), renders the highway and patches the HUD DOM only where something changed.
 * The shared AudioContext is created suspended at mount (MicDetectorSource reads its sample
 * rate) and resumed only from user gestures (Empezar / Reanudar / Probar micrófono),
 * synchronously before any await.
 *
 * Backing track (SPEC section 11 "Practicar"): when the song has audio and
 * `settings.backingTrack` is on, the file is loaded from IndexedDB at mount ("Cargando pista…";
 * Empezar waits for it, or goes on without it after a failure). The screen owns the track: on
 * every `phase === 'countin'` (start, resume, loop restart) it restarts the audio so that the
 * count-in start beat is heard at `session.wallSec(b)`; 'paused' / 'ended' stop it. The header
 * gets a "Pista" toggle and a volume slider (gain saved with the song, debounced).
 */
import './practice.css';
import type {
  AudioTrackInfo,
  ChordShape,
  ChordSymbol,
  LoopRange,
  Screen,
  SessionState,
  SessionSummary,
  Settings,
  Song,
  StrumEvent,
} from '../../types';
import { parseSong } from '../../song/parser';
import { getFlag, getSong, hasFlag, loadSettings, saveSettings, saveSong, setFlag } from '../../song/storage';
import { chordToleranceFor, levelDemandOf } from '../../song/levels';
import { createLevelSong, levelExists, levelFamily, levelSongIdOf, levelSpecOf } from '../../song/levelStore';
import { isSilent, settingsOfSound, soundOf, toggleMaster, toggleTrack, type SoundState } from '../../game/sound';
import { getTrack } from '../../song/audioStore';
import { beatToSec } from '../../song/tempo';
import { getChordShape } from '../../music/chords';
import { getAudioContext } from '../../audio/context';
import { MicError, MicInput } from '../../audio/mic';
import { MicDetectorSource, detectorOptsFromSettings } from '../../audio/micDetector';
import { Metronome } from '../../audio/metronome';
import { BackingTrack } from '../../audio/backing';
import { renderChordTrack } from '../../audio/chordSynth';
import { PracticeSession } from '../../game/engine';
import { HighwayRenderer, countInStartBeat, lowerBound, pxPerBeatFor, timingText } from '../highway';
import { drawChordDiagram } from '../chordDiagram';
import { append, clear, h } from '../dom';

// ------------------------------------------------------------------ constants

/** Speed selector values (percent of the written tempo). */
export const SPEED_OPTIONS: readonly number[] = [50, 60, 70, 80, 90, 100, 110, 120];
/** Debounce of the song save after a backing-track volume change. */
export const BACKING_SAVE_DELAY_MS = 300;
/** Shown next to the speed selector when the song has a backing track. */
export const SPEED_TITLE_WITH_TRACK = 'A menos velocidad la pista suena más grave';
/** Shown while the backing track is being loaded / when it failed. */
export const BACKING_LOADING_TEXT = 'Cargando pista…';
export const BACKING_FAILED_TEXT = 'No se pudo cargar la pista: se practica sin ella';
export const HEADPHONES_WARNING = 'Con la pista por altavoces el micrófono la oirá y la evaluación no será fiable: usa auriculares';
/** The summary shows the latency hint when |median timing| reaches this (seconds). */
export const LATENCY_HINT_MIN_SEC = 0.08;
/** The summary shows the low-input hint when missed / judged reaches this. */
export const LOW_INPUT_MISSED_RATIO = 0.5;
/** Without a saved flag, "Repetir" starts ON for songs without sections and up to this many bars. */
export const MAX_AUTO_LOOP_BARS = 8;
/** Input level bar range in dBFS. */
const LEVEL_MIN_DB = -80;
const LEVEL_MAX_DB = 0;
const LATENCY_MIN_SEC = -0.1;
const LATENCY_MAX_SEC = 0.5;

type MicStatusKind =
  | 'off'
  | 'inactive'
  | 'starting'
  | 'active'
  | 'denied'
  | 'notfound'
  | 'insecure'
  | 'unsupported'
  | 'device'
  | 'ended';

const MIC_STATUS_TEXT: Record<MicStatusKind, string> = {
  off: 'desactivado',
  inactive: 'inactivo (pulsa Empezar o Probar micrófono)',
  starting: 'conectando…',
  active: 'activo',
  denied: 'permiso denegado',
  notfound: 'sin dispositivo',
  insecure: 'no seguro (usa https/localhost)',
  unsupported: 'no disponible en este navegador',
  device: 'no se pudo acceder al micrófono',
  ended: 'la entrada se desconectó',
};
const MIC_ERROR_KINDS: readonly MicStatusKind[] = ['denied', 'notfound', 'insecure', 'unsupported', 'device', 'ended'];
const MIC_RETRY_KINDS: readonly MicStatusKind[] = ['denied', 'notfound', 'device', 'ended'];

/** Dismissing the calibration banner lasts for the page lifetime (it is not persisted). */
let bannerDismissed = false;

const noop = (): void => {};
/** Upper bound on waiting for AudioContext.resume() before starting/resuming the session. */
const RESUME_WAIT_MS = 1000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** How long Reanudar / Empezar wait for the microphone or the screen lock before going on without them. */
const SETUP_WAIT_MS = 2500;
/** `p`, or `fallback` when it takes longer than `ms`: a stuck permission prompt must never freeze the practice. */
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, delay(ms).then(() => fallback)]);

// ------------------------------------------------------------------ pure helpers

export interface SectionRun {
  /** Section label, or null for bars before the first `[Sección]`. */
  section: string | null;
  /** Inclusive bar indices. */
  fromBar: number;
  toBar: number;
}

/** Contiguous runs of bars sharing the same section label, in song order. */
export function sectionRuns(song: Pick<Song, 'bars'>): SectionRun[] {
  const runs: SectionRun[] = [];
  for (let i = 0; i < song.bars.length; i++) {
    const section = song.bars[i].section;
    const last = runs[runs.length - 1];
    if (last && last.section === section) last.toBar = i;
    else runs.push({ section, fromBar: i, toBar: i });
  }
  return runs;
}

/** "Estrofa (c. 5–12)" — label of a run in the "Sección" dropdown. */
export function sectionRunLabel(run: SectionRun): string {
  const name = run.section ?? 'Sin sección';
  return run.fromBar === run.toBar ? `${name} (c. ${run.fromBar + 1})` : `${name} (c. ${run.fromBar + 1}–${run.toBar + 1})`;
}

/** Written tempo (bpm) in effect at `beat` (the initial tempo before the first bar). */
export function bpmAt(song: Pick<Song, 'tempoSegments' | 'tempo'>, beat: number): number {
  let bpm = song.tempo;
  for (const seg of song.tempoSegments) {
    if (seg.fromBeat <= beat) bpm = seg.bpm;
    else break;
  }
  return bpm;
}

/** Nearest speed option (percent) for a tempoScale. */
export function nearestSpeed(tempoScale: number): number {
  const pct = Math.round(tempoScale * 10) * 10;
  return clamp(pct, SPEED_OPTIONS[0], SPEED_OPTIONS[SPEED_OPTIONS.length - 1]);
}

/**
 * Audio position (seconds into the file) that corresponds to song beat `beat`:
 * `audio.offsetSec + beatToSec(tempoSegments, beat)`. Negative during a count-in that starts
 * before the audio (BackingTrack.start then delays the source instead of seeking).
 */
export function backingPositionSec(audio: Pick<AudioTrackInfo, 'offsetSec'>, song: Pick<Song, 'tempoSegments'>, beat: number): number {
  return audio.offsetSec + beatToSec(song.tempoSegments, beat);
}

/** The headphones warning is shown when the track will play while the mic is evaluating. */
export function needsHeadphonesWarning(hasAudio: boolean, settings: Pick<Settings, 'backingTrack' | 'listen'>): boolean {
  return hasAudio && settings.backingTrack && settings.listen;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Index of the bar containing `beat` (0 before the first bar, last bar after the end). */
function barIndexAt(song: Pick<Song, 'bars'>, beat: number): number {
  let index = 0;
  for (let i = 0; i < song.bars.length; i++) {
    if (song.bars[i].startBeat <= beat) index = i;
    else break;
  }
  return index;
}

// ------------------------------------------------------------------ HUD cache

/** Last values written to the DOM; the rAF loop only touches the DOM when one changes. */
interface HudCache {
  phase: string;
  score: number;
  streak: number;
  passText: string;
  progressPct: number;
  levelPct: number;
  gatePct: number;
  below: boolean | null;
  chord: string;
  listening: boolean | null;
  current: string;
  next: string;
  lyric: number;
  tempo: string;
  headphones: boolean | null;
}

function freshHud(): HudCache {
  return {
    phase: '',
    score: -1,
    streak: -1,
    passText: '\0',
    progressPct: -1,
    levelPct: -1,
    gatePct: -1,
    below: null,
    chord: '\0',
    listening: null,
    current: '\0',
    next: '\0',
    lyric: -2,
    tempo: '',
    headphones: null,
  };
}

// ------------------------------------------------------------------ screen

export const practiceScreen: Screen = {
  mount(root: HTMLElement, params: Record<string, string>): () => void {
    const id = params.id ?? '';
    const stored = id ? getSong(id) : null;
    if (!stored) {
      location.replace('#/');
      return noop;
    }
    const { song } = parseSong(stored.source, { id });
    const shapes: Record<string, ChordShape | null> = {};
    for (const name of song.chordNames) shapes[name] = getChordShape(name);
    const lyricLines = song.lyricLines.slice().sort((a, b) => a.barIndex - b.barIndex);
    const runs = sectionRuns(song);
    const hasSections = song.bars.some((b) => b.section !== null);
    const playable = song.bars.length > 0;
    const loopFlag = `loop:${id}`;
    /** When this song is a learning level: what it demands (what counts as a hit / a mistake). */
    const levelDemand = levelDemandOf(id);

    // Effective settings of this screen: persisted values + the in-session toggles.
    let settings: Settings = loadSettings();
    settings = { ...settings, tempoScale: nearestSpeed(settings.tempoScale) / 100 };
    let loopOn = hasFlag(loopFlag) ? getFlag(loopFlag) : playable && !hasSections && song.bars.length <= MAX_AUTO_LOOP_BARS;
    /** Index into `runs`, or -1 for the whole song. */
    let selectedRun = -1;

    // Audio pipeline. The context is created suspended here and resumed only from gestures.
    const mic = new MicInput();
    mic.setInputGainDb(settings.inputGainDb);
    const source = new MicDetectorSource(mic, detectorOptsFromSettings(settings));
    source.setTranspose(song.capo + settings.tuningOffset);
    const ctx = getAudioContext();
    mic.setTimeBase(() => ctx.currentTime); // mic frames in the engine's clock (see MicInput.setTimeBase)
    const metronome = new Metronome(ctx);
    metronome.setEnabled(settings.metronome);
    const clock = { now: () => ctx.currentTime };
    const frameSeconds = mic.fftSize / ctx.sampleRate;

    let disposed = false;
    let starting = false;
    let ignoreEnded = false;
    let internalPause = false;
    let micStatus: MicStatusKind = settings.listen ? 'inactive' : 'off';
    let wakeLock: WakeLockSentinel | null = null;
    let hud = freshHud();
    let diagramsDirty = true;
    let raf = 0;

    // Backing track (metadata from the song; the file from IndexedDB, decoded on demand).
    let audio: AudioTrackInfo | null = stored.audio ?? null;
    let backing: BackingTrack | null = null;
    /** Pending / finished load; resolves true when `backing` is ready. Null before the first attempt or after a failure. */
    let backingLoad: Promise<boolean> | null = null;
    /** The last load failed: Empezar does not retry by itself (toggling "Pista" on does). */
    let backingFailed = false;
    let backingSaveTimer: number | null = null;
    // The synthesized "solo acordes" track is pure per song + a4, so it is rendered once and reused.
    let chordTrackBuffer: AudioBuffer | null = null;
    let chordTrackRender: Promise<AudioBuffer> | null = null;

    // ---------------------------------------------------------------- session

    let sessionUnsubs: Array<() => void> = [];

    function createSession(): PracticeSession {
      const s = new PracticeSession(song, { clock, clicks: metronome, detector: source, settings: { ...settings, chordTolerance: chordToleranceFor(levelDemand?.demand ?? null, settings.chordTolerance) }, shapes }, { frameSeconds });
      sessionUnsubs = [
        s.on('ended', ({ summary, reason }) => {
          if (!ignoreEnded && !disposed) showSummary(summary, reason);
        }),
        s.on('hit', (hit) => {
          if (disposed) return;
          const ev = song.events[hit.eventIndex];
          // A muted strike (✕) has no chord to name: only the timing counts.
          const chord = ev?.muted ? '✕' : ev?.chord.name ?? '';
          const ms = Math.round(hit.timing * 1000);
          const label = timingText(hit.timingLabel) || 'Detectado';
          feedbackVerdictEl.textContent = '';
          feedbackVerdictEl.className = 'practice-feedback-verdict';
          showFeedback(`${chord} · ${label} ${ms > 0 ? '+' : ''}${ms} ms`, null);
        }),
        s.on('verdict', (v) => {
          if (disposed) return;
          const ev = song.events[v.eventIndex];
          const chord = ev?.chord.name ?? '';
          if (v.kind === 'skipped') return;
          const text = ev?.muted
            ? v.kind === 'correct'
              ? '✓ golpe a tiempo'
              : '✗ sin golpe'
            : v.kind === 'correct'
              ? `✓ ${chord}`
              : v.kind === 'wrong'
                ? `✗ ${chord}: no coincide`
                : `✗ ${chord}: sin rasgueo`;
          showFeedback(null, { text, kind: v.kind });
        }),
        s.on('phase', (phase) => {
          // Internal pause/resume pairs (speed or section change) keep the wake lock.
          if (phase === 'ended' || (phase === 'paused' && !internalPause)) releaseWakeLock();
          // The backing track follows every count-in (start, resume, loop) and stops with the session.
          if (phase !== 'countin') silentCountIn = false;
          if (phase === 'countin') syncBacking(s);
          else if (phase === 'paused' || phase === 'ended') backing?.stop();
        }),
      ];
      return s;
    }

    function disposeSession(): void {
      ignoreEnded = true;
      session.stop();
      ignoreEnded = false;
      for (const u of sessionUnsubs) u();
      sessionUnsubs = [];
    }

    let session = createSession();

    function currentRange(): LoopRange {
      const run = runs[selectedRun];
      if (run) return { fromBar: run.fromBar, toBar: run.toBar };
      return { fromBar: 0, toBar: Math.max(0, song.bars.length - 1) };
    }

    function applyLoop(): void {
      session.setLoop(loopOn && playable ? currentRange() : null);
    }

    // ---------------------------------------------------------------- header

    const subtitleParts: string[] = [];
    if (song.artist) subtitleParts.push(song.artist);
    subtitleParts.push(`${song.timeSignature.beatsPerBar}/${song.timeSignature.beatUnit}`);
    if (song.capo > 0) subtitleParts.push(`cejilla ${song.capo}`);
    const titleEl = h('div.practice-title', { title: song.title || 'Sin título' }, song.title || 'Sin título', h('small', null, subtitleParts.join(' · ')));
    const tempoEl = h('span.practice-tempo');

    const speedSelect = h('select', {
      class: 'practice-select',
      'aria-label': 'Velocidad',
      title: audio ? SPEED_TITLE_WITH_TRACK : undefined,
      onchange: () => onSpeedChange(),
    });
    for (const pct of SPEED_OPTIONS) speedSelect.appendChild(h('option', { value: String(pct) }, `${pct} %`));
    speedSelect.value = String(nearestSpeed(settings.tempoScale));

    const metronomeToggle = h('input', { type: 'checkbox', checked: settings.metronome, onchange: () => onMetronomeChange() });
    const listenToggle = h('input', { type: 'checkbox', checked: settings.listen, onchange: () => void onListenChange() });
    const loopToggle = h('input', { type: 'checkbox', checked: loopOn, onchange: () => setLoop(loopToggle.checked) });

    // Backing-track controls: only when the song has audio.
    const backingToggle = h('input', { type: 'checkbox', checked: settings.backingTrack, onchange: () => void onBackingChange() });
    const backingVolume = h('input', {
      type: 'range',
      class: 'practice-volume',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(clamp(audio ? audio.gain : 0.8, 0, 1) * 100)),
      'aria-label': 'Volumen de la pista',
      title: 'Volumen de la pista',
      oninput: () => onBackingVolume(),
    });
    const backingStatusEl = h('span.practice-backing-status');
    const backingSourceSelect = h('select', {
      class: 'practice-select practice-backing-source',
      'aria-label': 'Qué suena en la pista',
      title: 'Qué suena en la pista: la grabación original o solo los acordes sintetizados',
      onchange: () => void onBackingSourceChange(),
    });
    backingSourceSelect.appendChild(h('option', { value: 'audio' }, 'Grabación original'));
    backingSourceSelect.appendChild(h('option', { value: 'chords' }, 'Solo acordes (simplificado)'));
    backingSourceSelect.value = settings.backingSource;
    // Fine sync: nudges the whole backing track (recording or chords) against the highway, in
    // 20 ms steps; applies from the next count-in. Saved globally (it compensates the device's
    // audio output delay, not one song).
    const nudgeLabel = h('span.practice-nudge-label');
    const showNudge = (): void => {
      const ms = Math.round(settings.backingNudgeSec * 1000);
      nudgeLabel.textContent = ms === 0 ? 'Sincronía 0 ms' : `Sincronía ${ms > 0 ? '+' : ''}${ms} ms`;
    };
    const nudgeBtn = (label: string, deltaSec: number, title: string): HTMLElement =>
      h('button', { class: 'btn practice-btn-small', type: 'button', title, onclick: () => onNudge(deltaSec) }, label);
    const nudgeRow = h(
      'span.practice-nudge',
      { title: 'Si la pista suena tarde respecto a la autopista, pulsa «Antes»; si suena pronto, «Después». Se aplica al reanudar.' },
      nudgeBtn('Pista antes', 0.02, 'La pista suena más pronto'),
      nudgeLabel,
      nudgeBtn('Pista después', -0.02, 'La pista suena más tarde'),
    );
    showNudge();
    const backingControls = audio
      ? h(
          'div.practice-backing',
          null,
          h('label.practice-toggle', { title: 'Reproducir la pista de la canción' }, backingToggle, 'Pista'),
          backingSourceSelect,
          backingVolume,
          nudgeRow,
          backingStatusEl,
        )
      : null;
    // Mic latency (same value Ajustes → Calibrar sets). If the strum is credited to the PREVIOUS
    // chord (or reads "Tarde"), add latency; if it is credited to the NEXT one ("Pronto"), remove it.
    const latencyLabel = h('span.practice-nudge-label');
    const showLatency = (): void => {
      latencyLabel.textContent = `Latencia ${Math.round(settings.latencySec * 1000)} ms`;
    };
    const latencyRow = h(
      'span.practice-nudge',
      { title: 'Retraso del micrófono. Si marca tu rasgueo en el acorde anterior o dice «Tarde», súbela; si lo marca en el siguiente o dice «Pronto», bájala.' },
      h('button', { class: 'btn practice-btn-small', type: 'button', onclick: () => onLatency(-0.02) }, '− 20 ms'),
      latencyLabel,
      h('button', { class: 'btn practice-btn-small', type: 'button', onclick: () => onLatency(0.02) }, '+ 20 ms'),
    );
    showLatency();
    const headphonesWarn = h('div.practice-headphones', { hidden: true }, HEADPHONES_WARNING);

    const micStatusEl = h('span.practice-mic-status');
    const micRetryBtn = h('button', { class: 'btn practice-btn-small', type: 'button', hidden: true, onclick: () => void enableListening() }, 'Reintentar');
    const levelFill = h('div.practice-level-fill');
    const levelGate = h('div.practice-level-gate', { title: 'Umbral de silencio' });
    const levelEl = h('div.practice-level', { title: 'Nivel de entrada' }, levelFill, levelGate);
    const liveChordEl = h('div.practice-chord-live', { title: 'Acorde detectado' }, '—');
    const noEvalBadge = h('span.badge.practice-badge', { hidden: true }, 'Sin evaluación');
    // Flashes on every strum the microphone detects, so a missed hit can be told apart: no flash = not heard,
    // flash but "Perdido" = heard but out of time.
    const hitDot = h('span.practice-hit', { title: 'Se enciende cada vez que el micrófono oye un golpe', 'aria-label': 'Golpe detectado' }, '●');
    let hitFlashTimer = 0;
    const unsubHit = source.onFrame((f) => {
      if (!f.onset) return;
      hitDot.classList.add('is-on');
      window.clearTimeout(hitFlashTimer);
      hitFlashTimer = window.setTimeout(() => hitDot.classList.remove('is-on'), 180);
    });
    const agcNotice = h('div.practice-agc', { hidden: true });

    let sectionSelect: HTMLSelectElement | null = null;
    if (hasSections) {
      sectionSelect = h('select', { class: 'practice-select', 'aria-label': 'Sección', onchange: () => onSectionChange() });
      sectionSelect.appendChild(h('option', { value: '-1' }, 'Toda la canción'));
      runs.forEach((run, i) => sectionSelect?.appendChild(h('option', { value: String(i) }, sectionRunLabel(run))));
      sectionSelect.value = '-1';
    }

    // Everything that is a setting lives in a modal; the bar on top only keeps what the player
    // needs while playing (title, tempo, the chord being heard) so the highway gets the screen.
    const settingsBtn = h(
      'button',
      { class: 'btn practice-settings-btn', type: 'button', title: 'Velocidad, metrónomo, pista, micrófono, secciones…', onclick: () => openSettings() },
      '⚙ Opciones',
    ) as HTMLButtonElement;
    const closeSettingsBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => settingsDialog.close() }, 'Listo');
    const settingsDialog = h(
      'dialog.practice-dialog',
      { 'aria-label': 'Opciones de práctica' },
      h('div.practice-dialog-body', null,
        h('h2', null, 'Opciones de práctica'),
        h('label.practice-field', null, 'Velocidad', speedSelect),
        h('label.practice-toggle', null, metronomeToggle, 'Metrónomo'),
        h('label.practice-toggle', { title: 'Atajo: L' }, loopToggle, 'Repetir'),
        sectionSelect ? h('label.practice-field', null, 'Sección', sectionSelect) : null,
        backingControls,
        h('label.practice-toggle', null, listenToggle, 'Escuchar con el micrófono'),
        h('div.practice-mic', null, h('span.practice-mic-label', null, 'Micrófono:'), micStatusEl, micRetryBtn, levelEl),
        latencyRow,
        h('div.practice-hint', null, 'Usa auriculares para que el micrófono no capte el metrónomo · ↓ rasgueo hacia abajo · ↑ hacia arriba'),
        headphonesWarn,
        agcNotice,
        h('div.practice-dialog-actions', null, closeSettingsBtn),
      ),
    ) as HTMLDialogElement;

    // ------------------------------------------------------------ sound buttons: 🔊 all · 🎵 song · 🎹 chords · 🥁 metronome
    // With the crossed speaker nothing sounds and the microphone listens without interference.
    let rememberedSound: SoundState | null = null;
    const soundBtn = (icon: string, title: string, onclick: () => void): HTMLButtonElement =>
      h('button', { class: 'practice-sound-btn', type: 'button', title, 'aria-label': title, onclick }, icon) as HTMLButtonElement;
    const masterBtn = soundBtn('🔊', 'Silenciar todo', () => void onMasterSound());
    const songBtn = soundBtn('🎵', 'La canción (grabación original)', () => void onTrackSound('song'));
    const chordsBtn = soundBtn('🎹', 'Los acordes sintetizados', () => void onTrackSound('chords'));
    const metroBtn = soundBtn('🥁', 'El metrónomo (un clic en cada pulso)', () => void onMetroSound());
    const soundGroup = h('div.practice-sound', { role: 'group', 'aria-label': 'Sonido' }, masterBtn, songBtn, chordsBtn, metroBtn);

    function currentSound(): SoundState {
      return soundOf(settings);
    }

    function refreshSoundButtons(): void {
      const s = currentSound();
      const silent = isSilent(s);
      masterBtn.textContent = silent ? '🔇' : '🔊';
      masterBtn.classList.toggle('is-muted', silent);
      masterBtn.setAttribute('aria-pressed', String(silent));
      masterBtn.title = silent ? 'Todo en silencio: el micrófono oye sin interferencias. Púlsalo para volver a oír' : 'Silenciar todo (sin canción, acordes ni metrónomo): el micrófono oye sin interferencias';
      const pairs: Array<[HTMLButtonElement, boolean]> = [[songBtn, s.song], [chordsBtn, s.chords], [metroBtn, s.metronome]];
      for (const [btn, on] of pairs) {
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
      songBtn.disabled = !audio;
      chordsBtn.disabled = !audio;
      songBtn.title = audio ? 'La canción (grabación original): ' + (s.song ? 'suena' : 'en silencio') : 'Esta canción no tiene audio';
      chordsBtn.title = audio ? 'Los acordes sintetizados: ' + (s.chords ? 'suenan' : 'en silencio') : 'Los acordes suenan junto a un audio: carga uno en el editor';
      metroBtn.title = 'El metrónomo: ' + (s.metronome ? 'suena' : 'en silencio');
    }

    /** Puts the sound in `next` through the same handlers the practice options use, so both always agree. */
    async function applySound(next: SoundState): Promise<void> {
      const cfg = settingsOfSound(next);
      if (cfg.metronome !== settings.metronome) {
        metronomeToggle.checked = cfg.metronome;
        onMetronomeChange();
      }
      if (audio) {
        if (cfg.backingTrack && cfg.backingSource !== settings.backingSource) {
          backingSourceSelect.value = cfg.backingSource;
          await onBackingSourceChange();
        }
        if (cfg.backingTrack !== settings.backingTrack) {
          backingToggle.checked = cfg.backingTrack;
          await onBackingChange();
        }
      }
      refreshSoundButtons();
    }

    async function onMasterSound(): Promise<void> {
      const r = toggleMaster(currentSound(), rememberedSound, { song: audio !== null, chords: false, metronome: true });
      rememberedSound = r.remember;
      await applySound(r.next);
    }

    async function onTrackSound(which: 'song' | 'chords'): Promise<void> {
      await applySound(toggleTrack(currentSound(), which));
    }

    async function onMetroSound(): Promise<void> {
      const s = currentSound();
      await applySound({ ...s, metronome: !s.metronome });
    }

    const header = h(
      'header.practice-header',
      null,
      titleEl,
      tempoEl,
      liveChordEl,
      hitDot,
      noEvalBadge,
      soundGroup,
      settingsBtn,
      settingsDialog,
    );

    // Level selector: [Completa 1 2 3 4] switches to that level's own song (created on the first use), and the
    // strip says what the level in use demands.
    const family = levelFamily(id);
    const levelBar = h('div.practice-levelbar', { role: 'group', 'aria-label': 'Nivel de aprendizaje' }, h('span.practice-levelbar-label', null, 'Nivel'));
    const levelMsg = h('span.practice-levelmsg', { role: 'status' });
    for (const n of [0, 1, 2, 3, 4]) {
      const exists = levelExists(family.baseId, n);
      levelBar.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: `practice-levelbtn${n === family.current ? ' is-active' : ''}${exists ? '' : ' is-missing'}`,
            'aria-pressed': n === family.current ? 'true' : 'false',
            title: `${n === 0 ? 'Canción completa' : `Nivel ${n}`}${exists ? '' : ' (aún no creado: se crea al elegirlo)'}`,
            onclick: () => void goLevel(n),
          },
          n === 0 ? 'Completa' : String(n),
        ),
      );
    }

    async function goLevel(n: number): Promise<void> {
      if (n === family.current) return;
      const target = levelSongIdOf(family.baseId, n);
      if (!getSong(target)) {
        const spec = levelSpecOf(n);
        if (!spec) {
          levelMsg.textContent = 'No encuentro la canción completa.';
          return;
        }
        levelMsg.textContent = 'Creando el nivel…';
        const r = await createLevelSong(family.baseId, spec);
        if (!r.ok && !getSong(target)) {
          levelMsg.textContent = r.message;
          return;
        }
      }
      location.hash = `#/play/${target}`;
    }

    const levelStrip = h('div.practice-demand', null, levelBar);
    // (What each level counts as a hit is explained in the editor's level dialog, not here: the row stays one line.)
    levelStrip.appendChild(levelMsg);

    for (const el of [metronomeToggle, backingToggle, backingSourceSelect]) el.addEventListener('change', () => refreshSoundButtons());
    refreshSoundButtons();

    function openSettings(): void {
      const phase = session.getState().phase;
      if (phase === 'countin' || phase === 'playing') session.pause();
      if (!settingsDialog.open) settingsDialog.showModal();
    }

    let banner: HTMLElement | null = null;
    if (!getFlag('latencyCalibrated') && !bannerDismissed) {
      banner = h(
        'div.practice-banner',
        null,
        h('span', null, 'Primera vez con micrófono: calibra la latencia (unos 10 s) para que “a tiempo” sea a tiempo.'),
        h('a', { class: 'btn practice-btn-small', href: '#/settings' }, 'Calibrar'),
        h(
          'button',
          {
            class: 'btn practice-btn-small',
            type: 'button',
            title: 'Cerrar',
            'aria-label': 'Cerrar aviso',
            onclick: () => {
              bannerDismissed = true;
              banner?.remove();
              banner = null;
            },
          },
          '✕',
        ),
      );
    }

    // ---------------------------------------------------------------- diagrams / stage / footer

    const currentCanvas = h('canvas', { class: 'practice-diagram-canvas' });
    const nextCanvas = h('canvas', { class: 'practice-diagram-canvas' });
    const currentDiagram = h('div.practice-diagram.current', null, currentCanvas);
    const diagrams = h(
      'div.practice-diagrams',
      null,
      currentDiagram,
      h('div.practice-diagram.next', null, h('div.practice-diagram-label', null, 'Siguiente'), nextCanvas),
    );

    const canvas = h('canvas', { class: 'practice-canvas' });
    const startBtn = h('button', { class: 'btn btn-primary practice-start', type: 'button', disabled: !playable, onclick: () => void doStart() }, 'Empezar');
    const testMicBtn = h('button', { class: 'btn', type: 'button', onclick: () => void enableListening() }, 'Probar micrófono');
    const overlayMsg = h('div.practice-overlay-msg');
    const overlay = h('div.practice-overlay', null, startBtn, h('div.practice-overlay-hint', null, 'o pulsa Espacio'), testMicBtn, overlayMsg);
    if (!playable) overlayMsg.textContent = 'La canción no tiene compases válidos: edítala desde la biblioteca.';
    const pausedLabel = h('div.practice-paused-label', { hidden: true }, 'Pausa', h('small', null, 'arrastra la autopista (o ← →) para moverte · toca para reanudar'));
    // Read-out of the last strum ("C · Tarde +180 ms" then "✓ C"), shown in the level row.
    const feedbackTimingEl = h('div.practice-feedback-timing');
    const feedbackVerdictEl = h('div.practice-feedback-verdict');
    const feedbackEl = h('div.practice-feedback', { hidden: true }, feedbackTimingEl, feedbackVerdictEl);
    levelStrip.insertBefore(feedbackEl, levelBar.nextSibling); // right of the level selector, never over the highway or the chord drawing
    let feedbackTimer: number | null = null;
    function showFeedback(timing: string | null, verdict: { text: string; kind: string } | null): void {
      if (timing !== null) feedbackTimingEl.textContent = timing;
      if (verdict) {
        feedbackVerdictEl.textContent = verdict.text;
        feedbackVerdictEl.className = `practice-feedback-verdict is-${verdict.kind}`;
      }
      feedbackEl.hidden = false;
      if (feedbackTimer !== null) clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => {
        feedbackEl.hidden = true;
        feedbackTimingEl.textContent = '';
        feedbackVerdictEl.textContent = '';
      }, 1300);
    }
    const stage = h('div.practice-stage', null, canvas, overlay, pausedLabel);
    // Scrubbing while paused: drag the highway sideways (or use the bar buttons / ← →) to pick the
    // bar to practise again. Snaps to whole bars because resume() replays a bar in full anyway.
    let dragStartX: number | null = null;
    let dragStartBeat = 0;
    let dragged = false;
    canvas.addEventListener('pointerdown', (e) => {
      const st = session.getState();
      if (st.phase !== 'paused' && st.phase !== 'idle') return;
      dragStartX = e.clientX;
      dragStartBeat = st.beat;
      dragged = false;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragStartX === null) return;
      const dx = e.clientX - dragStartX;
      if (!dragged && Math.abs(dx) < 8) return;
      dragged = true;
      const beat = dragStartBeat - dx / pxPerBeatFor(canvas.clientWidth || 1);
      seekToBar(barIndexAt(song, Math.max(0, beat)));
    });
    const endDrag = (): void => {
      dragStartX = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('click', () => {
      if (dragged) {
        dragged = false; // the drag that just ended is not a tap
        return;
      }
      onCanvasTap();
    });

    const lyricsCurrent = h('div.practice-lyrics-current');
    const lyricsNext = h('div.practice-lyrics-next');
    const lyrics = h('div.practice-lyrics', { hidden: lyricLines.length === 0 }, lyricsCurrent, lyricsNext);

    const scoreEl = h('b');
    const streakEl = h('b');
    const passEl = h('span.practice-stat', { hidden: true });
    const progressFill = h('div.practice-progress-fill');
    const pauseBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => togglePause() }, 'Pausa');
    const prevBarBtn = h('button', { class: 'btn', type: 'button', hidden: true, title: 'Compás anterior (←)', onclick: () => seekRelative(-1) }, '◀ Compás');
    const nextBarBtn = h('button', { class: 'btn', type: 'button', hidden: true, title: 'Compás siguiente (→)', onclick: () => seekRelative(1) }, 'Compás ▶');
    const restartBtn = h('button', { class: 'btn', type: 'button', disabled: true, title: 'Atajo: R', onclick: () => void restart() }, 'Reiniciar');
    const exitBtn = h('button', { class: 'btn', type: 'button', title: 'Atajo: Esc', onclick: () => exit() }, 'Salir');
    const footer = h(
      'footer.practice-footer',
      null,
      h('span.practice-stat', null, 'Puntos', scoreEl),
      h('span.practice-stat', null, 'Racha', streakEl),
      passEl,
      h('div.practice-progress', { title: 'Progreso' }, progressFill),
      h('div.practice-footer-buttons', null, prevBarBtn, pauseBtn, nextBarBtn, restartBtn, exitBtn),
    );

    const playView = h(
      'div.practice-play',
      null,
      header,
      levelStrip,
      banner,
      h('main.practice-main', null, diagrams, h('div.practice-right', null, stage, lyrics)),
      footer,
    );
    const summaryEl = h('section.practice-summary', { hidden: true });
    const rootEl = h('section.practice', null, playView, summaryEl);
    root.appendChild(rootEl);

    const renderer = new HighwayRenderer(canvas, song, shapes, settings);
    setMicStatus(micStatus);

    // ---------------------------------------------------------------- mic

    function setMicStatus(kind: MicStatusKind): void {
      micStatus = kind;
      const isError = MIC_ERROR_KINDS.includes(kind);
      micStatusEl.textContent = MIC_STATUS_TEXT[kind];
      micStatusEl.classList.toggle('is-error', isError);
      settingsBtn.classList.toggle('has-alert', isError);
      micRetryBtn.hidden = !MIC_RETRY_KINDS.includes(kind);
      testMicBtn.hidden = kind === 'active' || kind === 'starting';
      if (playable) {
        if (isError) overlayMsg.textContent = `Micrófono: ${MIC_STATUS_TEXT[kind]}. Se practicará sin evaluación.`;
        else if (kind === 'starting') overlayMsg.textContent = 'Conectando el micrófono…';
        else overlayMsg.textContent = '';
      }
    }

    function micStatusFromError(err: unknown): MicStatusKind {
      if (err instanceof MicError) {
        switch (err.code) {
          case 'denied':
            return 'denied';
          case 'notfound':
            return 'notfound';
          case 'insecure':
            return 'insecure';
          case 'unsupported':
            return 'unsupported';
          default:
            return 'device';
        }
      }
      return 'device';
    }

    /** Resumes the context (synchronously) and starts the mic. Resolves false (status set) on failure. */
    async function startMic(): Promise<boolean> {
      void ctx.resume().catch(noop);
      setMicStatus('starting');
      try {
        await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
      } catch (err) {
        if (!disposed) setMicStatus(micStatusFromError(err));
        return false;
      }
      if (disposed) {
        mic.stop();
        return false;
      }
      setMicStatus('active');
      updateAgcNotice();
      return true;
    }

    // Watchdog: the capture context can be suspended behind our back (tab switch, phone call, headphones plugged
    // in) and the track can end; either way the meter freezes and nothing is heard. Resume / restart quietly.
    let watchSince = 0;
    let restarting = false;
    function watchMic(micOn: boolean): void {
      if (disposed || restarting || !settings.listen || session.getState().phase !== 'playing') return;
      const now = performance.now();
      const healthy = micOn && mic.context.state === 'running';
      if (healthy) {
        watchSince = 0;
        return;
      }
      if (watchSince === 0) watchSince = now;
      if (now - watchSince < 800) return;
      watchSince = 0;
      restarting = true;
      void (async () => {
        try {
          if (micOn) await mic.context.resume().catch(noop);
          else await startMic();
        } finally {
          restarting = false;
        }
      })();
    }

    /** "Probar micrófono" / "Reintentar": starts the mic and turns listening on when it works. */
    async function enableListening(): Promise<void> {
      const ok = await startMic();
      if (disposed) return;
      settings = { ...settings, listen: ok };
      listenToggle.checked = ok;
      session.setSettings({ listen: ok });
    }

    function updateAgcNotice(): void {
      const ts = mic.getTrackSettings();
      if (!ts) {
        agcNotice.hidden = true;
        return;
      }
      const active: string[] = [];
      if (ts.autoGainControl !== false) active.push('control automático de ganancia');
      if (ts.noiseSuppression !== false) active.push('supresión de ruido');
      // Echo cancellation is only unexpected when the user did not ask for it (Ajustes).
      if (ts.echoCancellation !== false && !settings.echoCancellation) active.push('cancelación de eco');
      if (active.length === 0) {
        agcNotice.hidden = true;
        return;
      }
      agcNotice.textContent = `Aviso: el navegador mantiene ${active.join(', ')} en el micrófono; la detección puede ser menos fiable.`;
      agcNotice.hidden = false;
    }

    // ---------------------------------------------------------------- wake lock

    async function requestWakeLock(): Promise<void> {
      try {
        const api = navigator.wakeLock;
        if (!api || typeof api.request !== 'function') return;
        if (wakeLock && !wakeLock.released) return;
        wakeLock = await api.request('screen');
      } catch {
        wakeLock = null;
      }
    }

    function releaseWakeLock(): void {
      const w = wakeLock;
      wakeLock = null;
      if (w && !w.released) w.release().catch(noop);
    }

    // ---------------------------------------------------------------- backing track

    function setBackingStatus(text: string, isError = false): void {
      backingStatusEl.textContent = text;
      backingStatusEl.classList.toggle('is-error', isError);
    }

    /** Renders (once) the synthesized chords-only track for this song, cached for reuse. */
    function ensureChordTrackRendered(): Promise<AudioBuffer> {
      if (chordTrackBuffer) return Promise.resolve(chordTrackBuffer);
      if (chordTrackRender) return chordTrackRender;
      const render = renderChordTrack(song, ctx.sampleRate)
        .then((buffer) => {
          chordTrackBuffer = buffer;
          return buffer;
        })
        .finally(() => {
          chordTrackRender = null;
        });
      chordTrackRender = render;
      return render;
    }

    /**
     * Loads (once) the current backing source into a BackingTrack: either the song's uploaded
     * audio file, or the synthesized chords-only track (settings.backingSource). Never rejects:
     * resolves true when the track is ready, false when the song has no audio, the load failed or
     * the screen was unmounted meanwhile. Decoding/rendering both work on the suspended context.
     */
    function ensureBackingLoaded(): Promise<boolean> {
      if (!audio) return Promise.resolve(false);
      if (backingLoad) return backingLoad;
      const info = audio;
      const useChords = settings.backingSource === 'chords';
      setBackingStatus(BACKING_LOADING_TEXT);
      const load = (async (): Promise<boolean> => {
        let track: BackingTrack | null = null;
        try {
          track = new BackingTrack(ctx);
          if (useChords) {
            const buffer = await ensureChordTrackRendered();
            if (disposed) {
              track.dispose();
              return false;
            }
            track.loadBuffer(buffer);
          } else {
            const blob = await getTrack(id);
            if (disposed) return false;
            if (!blob) throw new Error('No se encontró el archivo de audio en este navegador');
            await track.load(blob);
            if (disposed) {
              track.dispose();
              return false;
            }
          }
          track.setGain(info.gain);
          backing = track;
          backingFailed = false;
          setBackingStatus('');
          return true;
        } catch (err) {
          track?.dispose();
          backingFailed = true;
          backingLoad = null; // toggling "Pista" on again retries
          if (!disposed) {
            console.warn('No se pudo cargar la pista de audio', err);
            // Append the real reason (e.g. "No se encontró el archivo de audio…" vs a decode
            // error) so a phone user can tell a lost file from an unsupported format.
            const reason = err instanceof Error && err.message ? ` (${err.message})` : '';
            setBackingStatus(BACKING_FAILED_TEXT + reason, true);
          }
          return false;
        }
      })();
      backingLoad = load;
      return load;
    }

    /** "Grabación original" / "Solo acordes": switches the backing source and reloads it if playing. */
    async function onBackingSourceChange(): Promise<void> {
      const source = backingSourceSelect.value === 'chords' ? 'chords' : 'audio';
      if (source === settings.backingSource) return;
      settings = { ...settings, backingSource: source };
      saveSettings({ backingSource: source });
      backing?.dispose();
      backing = null;
      backingLoad = null;
      if (!settings.backingTrack) return;
      backingFailed = false;
      void ctx.resume().catch(noop);
      const ok = await ensureBackingLoaded();
      if (!ok || disposed || !backingToggle.checked) return;
      const phase = session.getState().phase;
      if (phase === 'countin' || phase === 'playing') syncBacking(session);
    }

    /**
     * Restarts the audio so that the bar's first beat (after the count-in) is heard at its wall time. The
     * synthesized chords track has no independent alignment offset (its sample 0 IS song beat 0),
     * unlike the uploaded recording (audio.offsetSec, set by "Sincronizar" in the editor).
     */
    let silentCountIn = false;

    function syncBacking(s: PracticeSession): void {
      if (!backing || !audio || !settings.backingTrack) return;
      const st = s.getState();
      // The very first count-in of a run (Empezar / Reiniciar) is clicks only: the music enters on
      // the downbeat of the bar being practised. Every other count-in (resume after a pause or a
      // bar jump, loop restart) keeps the music playing underneath from the count-in's first beat,
      // so it does not burst in from silence. Mid-pass calls (toggling the track, changing source)
      // also restart from the pass anchor; everything is aligned by wall time.
      const b = st.phase === 'countin' && silentCountIn ? countInStartBeat(st.beat, st.countInBeatsLeft) : st.countInStartBeat;
      const posSec = settings.backingSource === 'chords' ? beatToSec(song.tempoSegments, b) : backingPositionSec(audio, song, b);
      backing.stop();
      backing.start(s.wallSec(b), posSec + settings.backingNudgeSec, settings.tempoScale);
    }

    /** "Pista" toggle: persists the setting and starts/stops the audio in the middle of a pass. */
    async function onBackingChange(): Promise<void> {
      const on = backingToggle.checked;
      settings = { ...settings, backingTrack: on };
      saveSettings({ backingTrack: on });
      if (!on) {
        backing?.stop();
        return;
      }
      void ctx.resume().catch(noop); // gesture: the track may start right away
      if (!backing) {
        backingFailed = false;
        const ok = await ensureBackingLoaded();
        if (!ok || disposed || !backingToggle.checked) return;
      }
      const phase = session.getState().phase;
      if (phase === 'countin' || phase === 'playing') syncBacking(session);
    }

    function onLatency(deltaSec: number): void {
      const next = clamp(Math.round((settings.latencySec + deltaSec) * 1000) / 1000, -0.1, 0.5);
      settings = { ...settings, latencySec: next };
      saveSettings({ latencySec: next });
      session.setSettings({ latencySec: next });
      showLatency();
    }

    function onNudge(deltaSec: number): void {
      const next = clamp(Math.round((settings.backingNudgeSec + deltaSec) * 1000) / 1000, -0.5, 0.5);
      settings = { ...settings, backingNudgeSec: next };
      saveSettings({ backingNudgeSec: next });
      showNudge();
    }

    function onBackingVolume(): void {
      if (!audio) return;
      const pct = clamp(Math.round(Number(backingVolume.value)), 0, 100);
      if (!Number.isFinite(pct)) return;
      const gain = pct / 100;
      if (gain === audio.gain) return;
      audio = { ...audio, gain };
      backing?.setGain(gain);
      if (backingSaveTimer !== null) clearTimeout(backingSaveTimer);
      backingSaveTimer = window.setTimeout(() => {
        backingSaveTimer = null;
        flushBackingSave();
      }, BACKING_SAVE_DELAY_MS);
    }

    /** Writes the pending gain change to the song (explicit `audio`, so the track metadata is kept). */
    function flushBackingSave(): void {
      if (backingSaveTimer !== null) {
        clearTimeout(backingSaveTimer);
        backingSaveTimer = null;
      }
      if (!audio || !stored || stored.builtin) return;
      if (stored.audio && stored.audio.gain === audio.gain) return;
      saveSong({ ...stored, audio: { ...audio } });
      stored.audio = { ...audio };
    }

    // ---------------------------------------------------------------- controls

    /** "Empezar": resume the context, start the mic if listening, wake lock, then the session. */
    async function doStart(): Promise<void> {
      if (starting || disposed || !playable || session.getState().phase !== 'idle') return;
      starting = true;
      startBtn.disabled = true;
      try {
        // Synchronously, before any await (iOS). The promise is awaited (bounded) below so the
        // session never starts against a still-suspended context (the rAF guard would pause it).
        const resumed = ctx.resume().catch(noop);
        if (settings.listen) {
          const ok = await withTimeout(startMic(), SETUP_WAIT_MS, true);
          if (disposed) return;
          if (!ok) {
            settings = { ...settings, listen: false };
            listenToggle.checked = false;
            session.setSettings({ listen: false });
          }
        }
        // The backing track must be decoded before the count-in starts (or we go on without it).
        if (audio && settings.backingTrack && !backingFailed) {
          await ensureBackingLoaded();
          if (disposed) return;
        }
        await withTimeout(requestWakeLock(), 1000, undefined);
        await Promise.race([resumed, delay(RESUME_WAIT_MS)]);
        if (disposed || session.getState().phase !== 'idle') return;
        const run = runs[selectedRun];
        if (run) session.seekBar(run.fromBar);
        applyLoop();
        silentCountIn = true; // read synchronously by the 'countin' phase handler inside start()
        session.start();
      } finally {
        starting = false;
        startBtn.disabled = !playable;
      }
    }

    /** "Reanudar": always from a gesture — context, mic (if its track ended), wake lock, resume. */
    async function doResume(): Promise<void> {
      if (starting || disposed || session.getState().phase !== 'paused') return;
      starting = true;
      try {
        const resumed = ctx.resume().catch(noop);
        if (settings.listen && !mic.isRunning()) {
          // Bounded: if the microphone does not answer, practise anyway (the watchdog keeps trying) instead of
          // leaving the Reanudar button dead.
          const ok = await withTimeout(startMic(), SETUP_WAIT_MS, true);
          if (disposed) return;
          if (!ok) {
            settings = { ...settings, listen: false };
            listenToggle.checked = false;
            session.setSettings({ listen: false });
          }
        }
        await withTimeout(requestWakeLock(), 1000, undefined);
        await Promise.race([resumed, delay(RESUME_WAIT_MS)]);
        if (disposed || session.getState().phase !== 'paused') return;
        session.resume();
      } finally {
        starting = false;
      }
    }

    function togglePause(): void {
      const phase = session.getState().phase;
      if (phase === 'idle') void doStart();
      else if (phase === 'countin' || phase === 'playing') session.pause();
      else if (phase === 'paused') void doResume();
      else if (phase === 'ended') void restart();
    }

    /** Moves the paused/idle position to bar `n` (kept inside the loop section when looping). */
    function seekToBar(n: number): void {
      const st = session.getState();
      if (st.phase !== 'paused' && st.phase !== 'idle') return;
      const lo = st.loop ? st.loop.fromBar : 0;
      const hi = st.loop ? st.loop.toBar : song.bars.length - 1;
      const bar = clamp(n, lo, hi);
      if (bar !== barIndexAt(song, st.beat)) session.seekBar(bar);
    }

    function seekRelative(delta: number): void {
      const st = session.getState();
      seekToBar(barIndexAt(song, Math.max(0, st.beat)) + delta);
    }

    function onCanvasTap(): void {
      const phase = session.getState().phase;
      if (phase === 'countin' || phase === 'playing') session.pause();
      else if (phase === 'paused') void doResume();
    }

    async function restart(): Promise<void> {
      if (starting || disposed) return;
      disposeSession();
      session = createSession();
      const run = runs[selectedRun];
      if (run) session.seekBar(run.fromBar);
      applyLoop();
      showPlayView();
      await doStart();
    }

    function exit(): void {
      const phase = session.getState().phase;
      if (phase === 'idle' || phase === 'ended') {
        location.hash = '#/';
        return;
      }
      session.stop(); // -> 'ended' -> Resumen
    }

    function onSpeedChange(): void {
      const tempoScale = clamp(Number(speedSelect.value) / 100, 0.5, 1.2);
      const phase = session.getState().phase;
      const playing = phase === 'countin' || phase === 'playing';
      if (playing) pauseInternally();
      saveSettings({ tempoScale });
      settings = { ...settings, tempoScale };
      session.setSettings({ tempoScale });
      if (playing) session.resume();
    }

    /** pause() for an immediate internal resume (speed/section change): keeps the wake lock. */
    function pauseInternally(): void {
      internalPause = true;
      try {
        session.pause();
      } finally {
        internalPause = false;
      }
    }

    function onMetronomeChange(): void {
      const on = metronomeToggle.checked;
      settings = { ...settings, metronome: on };
      session.setSettings({ metronome: on });
      metronome.setEnabled(on);
    }

    async function onListenChange(): Promise<void> {
      const on = listenToggle.checked;
      if (on) {
        await enableListening();
        return;
      }
      settings = { ...settings, listen: false };
      session.setSettings({ listen: false });
      mic.stop();
      agcNotice.hidden = true;
      setMicStatus('off');
    }

    function setLoop(on: boolean): void {
      loopOn = on;
      loopToggle.checked = on;
      setFlag(loopFlag, on);
      applyLoop();
    }

    function onSectionChange(): void {
      if (!sectionSelect) return;
      selectedRun = Number(sectionSelect.value);
      const phase = session.getState().phase;
      if (phase === 'ended') return;
      const playing = phase === 'countin' || phase === 'playing';
      if (playing) pauseInternally();
      const run = runs[selectedRun];
      session.seekBar(run ? run.fromBar : 0);
      applyLoop();
      if (playing) session.resume();
    }

    // ---------------------------------------------------------------- keyboard / visibility

    const onKeyDown = (e: KeyboardEvent): void => {
      if (settingsDialog.open) return; // the dialog owns the keyboard (Esc closes it, not the screen)
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (inField) target?.blur();
        else exit();
        return;
      }
      if (inField) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && session.getState().phase === 'paused') {
        e.preventDefault();
        seekRelative(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void restart();
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setLoop(!loopOn);
      }
    };
    const pauseIfPlaying = (): void => {
      const phase = session.getState().phase;
      if (phase === 'countin' || phase === 'playing') session.pause();
    };
    const onVisibility = (): void => {
      if (document.hidden) pauseIfPlaying();
    };
    const onCtxState = (): void => {
      if (ctx.state !== 'running') pauseIfPlaying();
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);
    ctx.addEventListener('statechange', onCtxState);

    // ---------------------------------------------------------------- resize

    const onResize = (): void => {
      renderer.resize();
      diagramsDirty = true;
    };
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (resizeObserver) {
      resizeObserver.observe(stage);
      resizeObserver.observe(diagrams);
    } else {
      window.addEventListener('resize', onResize);
    }

    // ---------------------------------------------------------------- HUD

    function chordPair(state: SessionState): { current: StrumEvent | null; next: StrumEvent | null } {
      const events = song.events;
      const n = events.length;
      if (n === 0) return { current: null, next: null };
      let ci: number;
      if (state.phase === 'countin') {
        // During the count-in show the first chord of the bar about to be played.
        ci = lowerBound(events, countInStartBeat(state.beat, state.countInBeatsLeft));
      } else {
        ci = Math.max(state.nextEventIndex - 1, 0);
      }
      if (ci >= n) ci = n - 1;
      const current = events[ci];
      let next: StrumEvent | null = null;
      for (let j = Math.max(state.nextEventIndex, ci + 1); j < n; j++) {
        const e = events[j];
        if (e.chordChange && e.chord.name !== current.chord.name) {
          next = e;
          break;
        }
      }
      return { current, next };
    }

    function drawDiagramOn(cv: HTMLCanvasElement, chord: ChordSymbol | null, muted: boolean): void {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const hgt = cv.clientHeight;
      if (w <= 0 || hgt <= 0) return;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(hgt * dpr));
      const c = cv.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, hgt);
      if (!chord) return;
      if (chord.quality === 'nc') {
        c.font = `bold ${Math.round(clamp(Math.min(hgt * 0.16, w * 0.22), 12, 28))}px system-ui, sans-serif`;
        c.fillStyle = '#94a3b8';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('N.C.', w / 2, hgt / 2);
        return;
      }
      // Keep an upright chord-box shape (about 4:5) centred in the canvas instead of stretching it to fill.
      const boxW = Math.min(w, hgt * 0.8);
      drawChordDiagram(c, shapes[chord.name] ?? null, { x: (w - boxW) / 2, y: 0, w: boxW, h: hgt }, { title: chord.name, showFingers: true, muted });
    }

    function progressRange(state: SessionState): { from: number; to: number } {
      const loop = state.loop;
      if (loop) {
        const a = song.bars[loop.fromBar];
        const z = song.bars[loop.toBar];
        if (a && z) return { from: a.startBeat, to: z.startBeat + z.beats };
      }
      return { from: 0, to: song.totalBeats };
    }

    function updateHud(state: SessionState): void {
      const phase = state.phase;
      if (phase !== hud.phase) {
        hud.phase = phase;
        overlay.hidden = phase !== 'idle';
        pausedLabel.hidden = phase !== 'paused';
        prevBarBtn.hidden = phase !== 'paused';
        nextBarBtn.hidden = phase !== 'paused';
        pauseBtn.textContent = phase === 'paused' ? 'Reanudar' : 'Pausa';
        pauseBtn.disabled = phase === 'idle';
        restartBtn.disabled = phase === 'idle';
      }
      if (state.score !== hud.score) {
        hud.score = state.score;
        scoreEl.textContent = String(state.score);
      }
      if (state.streak !== hud.streak) {
        hud.streak = state.streak;
        streakEl.textContent = String(state.streak);
      }
      const passText = state.loop ? `Pasada ${state.pass}` : '';
      if (passText !== hud.passText) {
        hud.passText = passText;
        passEl.textContent = passText;
        passEl.hidden = passText === '';
      }

      const range = progressRange(state);
      const span = range.to - range.from;
      const frac = span > 0 ? clamp((state.beat - range.from) / span, 0, 1) : 0;
      const progressPct = Math.round(frac * 200) / 2;
      if (progressPct !== hud.progressPct) {
        hud.progressPct = progressPct;
        progressFill.style.width = `${progressPct}%`;
      }

      const micOn = mic.isRunning();
      if (micStatus === 'active' && !micOn) setMicStatus('ended');
      watchMic(micOn);
      const rms = micOn ? state.live.rmsDb : LEVEL_MIN_DB;
      const levelPct = Math.round(clamp((rms - LEVEL_MIN_DB) / (LEVEL_MAX_DB - LEVEL_MIN_DB), 0, 1) * 100);
      if (levelPct !== hud.levelPct) {
        hud.levelPct = levelPct;
        levelFill.style.width = `${levelPct}%`;
      }
      const gatePct = Math.round(clamp((state.live.gateDb - LEVEL_MIN_DB) / (LEVEL_MAX_DB - LEVEL_MIN_DB), 0, 1) * 100);
      if (gatePct !== hud.gatePct) {
        hud.gatePct = gatePct;
        levelGate.style.left = `${gatePct}%`;
      }
      const below = rms < state.live.gateDb;
      if (below !== hud.below) {
        hud.below = below;
        levelFill.classList.toggle('below', below);
      }
      const chord = micOn && state.live.bestChord ? state.live.bestChord.name : '—';
      if (chord !== hud.chord) {
        hud.chord = chord;
        liveChordEl.textContent = chord;
      }
      const listening = state.live.listening;
      if (listening !== hud.listening) {
        hud.listening = listening;
        noEvalBadge.hidden = listening;
      }
      const headphones = needsHeadphonesWarning(audio !== null, settings);
      if (headphones !== hud.headphones) {
        hud.headphones = headphones;
        headphonesWarn.hidden = !headphones;
      }

      const bpm = bpmAt(song, Math.max(0, state.beat));
      const scale = settings.tempoScale;
      const tempo = scale === 1 ? `${Math.round(bpm)} bpm` : `${Math.round(bpm)} → ${Math.round(bpm * scale)} bpm`;
      if (tempo !== hud.tempo) {
        hud.tempo = tempo;
        tempoEl.textContent = tempo;
      }

      const pair = chordPair(state);
      const currentKey = pair.current ? `${pair.current.chord.name}|${pair.current.muted ? 'x' : ''}` : '';
      const nextKey = pair.next ? pair.next.chord.name : '';
      if (diagramsDirty || currentKey !== hud.current || nextKey !== hud.next) {
        diagramsDirty = false;
        hud.current = currentKey;
        hud.next = nextKey;
        drawDiagramOn(currentCanvas, pair.current ? pair.current.chord : null, pair.current ? pair.current.muted : false);
        drawDiagramOn(nextCanvas, pair.next ? pair.next.chord : null, false);
      }

      if (lyricLines.length > 0) {
        const bar = barIndexAt(song, state.beat);
        let li = -1;
        for (let k = 0; k < lyricLines.length; k++) {
          if (lyricLines[k].barIndex <= bar) li = k;
          else break;
        }
        if (li !== hud.lyric) {
          hud.lyric = li;
          lyricsCurrent.textContent = li >= 0 ? lyricLines[li].text : '';
          const nextLine = lyricLines[li + 1];
          lyricsNext.textContent = nextLine ? nextLine.text : '';
        }
      }
    }

    // ---------------------------------------------------------------- summary view

    function showPlayView(): void {
      summaryEl.hidden = true;
      playView.hidden = false;
      hud = freshHud();
      diagramsDirty = true;
      renderer.resize();
    }

    function showSummary(summary: SessionSummary, reason: 'finished' | 'stopped'): void {
      releaseWakeLock();
      clear(summaryEl);
      const judged = summary.total - summary.skipped;
      const missedRatio = judged > 0 ? summary.missed / judged : 0;
      const median = summary.medianTimingSec;

      const stat = (label: string, value: string): HTMLElement =>
        h('div.practice-summary-stat', null, h('div.practice-summary-label', null, label), h('div.practice-summary-value', null, value));

      const accuracyStat = h(
        'div.practice-summary-stat.accuracy',
        null,
        h('div.practice-summary-label', null, 'Precisión'),
        judged === 0
          ? h('div.practice-summary-value.small', null, 'Sesión sin evaluación (micrófono desactivado)')
          : h('div.practice-summary-value', null, `${Math.round(summary.accuracy * 100)} %`),
        judged > 0 ? h('div.practice-summary-detail', null, `${summary.correct} bien · ${summary.wrong} mal · ${summary.missed} perdidos`) : null,
      );

      const names = song.chordNames.slice();
      for (const name of Object.keys(summary.perChord)) if (!names.includes(name)) names.push(name);
      // One chip per chord ("D 3/4"), tinted by how it went: far shorter than a table.
      const chips = names.map((name) => {
        const pc = summary.perChord[name];
        const total = pc ? pc.total : 0;
        const correct = pc ? pc.correct : 0;
        const ratio = total > 0 ? correct / total : -1;
        const tone = ratio < 0 ? '' : ratio >= 0.8 ? ' is-good' : ratio >= 0.5 ? ' is-mid' : ' is-bad';
        return h('span', { class: `practice-chip${tone}`, title: total > 0 ? `${correct} de ${total} bien` : 'Sin rasgueos' }, h('b', null, name), ` ${total > 0 ? `${correct}/${total}` : '—'}`);
      });
      const table = chips.length > 0 ? h('div.practice-chips', null, ...chips) : null;

      let hint: HTMLElement | null = null;
      if (judged > 0 && missedRatio >= LOW_INPUT_MISSED_RATIO) {
        hint = h(
          'div.practice-hintbox',
          null,
          h('p', null, 'El micrófono capta poco: acércalo o baja el umbral en Ajustes'),
          h('div.practice-hintbox-actions', null, h('a', { class: 'btn', href: '#/settings' }, 'Calibrar en Ajustes')),
        );
      } else if (median !== null && Math.abs(median) >= LATENCY_HINT_MIN_SEC) {
        const ms = Math.round(Math.abs(median) * 1000);
        const late = median > 0;
        const compensateBtn = h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => {
              const next = clamp(settings.latencySec + median, LATENCY_MIN_SEC, LATENCY_MAX_SEC);
              saveSettings({ latencySec: next });
              setFlag('latencyCalibrated');
              settings = { ...settings, latencySec: next };
              compensateBtn.disabled = true;
              compensateBtn.textContent = `Latencia ajustada a ${Math.round(next * 1000)} ms`;
            },
          },
          `Compensar (${late ? '+' : '−'}${ms} ms)`,
        );
        hint = h(
          'div.practice-hintbox',
          null,
          h('p', null, `De media tocas ${ms} ms ${late ? 'tarde' : 'pronto'}. Si seguías el metrónomo, casi seguro es latencia del audio, no tú.`),
          h('div.practice-hintbox-actions', null, compensateBtn, h('a', { class: 'btn', href: '#/settings' }, 'Calibrar en Ajustes')),
        );
      }

      // Repeat sits in the top row (always in view, no scrolling); the library is one tap away in the app bar.
      append(summaryEl, [
        h(
          'div.practice-summary-head',
          null,
          h('div.practice-summary-titles', null, h('h2', null, 'Resumen'), h('div.practice-summary-sub', null, `${reason === 'finished' ? 'Canción completada' : 'Sesión terminada'} · ${song.title || 'Sin título'}`)),
          h('button', { class: 'btn btn-primary practice-summary-repeat', type: 'button', onclick: () => void restart() }, '↻ Repetir'),
        ),
        h('div.practice-summary-stats', null, accuracyStat, stat('Puntos', String(summary.score)), stat('Racha', String(summary.bestStreak)), stat('Pasadas', String(summary.passes))),
        table,
        hint,
      ]);
      playView.hidden = true;
      summaryEl.hidden = false;
    }

    // ---------------------------------------------------------------- rAF loop

    function frame(): void {
      raf = requestAnimationFrame(frame);
      const state = session.update();
      if (state.phase === 'ended') return;
      if ((state.phase === 'countin' || state.phase === 'playing') && ctx.state !== 'running') session.pause();
      renderer.render(state, performance.now());
      updateHud(state);
    }
    applyLoop();
    raf = requestAnimationFrame(frame);
    if (audio && settings.backingTrack) void ensureBackingLoaded();

    // ---------------------------------------------------------------- unmount

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unsubHit();
      window.clearTimeout(hitFlashTimer);
      disposeSession();
      source.dispose();
      mic.stop();
      metronome.clear();
      flushBackingSave();
      backing?.dispose();
      backing = null;
      releaseWakeLock();
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.removeEventListener('statechange', onCtxState);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', onResize);
      rootEl.remove();
    };
  },
};
