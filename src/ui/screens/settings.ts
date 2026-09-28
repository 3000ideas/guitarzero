/**
 * Settings screen (`#/settings`) — SPEC.md section 8 "Ajustes".
 *
 * Every control persists with saveSettings() as soon as it changes. "Detectar dispositivos"
 * starts the mic to obtain device labels and stops it again; "Calibrar" runs runCalibration()
 * over a MicDetectorSource + Metronome on the shared AudioContext (resumed inside the click
 * handler, before any await) and stores the measured latency plus the `latencyCalibrated` flag.
 * The "Pista de audio" group (SPEC section 11) holds `backingTrack` and `echoCancellation`;
 * every mic start here passes `echoCancellation` like the practice screen does.
 */
import './settings.css';
import type { Screen, Settings } from '../../types';
import { getFlag, loadSettings, saveSettings, setFlag } from '../../song/storage';
import { getAudioContext } from '../../audio/context';
import { MicError, MicInput } from '../../audio/mic';
import { MicDetectorSource, detectorOptsFromSettings } from '../../audio/micDetector';
import { Metronome } from '../../audio/metronome';
import { CALIBRATION_DEFAULT_CLICKS, CalibrationError, runCalibration } from '../../audio/calibrate';
import { clear, h } from '../dom';

/** Guitar tuning presets (semitones from standard). */
export const TUNING_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Estándar' },
  { value: -1, label: 'Medio tono abajo (Eb)' },
  { value: -2, label: 'Un tono abajo (D)' },
];

const noop = (): void => {};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface RangeFieldOpts {
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  help?: string;
}

interface RangeField {
  root: HTMLElement;
  input: HTMLInputElement;
  setValue(v: number): void;
}

/** Label + range slider + live value; `onChange` receives the numeric value on every input. */
function rangeField(label: string, opts: RangeFieldOpts): RangeField {
  const valueEl = h('span.settings-range-value', null, opts.format(opts.value));
  const input = h('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
  });
  const setValue = (v: number): void => {
    input.value = String(v);
    valueEl.textContent = opts.format(v);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    valueEl.textContent = opts.format(v);
    opts.onChange(v);
  });
  const root = h(
    'div.settings-field',
    null,
    h('label.settings-label', null, h('span', null, label), valueEl),
    input,
    opts.help ? h('div.settings-help', null, opts.help) : null,
  );
  return { root, input, setValue };
}

function checkboxField(label: string, checked: boolean, onChange: (v: boolean) => void, help?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('div.settings-field.settings-check', null, h('label.settings-toggle', null, input, h('span', null, label)), help ? h('div.settings-help', null, help) : null);
}

