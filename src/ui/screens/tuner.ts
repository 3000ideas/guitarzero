/**
 * Tuner screen (`#/tuner`) — a standalone, GUIDED chromatic tuner, independent of any song.
 * Answers a question the chord/onset detector alone cannot: is the guitar itself in tune?
 *
 * Guided, not auto-detecting: the screen always names ONE target string ("Cuerda 6 · Mi (E2)")
 * and compares whatever is heard against THAT note specifically — never against "whichever
 * reference note is numerically closest". Auto-matching by nearest pitch class breaks down
 * exactly when it matters most: a string that is badly out of tune (more than half a semitone)
 * gets silently compared to the WRONG neighbouring string, showing a misleading reading. The
 * player picks the string (the six chips, or Anterior/Siguiente) or just follows the default
 * low-to-high order (6ª Mi, 5ª La, 4ª Re, 3ª Sol, 2ª Si, 1ª mi); holding a string in tune for
 * about a second auto-advances to the next one.
 *
 * Reuses MicInput directly (not MicDetectorSource/the Worker) and runs dsp/tuner.ts's
 * detectPitch on each captured frame — a tuner is a much simpler, single-note task than chord
 * recognition, and seeing the raw detected note/Hz here isolates "is the guitar out of tune"
 * from "is chord matching off" (it also shows what was actually heard, so playing the wrong
 * string by mistake is obvious instead of silently reinterpreted as the target string).
 *
 * Mount: builds the UI in the idle state ("Empezar"). The mic starts only on that gesture
 * (MicInput manages its own private capture AudioContext and resumes it on start(), exactly
 * like the practice screen does for its own mic). Unmount always stops the mic and cancels the
 * animation frame.
 */
import './tuner.css';
import type { Screen } from '../../types';
import { getFlag, loadSettings, setFlag } from '../../song/storage';
import { MicError, MicInput } from '../../audio/mic';
import { RealFFT } from '../../dsp/fft';
import { rmsDbOf } from '../../dsp/detector';
import { detectPitch, type TunerReading } from '../../dsp/tuner';
import { midiToFreq } from '../../music/notes';
import { h } from '../dom';

/** The six strings of a standard-tuned guitar, in the order they're normally tuned: low to high. */
export const OPEN_STRINGS: ReadonlyArray<{ midi: number; name: string; string: number }> = [
  { midi: 40, name: 'E2', string: 6 },
  { midi: 45, name: 'A2', string: 5 },
  { midi: 50, name: 'D3', string: 4 },
  { midi: 55, name: 'G3', string: 3 },
  { midi: 59, name: 'B3', string: 2 },
  { midi: 64, name: 'E4', string: 1 },
];

/** Spanish note name for display next to the scientific name, e.g. 'Mi' for E2. */
const SPANISH_NOTE: Record<string, string> = { E2: 'Mi', A2: 'La', D3: 'Re', G3: 'Sol', B3: 'Si', E4: 'mi' };

/**
 * ±10 cents, not the ±5 a clip-on piezo tuner can afford: this tuner listens through a room mic
 * (background noise, other strings ringing, the device's own noise floor) instead of a sensor
 * clipped to the headstock, a noticeably noisier signal path. A user reported strings a separate
 * hardware tuner accepted as in tune never reaching "Afinada" here — a more realistic tolerance
 * for this acquisition method, not a more precise pitch estimate, is the fix (the estimate itself
 * is already accurate to ~1-2 cents on a clean synthetic signal, see tests/dsp/tuner.test.ts).
 */
export const TUNER_IN_TUNE_CENTS = 10;
export const TUNER_CLOSE_CENTS = 25;
/** How long a reading must stay within TUNER_IN_TUNE_CENTS before auto-advancing, ms. */
export const TUNER_HOLD_MS = 1000;
/** Cents range clamped for the needle/meter position (beyond this, only the text says how far off). */
export const TUNER_METER_RANGE_CENTS = 50;
/** How long a reading is shown as "live" before being flagged stale (the string decayed / peg is being turned without re-plucking), ms. */
export const TUNER_STALE_MS = 2500;
/** How long with no audio signal at all after starting before hinting a possible mic problem, ms. */
export const TUNER_NO_SIGNAL_HINT_MS = 5000;
/**
 * After a pluck (silence -> signal), the first ms are the noisy pick attack: skipped entirely.
 * A window of the next TUNER_CAPTURE_WINDOW_MS is then collected and its MEDIAN reading becomes
 * the one, fixed identification for that pluck — not a continuously live, still-updating number.
 * A live number that keeps drifting a few cents as the note rings and decays (normal: mic noise,
 * the note's own natural pitch settling) never visibly "stops", so a truly in-tune string could
 * look like it is still moving instead of reading as done. One clean reading per pluck, held
 * until the next pluck, is what "quitar el silencio y solo identificar la cuerda" asks for.
 */
