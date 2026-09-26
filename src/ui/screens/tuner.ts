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

export const TUNER_IN_TUNE_CENTS = 5;
export const TUNER_CLOSE_CENTS = 15;
/** How long a reading must stay within TUNER_IN_TUNE_CENTS before auto-advancing, ms. */
export const TUNER_HOLD_MS = 1000;
/** How long the last reading is still shown after the note stops ringing loud enough, ms. */
export const TUNER_READING_TTL_MS = 400;
export const TUNER_MIN_STRENGTH = 0.15;
/** Cents range clamped for the needle/meter position (beyond this, only the text says how far off). */
export const TUNER_METER_RANGE_CENTS = 50;

export type TunerZone = 'in-tune' | 'close' | 'off';

/** Colour zone for a cents deviation: within ±5 in tune, within ±15 close, else off. */
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

/** "6ª · Mi (E2)" — the label for a target string. */
export function stringLabel(s: Pick<(typeof OPEN_STRINGS)[number], 'name' | 'string'>): string {
  return `${s.string}ª · ${SPANISH_NOTE[s.name] ?? s.name} (${s.name})`;
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
    let lastReadingAt = 0;
    let inTuneSinceMs: number | null = null;

    // ---------------------------------------------------------------- elements

    const targetEl = h('div.tuner-target', null, stringLabel(OPEN_STRINGS[0]));
    const noteEl = h('div.tuner-note', null, '—');
    const freqEl = h('div.tuner-freq', null, '— Hz');
    const meterFill = h('div.tuner-meter-fill');
    const meterNeedle = h('div.tuner-meter-needle');
    const meter = h('div.tuner-meter', null, meterFill, meterNeedle, h('div.tuner-meter-mid'));
    const centsEl = h('div.tuner-cents', null, '');
    const heardEl = h('div.tuner-heard', null, '');
    const statusEl = h('div.tuner-status', null, 'Pulsa Empezar y toca la cuerda señalada arriba.');

    const stringButtons = OPEN_STRINGS.map((s, i) =>
      h(
        'button.tuner-string',
        { type: 'button', title: `Ir a ${stringLabel(s)}`, onclick: () => selectString(i) },
        h('span.tuner-string-num', null, `${s.string}ª`),
        h('span.tuner-string-name', null, s.name),
      ) as HTMLButtonElement,
    );
    const stringsRow = h('div.tuner-strings', null, ...stringButtons);

    const prevBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => selectString(currentIndex - 1) }, '← Anterior') as HTMLButtonElement;
    const nextBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => selectString(currentIndex + 1) }, 'Siguiente →') as HTMLButtonElement;
    const navRow = h('div.tuner-nav', null, prevBtn, nextBtn);

    const startBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => void start() }, 'Empezar') as HTMLButtonElement;
    const stopBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => stop() }, 'Detener') as HTMLButtonElement;
    const retryBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => void start() }, 'Reintentar') as HTMLButtonElement;

    const screen = h(
      'main.screen.tuner',
      null,
      h('header.tuner-header', null, h('a', { class: 'btn btn-sm', href: '#/' }, '← Volver'), h('h1', null, 'Afinador')),
      h(
        'div.card.tuner-card',
        null,
        stringsRow,
        navRow,
        h('div.tuner-target-label', null, 'Toca esta cuerda:'),
        targetEl,
        noteEl,
        freqEl,
        meter,
        centsEl,
        heardEl,
        statusEl,
        h('div.tuner-actions', null, startBtn, stopBtn, retryBtn),
        h(
          'p.tuner-help',
          null,
          'Toca solo la cuerda señalada arriba, sin rasguear las demás. Verde = afinada, ámbar = cerca, rojo = lejos. ' +
            'Mantenla afinada un segundo y pasa sola a la siguiente. Si nunca se pone verde por poco en ninguna cuerda, ' +
            'prueba primero con un afinador aparte: puede que sea la app, no la guitarra.',
        ),
      ),
    );
    root.appendChild(screen);

    // ---------------------------------------------------------------- logic

    function updateNav(): void {
      prevBtn.disabled = currentIndex <= 0;
      nextBtn.disabled = currentIndex >= OPEN_STRINGS.length - 1;
      stringButtons.forEach((btn, i) => btn.classList.toggle('is-current', i === currentIndex));
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
      updateNav();
      render();
    }

    function render(): void {
      const now = performance.now();
      const target = OPEN_STRINGS[currentIndex];
      const reading = lastReading && now - lastReadingAt < TUNER_READING_TTL_MS ? lastReading : null;
      if (!reading) {
        noteEl.textContent = '—';
        noteEl.className = 'tuner-note';
        freqEl.textContent = '— Hz';
        centsEl.textContent = '';
        heardEl.textContent = '';
        meterNeedle.style.left = '50%';
        meterFill.className = 'tuner-meter-fill';
        inTuneSinceMs = null;
        return;
      }
      const cents = centsFromTarget(reading.freqHz, target.midi, settings.a4);
      const zone = tunerZone(cents);
      const clampedCents = Math.max(-99, Math.min(99, Math.round(cents)));
      noteEl.textContent = target.name;
      noteEl.className = `tuner-note is-${zone}`;
      freqEl.textContent = `${reading.freqHz.toFixed(1)} Hz (objetivo ${midiToFreq(target.midi, settings.a4).toFixed(1)} Hz)`;
      const sign = clampedCents > 0 ? '+' : clampedCents < 0 ? '−' : '';
      centsEl.textContent = clampedCents === 0 ? 'afinada' : `${sign}${Math.abs(clampedCents)} cents ${clampedCents > 0 ? '(muy alta)' : '(muy baja)'}`.replace('99 cents', '50+ cents');
      meterNeedle.style.left = `${(needleFraction(cents) * 100).toFixed(1)}%`;
      meterFill.className = `tuner-meter-fill is-${zone}`;
      heardEl.textContent = reading.midi === target.midi ? '' : `Se oye: ${reading.noteName} (puede que sea otra cuerda)`;

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
      fft.magnitudes(samples, mag);
      const reading = detectPitch(mag, mic.context.sampleRate, mic.fftSize, { a4: settings.a4 });
      if (reading && reading.strength >= TUNER_MIN_STRENGTH) {
        lastReading = reading;
        lastReadingAt = performance.now();
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
      screen.remove();
    };
  },
};