export const settingsScreen: Screen = {
  mount(root: HTMLElement): () => void {
    let settings: Settings = loadSettings();
    const mic = new MicInput();
    let abort: AbortController | null = null;
    let disposed = false;

    function update(patch: Partial<Settings>): void {
      settings = saveSettings(patch);
    }

    // ---------------------------------------------------------------- input device

    const deviceSelect = h('select', { class: 'settings-select', 'aria-label': 'Dispositivo de entrada' });
    deviceSelect.addEventListener('change', () => update({ inputDeviceId: deviceSelect.value || null }));

    function fillDevices(devices: MediaDeviceInfo[]): void {
      clear(deviceSelect);
      deviceSelect.appendChild(h('option', { value: '' }, 'Dispositivo por defecto'));
      const current = settings.inputDeviceId;
      let found = current === null || current === '';
      devices.forEach((d, i) => {
        deviceSelect.appendChild(h('option', { value: d.deviceId }, d.label || `Micrófono ${i + 1}`));
        if (d.deviceId === current) found = true;
      });
      if (!found && current) deviceSelect.appendChild(h('option', { value: current }, `Dispositivo guardado (${current.slice(0, 8)}…)`));
      deviceSelect.value = current ?? '';
    }
    fillDevices([]);

    const deviceStatus = h('span.settings-status');
    const detectBtn = h('button', { class: 'btn', type: 'button', onclick: () => void detectDevices() }, 'Detectar dispositivos');

    async function detectDevices(): Promise<void> {
      if (abort) return; // not while calibrating
      detectBtn.disabled = true;
      deviceStatus.textContent = 'Solicitando permiso…';
      try {
        await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
        const devices = await mic.listDevices();
        if (disposed) return;
        fillDevices(devices);
        deviceStatus.textContent = devices.length > 0 ? `${devices.length} dispositivo(s) encontrado(s)` : 'No se encontraron micrófonos';
      } catch (err) {
        if (!disposed) deviceStatus.textContent = err instanceof MicError ? err.message : 'No se pudo acceder al micrófono';
      } finally {
        mic.stop();
        detectBtn.disabled = false;
      }
    }

    // ---------------------------------------------------------------- latency + calibration

    const latencyField = rangeField('Latencia de entrada', {
      min: -100,
      max: 500,
      step: 5,
      value: Math.round(settings.latencySec * 1000),
      format: (v) => `${v} ms`,
      onChange: (v) => update({ latencySec: v / 1000 }),
      help: 'Se suma al instante esperado de cada rasgueo. Calibra para medirla con tu equipo.',
    });

    const calibrateBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void calibrate() }, 'Calibrar');
    const cancelBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Cancelar');
    const calibProgress = h('div.settings-calib-progress', { hidden: true });
    const calibResult = h('div.settings-calib-result');
    const calibratedNote = h('div.settings-note', null, getFlag('latencyCalibrated') ? 'Latencia calibrada.' : 'Aún no has calibrado la latencia.');

    function showCalibError(message: string): void {
      calibResult.textContent = message;
      calibResult.className = 'settings-calib-result is-error';
    }

    async function calibrate(): Promise<void> {
      if (abort || disposed) return;
      const ctx = getAudioContext();
      void ctx.resume().catch(noop); // synchronously, before any await
      abort = new AbortController();
      const signal = abort.signal;
      const total = CALIBRATION_DEFAULT_CLICKS;
      calibrateBtn.disabled = true;
      detectBtn.disabled = true;
      cancelBtn.hidden = false;
      calibResult.textContent = '';
      calibResult.className = 'settings-calib-result';
      calibProgress.hidden = false;
      calibProgress.textContent = 'Preparando el micrófono…';

      let source: MicDetectorSource | null = null;
      let metronome: Metronome | null = null;
      try {
        await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
        if (disposed || signal.aborted) throw new CalibrationError('cancelled');
        source = new MicDetectorSource(mic, detectorOptsFromSettings(settings));
        metronome = new Metronome(ctx);
        calibProgress.textContent = `Rasguea con cada clic · 0/${total}`;
        const result = await runCalibration(source, metronome, { now: () => ctx.currentTime }, {
          n: total,
          signal,
          onProgress: (i) => {
            calibProgress.textContent = `Rasguea con cada clic · ${i}/${total}`;
          },
        });
        if (disposed) return;
        update({ latencySec: result.latencySec });
        setFlag('latencyCalibrated');
        latencyField.setValue(Math.round(settings.latencySec * 1000));
        calibResult.textContent = `Latencia medida: ${Math.round(result.latencySec * 1000)} ms (${result.samples.length} rasgueos)`;
        calibResult.className = 'settings-calib-result is-ok';
        calibratedNote.textContent = 'Latencia calibrada.';
      } catch (err) {
        if (!disposed) {
          if (err instanceof MicError || err instanceof CalibrationError) showCalibError(err.message);
          else showCalibError('No se pudo completar la calibración');
        }
      } finally {
        source?.dispose();
        metronome?.clear();
        mic.stop();
        abort = null;
        cancelBtn.hidden = true;
        calibProgress.hidden = true;
        calibrateBtn.disabled = false;
        detectBtn.disabled = false;
      }
    }

    // ---------------------------------------------------------------- diagnostics
    // Records real microphone input for a few seconds through the exact same pipeline used
    // everywhere else (MicInput -> MicDetectorSource), and lists every analysed frame's level,
    // whether it was read as an onset, and the live chord — so a real strum's actual numbers can
    // be read directly off the screen instead of copy-pasted console scripts (which turned out
    // error-prone: it's too easy to accidentally re-run a previous one by mistake).

    const DIAG_DURATION_SEC = 6;

    const diagBtn = h(
      'button',
      { class: 'btn', type: 'button', onclick: () => void runDiagnostic() },
      `Grabar ${DIAG_DURATION_SEC} s y analizar`,
    ) as HTMLButtonElement;
    const diagStatus = h(
      'div.settings-help',
      null,
      `Pulsa el botón y, en cuanto empiece a contar, rasguea con fuerza cerca del micrófono durante los ${DIAG_DURATION_SEC} segundos.`,
    );
    const diagOutput = h('pre.settings-diag-output', { hidden: true });

    async function runDiagnostic(): Promise<void> {
      if (abort || disposed) return;
      const ctx = getAudioContext();
      void ctx.resume().catch(noop); // synchronously, before any await
      diagBtn.disabled = true;
      detectBtn.disabled = true;
      calibrateBtn.disabled = true;
      diagOutput.hidden = true;
      diagOutput.textContent = '';
      diagStatus.textContent = 'Preparando el micrófono…';

      let source: MicDetectorSource | null = null;
      const rows: string[] = [];
      let maxRmsDb = -Infinity;
      let onsetCount = 0;
      try {
        await mic.start(settings.inputDeviceId ?? undefined, { echoCancellation: settings.echoCancellation });
        if (disposed) return;
        source = new MicDetectorSource(mic, detectorOptsFromSettings(settings));
        const startSec = ctx.currentTime;
        let lastShownSecLeft = -1;
        const unsub = source.onFrame((f) => {
          const t = f.timeSec - startSec;
          if (f.rmsDb > maxRmsDb) maxRmsDb = f.rmsDb;
          if (f.onset) onsetCount++;
          rows.push(
            `${t.toFixed(2).padStart(5)} s   rms ${f.rmsDb.toFixed(1).padStart(6)} dB   onset ${f.onset ? 'SÍ' : '·'}   acorde ${f.bestChord ? f.bestChord.name : '—'}`,
          );
          const secLeft = Math.max(0, Math.ceil(DIAG_DURATION_SEC - t));
          if (secLeft !== lastShownSecLeft) {
            lastShownSecLeft = secLeft;
            diagStatus.textContent = secLeft > 0 ? `Grabando… ¡rasguea! (${secLeft} s)` : 'Grabando…';
          }
        });
        await new Promise((resolve) => setTimeout(resolve, DIAG_DURATION_SEC * 1000));
        unsub();
        if (disposed) return;
        const gateDb = source.getGateDb();
        const noiseFloorDb = source.getNoiseFloorDb();
        diagStatus.textContent =
          `Nivel máximo: ${maxRmsDb === -Infinity ? '—' : `${maxRmsDb.toFixed(1)} dB`} · ` +
          `Golpes detectados: ${onsetCount} · ` +
          `Umbral efectivo: ${gateDb.toFixed(1)} dB (suelo de ruido ${noiseFloorDb.toFixed(1)} dB)`;
        diagOutput.textContent = rows.length > 0 ? rows.join('\n') : '(no llegó ningún fotograma del micrófono)';
        diagOutput.hidden = false;
      } catch (err) {
        if (!disposed) diagStatus.textContent = err instanceof MicError ? err.message : 'No se pudo grabar el micrófono';
      } finally {
        source?.dispose();
        mic.stop();
        if (!disposed) {
          diagBtn.disabled = false;
          detectBtn.disabled = false;
          calibrateBtn.disabled = false;
        }
      }
    }

    // ---------------------------------------------------------------- detection

    const gateField = rangeField('Umbral mínimo de silencio', {
      min: -70,
      max: -20,
      step: 1,
      value: Math.round(settings.gateDb),
      format: (v) => `${v} dB`,
      onChange: (v) => update({ gateDb: v }),
      help: 'Por debajo de este nivel (dBFS) la entrada se considera silencio. Súbelo si hay ruido de fondo.',
    });

    const onsetField = rangeField('Sensibilidad del onset', {
      min: 1,
      max: 3,
      step: 0.1,
      value: Math.round(settings.onsetThreshold * 10) / 10,
      format: (v) => v.toFixed(1),
      onChange: (v) => update({ onsetThreshold: v }),
      help: 'Umbral del detector de ataques: más bajo detecta rasgueos más suaves (y más falsos positivos).',
    });

    // ---------------------------------------------------------------- tuning

    const a4Input = h('input', {
      class: 'settings-number',
      type: 'number',
      min: '415',
      max: '466',
      step: '1',
      inputMode: 'numeric',
      value: String(settings.a4),
    });
    a4Input.addEventListener('change', () => {
      const v = Number(a4Input.value);
      if (Number.isFinite(v)) update({ a4: clamp(Math.round(v), 415, 466) });
      a4Input.value = String(settings.a4);
    });

    const tuningSelect = h('select', { class: 'settings-select', 'aria-label': 'Afinación de la guitarra' });
    for (const opt of TUNING_OPTIONS) tuningSelect.appendChild(h('option', { value: String(opt.value) }, opt.label));
    if (!TUNING_OPTIONS.some((o) => o.value === settings.tuningOffset)) {
      tuningSelect.appendChild(h('option', { value: String(settings.tuningOffset) }, `Otra (${settings.tuningOffset > 0 ? '+' : ''}${settings.tuningOffset} semitonos)`));
    }
    tuningSelect.value = String(settings.tuningOffset);
    tuningSelect.addEventListener('change', () => {
      const v = Number(tuningSelect.value);
      if (Number.isFinite(v)) update({ tuningOffset: v });
    });

    // ---------------------------------------------------------------- tolerances

    const earlyField = rangeField('Tolerancia antes del pulso (pronto)', {
      min: 0,
      max: 1000,
      step: 10,
      value: Math.round(settings.earlySec * 1000),
      format: (v) => `${v} ms`,
      onChange: (v) => update({ earlySec: v / 1000 }),
    });

    const lateField = rangeField('Tolerancia después del pulso (tarde)', {
      min: 0,
      max: 1000,
      step: 10,
      value: Math.round(settings.lateSec * 1000),
      format: (v) => `${v} ms`,
      onChange: (v) => update({ lateSec: v / 1000 }),
    });

    const CHORD_TOLERANCE_OPTIONS: ReadonlyArray<{ value: Settings['chordTolerance']; label: string }> = [
      { value: 'normal', label: 'Normal' },
      { value: 'lenient', label: 'Fácil (más margen)' },
    ];
    const difficultySelect = h('select', { class: 'settings-select', 'aria-label': 'Dificultad de reconocimiento del acorde' });
    for (const opt of CHORD_TOLERANCE_OPTIONS) difficultySelect.appendChild(h('option', { value: opt.value }, opt.label));
    difficultySelect.value = settings.chordTolerance;
    difficultySelect.addEventListener('change', () => {
      const v = difficultySelect.value === 'lenient' ? 'lenient' : 'normal';
      update({ chordTolerance: v });
    });
    const difficultyField = h(
      'div.settings-field',
      null,
      h('label.settings-label', null, h('span', null, 'Dificultad de reconocimiento')),
      difficultySelect,
      h(
        'div.settings-help',
        null,
        'En "Fácil" un acorde parecido (aunque no salga del todo limpio) cuenta como acertado — para practicar sin que un rasgueo casi correcto se marque como fallo.',
      ),
    );

    // ---------------------------------------------------------------- layout

    const rootEl = h(
      'section.settings',
      null,
      h('header.settings-header', null, h('a', { class: 'btn', href: '#/' }, '← Volver'), h('h1', null, 'Ajustes')),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Micrófono'),
        h(
          'div.settings-field',
          null,
          h('label.settings-label', null, h('span', null, 'Dispositivo de entrada')),
          h('div.settings-row', null, deviceSelect, detectBtn),
          h('div.settings-help', null, deviceStatus, ' Los nombres de los dispositivos solo aparecen tras conceder permiso.'),
        ),
        gateField.root,
        onsetField.root,
      ),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Latencia'),
        latencyField.root,
        h(
          'div.settings-field',
          null,
          h('div.settings-help', null, 'Pulsa Calibrar y rasguea con cada clic (', String(CALIBRATION_DEFAULT_CLICKS), ' clics, unos 10 s). Usa auriculares o baja el volumen para que el micrófono no capte el clic.'),
          h('div.settings-row', null, calibrateBtn, cancelBtn),
          calibProgress,
          calibResult,
          calibratedNote,
        ),
      ),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Diagnóstico'),
        h(
          'div.settings-field',
          null,
          diagStatus,
          h('div.settings-row', null, diagBtn),
          diagOutput,
        ),
      ),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Afinación'),
        h(
          'div.settings-field',
          null,
          h('label.settings-label', null, h('span', null, 'Afinación de referencia A4 (Hz)')),
          h('div.settings-row', null, a4Input, h('span.settings-help', null, '415–466 Hz, normalmente 440')),
        ),
        h(
          'div.settings-field',
          null,
          h('label.settings-label', null, h('span', null, 'Afinación de la guitarra')),
          tuningSelect,
          h('div.settings-help', null, 'Se suma a la cejilla de la canción para que la detección compare en el espacio escrito.'),
        ),
      ),

      h('fieldset.settings-group', null, h('legend', null, 'Tolerancias'), earlyField.root, lateField.root, difficultyField),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Autopista y sesión'),
        checkboxField('Invertir cuerdas en la autopista (6ª arriba)', settings.invertStrings, (v) => update({ invertStrings: v })),
        checkboxField('Metrónomo por defecto', settings.metronome, (v) => update({ metronome: v }), 'Estado inicial del metrónomo al abrir Practicar.'),
        checkboxField('Escuchar por defecto', settings.listen, (v) => update({ listen: v }), 'Estado inicial de la evaluación por micrófono al abrir Practicar.'),
      ),

      h(
        'fieldset.settings-group',
        null,
        h('legend', null, 'Pista de audio'),
        checkboxField(
          'Reproducir pista de audio',
          settings.backingTrack,
          (v) => update({ backingTrack: v }),
          'Si la canción tiene una pista (se carga en el Editor), suena durante la práctica siguiendo la velocidad, las pausas, los saltos de sección y los bucles. También se puede activar o desactivar desde Practicar.',
        ),
        checkboxField(
          'Cancelación de eco (si usas altavoces con la pista)',
          settings.echoCancellation,
          (v) => update({ echoCancellation: v }),
          'Pide al navegador que elimine del micrófono lo que sale por los altavoces (pista y metrónomo). Con auriculares déjala desactivada: la señal sin procesar detecta mejor los acordes.',
        ),
      ),

      h(
        'footer.settings-footer',
        null,
        h('a', { class: 'btn', href: '#/tuner', title: 'Comprueba si la guitarra está afinada' }, 'Afinador'),
        h('a', { class: 'btn', href: '#/' }, 'Volver'),
      ),
    );
    root.appendChild(rootEl);

    return () => {
      disposed = true;
      abort?.abort();
      mic.stop();
      rootEl.remove();
    };
  },
};