export const TUNER_CAPTURE_DELAY_MS = 60;
export const TUNER_CAPTURE_WINDOW_MS = 200;
/**
 * A gap shorter than this between above-gate frames is NOT treated as the note ending: a real
 * ringing string's level pulses (natural beating between the vibration's two polarisations) and
 * can dip below the gate for a frame or two while still audibly ringing. Only a gap longer than
 * this — several missed 40 ms mic frames in a row — means the string actually went quiet.
 */
export const TUNER_SILENCE_RESET_MS = 150;

export type TunerZone = 'in-tune' | 'close' | 'off';

/** Colour zone for a cents deviation: within TUNER_IN_TUNE_CENTS in tune, within TUNER_CLOSE_CENTS close, else off. */
export function tunerZone(centsOff: number): TunerZone {
  const c = Math.abs(centsOff);
  if (c <= TUNER_IN_TUNE_CENTS) return 'in-tune';
  if (c <= TUNER_CLOSE_CENTS) return 'close';
  return 'off';
}

/** Needle position as a 0..1 fraction across a ±TUNER_METER_RANGE_CENTS meter (0.5 = centred). */
export function needleFraction(centsOff: number): number {
  const c = Math.max(-TUNER_METER_RANGE_CENTS, Math.min(TUNER_METER_RANGE_CENTS, centsOff));
  return 0.5 + c / (2 * TUNER_METER_RANGE_CENTS);
}

/** Cents of `freqHz` above (positive) or below (negative) the target MIDI note, unclamped. */
export function centsFromTarget(freqHz: number, targetMidi: number, a4 = 440): number {
  return 1200 * Math.log2(freqHz / midiToFreq(targetMidi, a4));
}

/** Cents beyond which the deviation more likely means "wrong string" than "just needs a tweak". */
export const TUNER_FAR_CENTS = 150;

/**
 * Actionable Spanish guidance for a (possibly large, unclamped) cents deviation from the target:
 * sharp (positive cents) means the string sounds HIGHER than it should, i.e. it is TOO TIGHT
 * (más tensa) and needs loosening; flat (negative) means too loose (floja) and needs tightening.
 * Guitarists think in terms of turning the tuning peg, not abstract cents, hence this over just
 * showing the number.
 */
export function tunerAdvice(cents: number): string {
  const zone = tunerZone(cents);
  if (zone === 'in-tune') return 'Afinada';
  const tooTight = cents > 0;
  const state = tooTight ? 'tensa' : 'floja';
  const action = tooTight ? 'Afloja' : 'Aprieta';
  const magnitude = Math.abs(cents);
  if (magnitude > TUNER_FAR_CENTS) return `Mucho más ${state} de lo normal — ¿es esta cuerda? ${action} bastante la clavija y comprueba`;
  if (zone === 'close') return `Un poco ${state}: ${action.toLowerCase()} ligeramente la clavija`;
  return `Más ${state} de lo normal: ${action.toLowerCase()} la clavija`;
}

/** "6ª · Mi (E2)" — the label for a target string. */
export function stringLabel(s: Pick<(typeof OPEN_STRINGS)[number], 'name' | 'string'>): string {
  return `${s.string}ª · ${SPANISH_NOTE[s.name] ?? s.name} (${s.name})`;
}

/** Mono 16-bit PCM WAV from `samples` (-1..1), for the diagnostic recording playback below. */
function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export const tunerScreen: Screen = {
  mount(root: HTMLElement, _params: Record<string, string>): () => void {
    void _params;
    const settings = loadSettings();
    const mic = new MicInput();
    const fft = new RealFFT(mic.fftSize);
    const mag = new Float32Array((mic.fftSize >> 1) + 1);

    let disposed = false;
    let starting = false;
    let running = false;
    let raf = 0;
    let currentIndex = 0;
    let lastReading: TunerReading | null = null;
    let inTuneSinceMs: number | null = null;
    /** Last time any frame had real audio above the silence gate (not necessarily a valid pitch). */
    let lastSignalAtMs: number | null = null;
    let startedAtMs: number | null = null;
    // Capture-once-per-pluck state (see TUNER_CAPTURE_*/TUNER_SILENCE_RESET_MS above): a gap of
    // more than TUNER_SILENCE_RESET_MS since the last above-gate frame (lastSignalAtMs) starts a
    // new pluck; captured collects readings during its capture window; locked is true once this
    // pluck's single reading has been decided, so further frames of the same ringing note are
    // ignored until a real silence gap.
    let locked = false;
    let captureStartMs: number | null = null;
    let captured: TunerReading[] = [];
    let diagRunning = false;
    let diagAudioUrl: string | null = null;

    // ---------------------------------------------------------------- elements

    const targetEl = h('div.tuner-target', null, stringLabel(OPEN_STRINGS[0]));
    const noteEl = h('div.tuner-note', null, '—');
    const freqEl = h('div.tuner-freq', null, '— Hz');
    const meterFill = h('div.tuner-meter-fill');
    const meterNeedle = h('div.tuner-meter-needle');
    const meter = h('div.tuner-meter', null, meterFill, meterNeedle, h('div.tuner-meter-mid'));
    const centsEl = h('div.tuner-cents', null, '');
    const heardEl = h('div.tuner-heard', null, '');
    const staleEl = h('div.tuner-stale', null, '');
    const ledEl = h('span.tuner-led', { 'aria-hidden': 'true' });
    const statusEl = h('div.tuner-status', null, 'Pulsa Empezar y toca la cuerda señalada arriba.');
    const statusRow = h('div.tuner-status-row', null, ledEl, statusEl);

    const stringButtons = OPEN_STRINGS.map((s, i) =>
      h(
        'button.tuner-string',
        { type: 'button', title: `Ir a ${stringLabel(s)}`, onclick: () => selectString(i) },
        h('span.tuner-string-num', null, `${s.string}ª`),
        h('span.tuner-string-name', null, s.name),
      ) as HTMLButtonElement,
    );
    const stringsRow = h('div.tuner-strings', null, ...stringButtons);

    // Visual guitar neck: 6 lines from thick (string 6, top) to thin (string 1, bottom), the way
    // a player sees their own strings looking down while holding the guitar to play (NOT how a
    // photo facing the guitar would show it) — this is what a beginner actually needs to match
    // "cuerda 6" / "cuerda 1" against, since the numbers alone don't say which is which.
    const diagramWrap = h('div.tuner-diagram');
    diagramWrap.innerHTML = `
      <svg viewBox="0 0 300 150" class="tuner-diagram-svg" role="img" aria-label="Diagrama de las 6 cuerdas">
        <rect x="2" y="6" width="12" height="138" rx="4" class="tuner-diagram-nut"></rect>
        ${OPEN_STRINGS.map((s, i) => {
          const y = 16 + i * 24;
          const thickness = (5 - i * 0.65).toFixed(2);
          return `
            <g class="tuner-diagram-row" data-index="${i}">
              <polygon class="tuner-diagram-arrow" points="18,${y - 6} 30,${y} 18,${y + 6}"></polygon>
              <line x1="34" y1="${y}" x2="250" y2="${y}" stroke-width="${thickness}" class="tuner-diagram-line" stroke-linecap="round"></line>
              <text x="258" y="${y + 4}" class="tuner-diagram-label">${s.string}ª · ${s.name}</text>
            </g>`;
        }).join('')}
      </svg>
      <div class="tuner-diagram-caption">
        Sostén la guitarra para tocar y mira hacia abajo: la cuerda 6 (la más gruesa) queda arriba, la 1 (la más fina) abajo.
      </div>`;
    const diagramRows = Array.from(diagramWrap.querySelectorAll<SVGGElement>('.tuner-diagram-row'));

    function updateDiagram(): void {
      diagramRows.forEach((row, i) => row.classList.toggle('is-current', i === currentIndex));
    }

    const prevBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => selectString(currentIndex - 1) }, '← Anterior') as HTMLButtonElement;
    const nextBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => selectString(currentIndex + 1) }, 'Siguiente →') as HTMLButtonElement;
    const navRow = h('div.tuner-nav', null, prevBtn, nextBtn);

    const startBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => void start() }, 'Empezar') as HTMLButtonElement;
    const stopBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => stop() }, 'Detener') as HTMLButtonElement;
    const retryBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => void start() }, 'Reintentar') as HTMLButtonElement;

    // Diagnostic recording: when the identified note looks wrong or never changes, the player
    // needs to see (and, crucially, HEAR) exactly what the microphone is actually picking up —
    // it might be the room / a noise source, not the guitar. Same idea as Settings' "Diagnóstico"
    // panel (a real recording, not a console script), but with audio playback added: a per-frame
    // table alone cannot tell "the guitar is just too quiet through this mic" from "the algorithm
    // is wrong" the way actually hearing the recording can.
    const DIAG_DURATION_SEC = 8;
    const diagBtn = h(
      'button.btn.btn-sm',
      { type: 'button', onclick: () => void runTunerDiagnostic() },
      `Grabar ${DIAG_DURATION_SEC} s y escuchar`,
    ) as HTMLButtonElement;
    const diagStatus = h('div.tuner-diag-status', null, 'Toca varias cuerdas, una por una, mientras graba.');
    const diagOutput = h('pre.tuner-diag-output', { hidden: true });
    const diagAudioEl = h('audio', { controls: true, hidden: true }) as HTMLAudioElement;
    const diagDetails = h(
      'details.tuner-diag',
      null,
      h('summary', null, 'Diagnóstico: grabar y escuchar lo que oye el micrófono'),
      h(
        'p.tuner-help',
        null,
        'Si el afinador siempre marca la misma nota pase lo que pase, puede que el micrófono esté ' +
          'oyendo otra cosa (ruido del ordenador, del ventilador…) en vez de la guitarra, sobre todo ' +
          'si es una guitarra acústica sin amplificar. Graba unos segundos tocando varias cuerdas y ' +
          'reproduce la grabación: si apenas se oye la guitarra, el problema es el micrófono o su ' +
          'volumen de entrada, no esta app.',
      ),
      diagBtn,
      diagStatus,
      diagAudioEl,
      diagOutput,
    );

    const screen = h(
      'main.screen.tuner',
      null,
      h('header.tuner-header', null, h('a', { class: 'btn btn-sm', href: '#/' }, '← Volver'), h('h1', null, 'Afinador')),
      h(
        'div.card.tuner-card',
        null,
        diagramWrap,
        stringsRow,
        navRow,
        h('div.tuner-target-label', null, 'Toca esta cuerda:'),
        targetEl,
        noteEl,
        freqEl,
        meter,
        centsEl,
        heardEl,
        staleEl,
        statusRow,
        h('div.tuner-actions', null, startBtn, stopBtn, retryBtn),
        h(
          'p.tuner-help',
          null,
          'Toca solo la cuerda señalada arriba, sin rasguear las demás. Verde = afinada, ámbar = cerca, rojo = lejos. ' +
            'Mantenla afinada un segundo y pasa sola a la siguiente. Si giras la clavija y no vuelves a tocar la cuerda, ' +
            'el número se queda parado en lo último que sonó: toca la cuerda cada pocos segundos mientras la afinas, ' +
            'no solo una vez. También puedes cambiar de cuerda con las flechas ← → del teclado. Si nunca se pone verde ' +
            'por poco en ninguna cuerda, prueba primero con un afinador aparte: puede que sea la app, no la guitarra.',
        ),
        diagDetails,
      ),
    );
    root.appendChild(screen);

    // Left/Up = previous string, Right/Down = next — mirrors the Anterior←/Siguiente→ buttons and
    // the diagram's top-to-bottom (string 6 to string 1) order, so it works without a mouse.
    function handleKeydown(e: KeyboardEvent): void {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectString(currentIndex - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        selectString(currentIndex + 1);
      }
    }
    window.addEventListener('keydown', handleKeydown);

    // ---------------------------------------------------------------- logic

    function updateNav(): void {
      prevBtn.disabled = currentIndex <= 0;
      nextBtn.disabled = currentIndex >= OPEN_STRINGS.length - 1;
      stringButtons.forEach((btn, i) => btn.classList.toggle('is-current', i === currentIndex));
      updateDiagram();
    }

    function selectString(index: number): void {
      const clamped = Math.max(0, Math.min(OPEN_STRINGS.length - 1, index));
      if (clamped === currentIndex && targetEl.textContent === stringLabel(OPEN_STRINGS[clamped])) {
        updateNav();
        return;
      }
      currentIndex = clamped;
      targetEl.textContent = stringLabel(OPEN_STRINGS[currentIndex]);
      lastReading = null;
      inTuneSinceMs = null;
      // Force the next above-gate frame to read as a fresh pluck (a large gap), even if the
      // previous string is still audibly ringing: switching targets must always start a new
      // capture for the newly-selected string, not silently continue the old one's.
      lastSignalAtMs = null;
      locked = false;
      captureStartMs = null;
      captured = [];
      updateNav();
      render();
    }

    function render(): void {
      const now = performance.now();
      const signalAgeMs = lastSignalAtMs === null ? Infinity : now - lastSignalAtMs;
      // The LED is a "piloto": grey when stopped, softly pulsing while listening, bright the
      // instant real audio (above the silence gate) comes in — visible proof the mic is alive,
      // independent of whether a note was actually recognised yet.
      ledEl.className = !running ? 'tuner-led' : signalAgeMs < 400 ? 'tuner-led is-signal' : 'tuner-led is-listening';
      const target = OPEN_STRINGS[currentIndex];
      // The reading is kept on screen after the string stops ringing (like a real tuner's needle
      // holding its last position), not cleared after a short timeout: the player needs time to
      // actually read the advice text. selectString() clears it when moving to another string.
      const reading = lastReading;
      if (!reading) {
        noteEl.textContent = '—';
        noteEl.className = 'tuner-note';
        freqEl.textContent = '— Hz';
        centsEl.textContent = '';
        heardEl.textContent = '';
        staleEl.textContent = '';
        meterNeedle.style.left = '50%';
        meterFill.className = 'tuner-meter-fill';
        inTuneSinceMs = null;
        if (running && lastSignalAtMs === null && startedAtMs !== null && now - startedAtMs > TUNER_NO_SIGNAL_HINT_MS) {
          statusEl.textContent = 'No se detecta ningún sonido del micrófono. Comprueba el micrófono en Ajustes o toca más fuerte.';
        }
        return;
      }
      // A reading is only "live" while the string is still ringing above the gate. Once it goes
      // quiet (e.g. while turning the tuning peg without re-plucking), the number stays on screen
      // per the note above, but it no longer reflects the string's current pitch — flag that
      // explicitly so it doesn't look like "nothing changes no matter how much I turn the peg".
      staleEl.textContent = signalAgeMs > TUNER_STALE_MS ? 'Sin sonido ahora: esto es lo último que se oyó. Toca la cuerda otra vez.' : '';
      const cents = centsFromTarget(reading.freqHz, target.midi, settings.a4);
      const zone = tunerZone(cents);
      noteEl.textContent = target.name;
      noteEl.className = `tuner-note is-${zone}`;
      freqEl.textContent = `${reading.freqHz.toFixed(1)} Hz (objetivo ${midiToFreq(target.midi, settings.a4).toFixed(1)} Hz)`;
      const advice = tunerAdvice(cents);
      const roundedAbs = Math.round(Math.abs(cents));
      // Actionable guidance first ("más tensa: afloja"), the raw number as a small confirmation —
      // a guitarist thinks in terms of turning the tuning peg, not abstract cents.
      centsEl.textContent = zone === 'in-tune' ? advice : `${advice} (${roundedAbs} cents)`;
      meterNeedle.style.left = `${(needleFraction(cents) * 100).toFixed(1)}%`;
      meterFill.className = `tuner-meter-fill is-${zone}`;
      heardEl.textContent = reading.midi === target.midi ? '' : `Se oye: ${reading.noteName}`;

      if (zone === 'in-tune') {
        if (inTuneSinceMs === null) inTuneSinceMs = now;
        else if (now - inTuneSinceMs >= TUNER_HOLD_MS && currentIndex < OPEN_STRINGS.length - 1) {
          selectString(currentIndex + 1);
          statusEl.textContent = '¡Afinada! Siguiente cuerda.';
          return;
        } else if (now - inTuneSinceMs >= TUNER_HOLD_MS) {
          statusEl.textContent = '¡Todas afinadas!';
        }
      } else {
        inTuneSinceMs = null;
      }
    }

    function frame(): void {
      raf = requestAnimationFrame(frame);
      render();
    }

    function onMicFrame(samples: Float32Array): void {
      // Below the gate the frame is silence / room noise: ignored, exactly like the chord
      // detector's own gate (rmsDbOf + settings.gateDb — "silence" means the same thing
      // everywhere in the app). Without this, "the loudest peak in the frame" is still a peak
      // even when the frame is silence, so the tuner reported a phantom note before any string
      // was played. Note this does NOT by itself mean a ringing note just ended: a real string's
      // level naturally pulses (two slightly different polarisations of the vibration beating
      // against each other) and can dip below the gate for a frame or two while still audibly
      // ringing — treating every single dip as "the note ended" reset the capture window before
      // it ever had a chance to complete, so the tuner never identified anything at all. Only a
      // gap LONGER than TUNER_SILENCE_RESET_MS (checked below) counts as real silence.
      if (rmsDbOf(samples) < settings.gateDb) return;
      const now = performance.now();
      const gapMs = lastSignalAtMs === null ? Infinity : now - lastSignalAtMs;
      lastSignalAtMs = now;
      if (gapMs > TUNER_SILENCE_RESET_MS) {
        // A real gap since the last audio: this is a genuinely new pluck. Begin its capture window.
        locked = false;
        captureStartMs = now;
        captured = [];
      }
      if (locked || captureStartMs === null) return; // this pluck is already identified
      const elapsedMs = now - captureStartMs;
      if (elapsedMs < TUNER_CAPTURE_DELAY_MS) return; // still inside the noisy pick attack
      fft.magnitudes(samples, mag);
      const reading = detectPitch(mag, mic.context.sampleRate, mic.fftSize, { a4: settings.a4 });
      if (reading) captured.push(reading);
      if (elapsedMs >= TUNER_CAPTURE_DELAY_MS + TUNER_CAPTURE_WINDOW_MS) {
        // Capture window closed: lock in the median reading (robust to a single noisy frame) as
        // THE identification for this pluck. Further frames of the same ringing note are ignored
        // (see the `locked` check above) until the string goes quiet and is plucked again.
        locked = true;
        if (captured.length > 0) {
          const sorted = [...captured].sort((a, b) => a.freqHz - b.freqHz);
          lastReading = sorted[Math.floor(sorted.length / 2)];
        }
        captured = [];
      }
    }

    /**
     * Records DIAG_DURATION_SEC of raw microphone audio, listing every analysed frame's level and
     * detected note/Hz (like Settings' diagnostic panel), and — the part a table alone can't give
     * — makes the actual recording playable, so "is the mic even hearing the guitar" can be
     * answered by listening instead of guessing from numbers. Reuses the running mic session if
     * the tuner is already listening; otherwise starts (and stops) one just for this recording.
     */
    async function runTunerDiagnostic(): Promise<void> {
      if (diagRunning || disposed) return;
      diagRunning = true;
      diagBtn.disabled = true;
      diagOutput.hidden = true;
      diagAudioEl.hidden = true;
      diagStatus.textContent = 'Preparando el micrófono…';
      const alreadyRunning = running;
      const diagFft = new RealFFT(mic.fftSize);
      const diagMag = new Float32Array((mic.fftSize >> 1) + 1);
      const chunks: Float32Array[] = [];
      const rows: string[] = [];
      let maxRmsDb = -Infinity;
      try {
        if (!alreadyRunning) {
          await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
          if (disposed) return;
        }
        const t0 = performance.now();
        let lastShownSecLeft = -1;
        const unsub = mic.onFrame((samples) => {
          chunks.push(samples);
          const rmsDb = rmsDbOf(samples);
          if (rmsDb > maxRmsDb) maxRmsDb = rmsDb;
          diagFft.magnitudes(samples, diagMag);
          const reading = rmsDb >= settings.gateDb ? detectPitch(diagMag, mic.context.sampleRate, mic.fftSize, { a4: settings.a4 }) : null;
          const elapsed = (performance.now() - t0) / 1000;
          rows.push(
            `${elapsed.toFixed(2).padStart(5)} s   rms ${rmsDb.toFixed(1).padStart(6)} dB   ` +
              (reading ? `${reading.noteName.padEnd(3)} ${reading.freqHz.toFixed(1).padStart(6)} Hz` : '—'),
          );
          const secLeft = Math.max(0, Math.ceil(DIAG_DURATION_SEC - elapsed));
          if (secLeft !== lastShownSecLeft) {
            lastShownSecLeft = secLeft;
            diagStatus.textContent = secLeft > 0 ? `Grabando… toca varias cuerdas, una por una (${secLeft} s)` : 'Grabando…';
          }
        });
        await new Promise((resolve) => setTimeout(resolve, DIAG_DURATION_SEC * 1000));
        unsub();
        if (disposed) return;
        diagOutput.textContent = rows.length > 0 ? rows.join('\n') : '(no llegó ningún fotograma del micrófono)';
        diagOutput.hidden = false;
        const totalLen = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Float32Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        if (totalLen > 0) {
          const wav = encodeWavMono(merged, mic.context.sampleRate);
          if (diagAudioUrl) URL.revokeObjectURL(diagAudioUrl);
          diagAudioUrl = URL.createObjectURL(wav);
          diagAudioEl.src = diagAudioUrl;
          diagAudioEl.hidden = false;
          diagStatus.textContent = `Nivel máximo: ${maxRmsDb === -Infinity ? '—' : `${maxRmsDb.toFixed(1)} dB`}. Pulsa ▶ para escuchar exactamente lo que oyó el micrófono.`;
        } else {
          diagStatus.textContent = 'No se recibió audio del micrófono.';
        }
      } catch (err) {
        if (!disposed) diagStatus.textContent = err instanceof MicError ? err.message : 'No se pudo grabar el micrófono';
      } finally {
        if (!alreadyRunning) mic.stop();
        diagRunning = false;
        if (!disposed) diagBtn.disabled = false;
      }
    }

    async function start(): Promise<void> {
      if (starting || disposed || running) return;
      starting = true;
      startBtn.disabled = true;
      retryBtn.hidden = true;
      statusEl.textContent = 'Conectando…';
      try {
        // MicInput owns and resumes its own private capture AudioContext on start() (see
        // audio/mic.ts); the tuner never touches the shared playback context, so it can never
        // fight a backing track for the audio device.
        await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
        if (disposed) return;
        running = true;
        startedAtMs = performance.now();
        lastSignalAtMs = null;
        mic.onFrame(onMicFrame);
        startBtn.hidden = true;
        stopBtn.hidden = false;
        statusEl.textContent = 'Escuchando… toca la cuerda señalada arriba.';
        if (!getFlag('tunerSeen')) setFlag('tunerSeen');
        raf = requestAnimationFrame(frame);
      } catch (err) {
        if (!disposed) {
          statusEl.textContent = err instanceof MicError ? err.message : 'No se pudo acceder al micrófono';
          retryBtn.hidden = false;
        }
      } finally {
        starting = false;
        if (!disposed) startBtn.disabled = false;
      }
    }

    function stop(): void {
      if (!running) return;
      running = false;
      mic.stop();
      cancelAnimationFrame(raf);
      raf = 0;
      lastReading = null;
      inTuneSinceMs = null;
      lastSignalAtMs = null;
      startedAtMs = null;
      locked = false;
      captureStartMs = null;
      captured = [];
      startBtn.hidden = false;
      stopBtn.hidden = true;
      statusEl.textContent = 'Pulsa Empezar y toca la cuerda señalada arriba.';
      render();
    }

    updateNav();

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      mic.stop();
      window.removeEventListener('keydown', handleKeydown);
      if (diagAudioUrl) URL.revokeObjectURL(diagAudioUrl);
      screen.remove();
    };
  },
};
