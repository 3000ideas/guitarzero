# GuitarZero — Especificación técnica

App web (PWA-friendly) para practicar guitarra al estilo Yousician: el usuario introduce
una canción con acordes, la app muestra una "autopista" animada con los acordes que se
acercan a una línea de golpeo, una pelota que bota marcando cada rasgueo, el diagrama de
dedos del acorde actual, y escucha por el micrófono para juzgar si cada rasgueo se tocó
bien (acorde correcto y a tiempo), mal (acorde incorrecto) o se perdió (no sonó nada).

UI en **español**. Código, identificadores y comentarios en **inglés**.

## 1. Stack

- Vite 6 + TypeScript 5 (vanilla, sin framework). Canvas 2D para la animación. Web Audio
  API para micrófono y metrónomo. Vitest para tests unitarios (entorno `node`).
- Sin dependencias de runtime (todo el DSP en TS puro, para que sea testeable en Node).
- Estructura:

```
index.html
src/main.ts              bootstrap, router de pantallas
src/styles.css
src/types.ts             tipos compartidos (contrato entre módulos) — YA ESCRITO, no cambiar sin avisar
src/music/notes.ts       nombres de notas, pitch classes, midi<->Hz, parseo de símbolos de acorde
src/music/chords.ts      biblioteca de digitaciones + generador de cejillas
src/song/parser.ts       texto de canción -> Song (eventos de rasgueo con tiempos en beats)
src/song/examples.ts     canciones de ejemplo incluidas
src/song/storage.ts      CRUD en localStorage
src/dsp/fft.ts           FFT real radix-2
src/dsp/chroma.ts        espectro -> chroma; plantillas de acordes; matching
src/dsp/onset.ts         detector de ataques (spectral flux)
src/dsp/detector.ts      ChordDetector: frames de audio -> onsets + chroma + acorde
src/audio/mic.ts         MicInput: getUserMedia + AnalyserNode + bucle de captura
src/audio/metronome.ts   clics de metrónomo/cuenta atrás con planificador look-ahead
src/game/judge.ts        lógica pura de veredicto por evento
src/game/engine.ts       PracticeSession: reloj, planificación, veredictos, resumen
src/ui/highway.ts        render canvas de la autopista + pelota
src/ui/chordDiagram.ts   render del diagrama de acorde (canvas)
src/ui/screens/library.ts, editor.ts, practice.ts, settings.ts, summary.ts
src/ui/dom.ts            helpers mínimos (h(), qs())
tests/**                 vitest
```

## 2. Formato de canción (texto)

Cabeceras `clave: valor` (una por línea, al principio o en cualquier punto; `tempo`,
`strum` y `time` pueden cambiar a mitad de canción y aplican desde ese punto):

```
title: Cielito Lindo
artist: Tradicional
tempo: 120          # BPM (negras). Obligatorio (por defecto 80 si falta)
time: 3/4           # compás. Soportado: 4/4 (defecto), 3/4, 2/4, 6/8
strum: D-DU-UDU     # patrón de rasgueo por compás: 2 caracteres por beat
                    # D = abajo, U = arriba, - = nada, x = apagado (se trata como D)
                    # Si falta: un D por beat ("D-D-D-D-" en 4/4)
capo: 2             # opcional, solo informativo (se muestra)

[Intro]             # sección (solo etiqueta visual)
C . . . | G . . . | C . G . |
# comentario
[Estrofa]
C G | Am F |        # menos tokens que beats: el compás se reparte a partes iguales
Am*3 F |            # Am durante 3 beats, F el resto (1 beat en 4/4)
N.C. | G . . . |    # N.C. = sin acorde (no se juzga, no se rasguea)
```

Reglas del parser:

- Un compás = tokens entre `|`. Tokens: símbolo de acorde (`C`, `Am7`, `F#m`, `Bb`, `G/B`,
  `Dsus4`, `Cadd9`, `N.C.`), `.` (continúa el acorde anterior 1 beat), `-` (silencio de 1
  beat), `X*n` (acorde X durante n beats).
- Si la suma de duraciones explícitas de un compás no cubre `beatsPerBar`, los tokens sin
  duración explícita reparten equitativamente los beats restantes (permitiendo medios
  beats). Si sobrepasa, error con línea.
- Cada compás genera `StrumEvent`s según el patrón de rasgueo: por cada carácter `D`/`U`/`x`
  del patrón en la posición `k` (corchea k del compás) se crea un evento en
  `barStart + k/2` beats con el acorde vigente en ese instante. Si el acorde cambia en un
  instante donde el patrón tiene `-`, se crea igualmente un evento `D` en ese instante
  (siempre hay un rasgueo al cambiar de acorde).
- `time` de un evento se expresa en **beats absolutos** desde el inicio (float). El motor
  convierte a segundos con el tempo vigente (los cambios de tempo se aplican por tramos).
- Errores: `ParseError { line: number; message: string }` (lista, no excepción); el
  resultado siempre trae una `Song` parcial usable si no hay errores fatales.
- Acordes desconocidos por la biblioteca NO son error de parseo; el parser solo valida la
  sintaxis del símbolo. La UI del editor los marca en amarillo con "sin digitación".

## 3. Tipos compartidos (`src/types.ts`)

Ver el archivo. Resumen: `ChordSymbol`, `ChordShape`, `Song`, `StrumEvent`, `Verdict`,
`DetectorFrame`, `SessionState`, `Settings`.

## 4. Música

### notes.ts
- `NOTE_NAMES_SHARP`, `NOTE_NAMES_FLAT`, `pitchClassOf('F#') === 6`, `midiToFreq`,
  `freqToMidi`, `noteName(midi)`.
- `parseChordSymbol(text): ChordSymbol | null`. Cualidades reconocidas y sus intervalos
  (semitonos desde la fundamental):
  - `maj` [0,4,7] (`C`, `Cmaj`, `CM`), `min` [0,3,7] (`Cm`, `Cmin`, `C-`),
  - `7` [0,4,7,10], `maj7` [0,4,7,11] (`Cmaj7`, `CM7`), `m7` [0,3,7,10], `dim` [0,3,6],
    `dim7` [0,3,6,9], `m7b5` [0,3,6,10], `aug` [0,4,8], `sus2` [0,2,7], `sus4` [0,5,7],
    `7sus4` [0,5,7,10], `add9` [0,4,7,14→2], `6` [0,4,7,9], `m6` [0,3,7,9], `9` [0,4,7,10,2],
    `5` [0,7] (power chord).
  - Bajo alternativo `G/B` → `bass: 11`.
  - `N.C.`/`NC` → `{ root: -1, quality: 'nc' }` (sin acorde).
- `chordPitchClasses(sym): number[]` (incluye el bajo si lo hay).

### chords.ts
- `CHORD_LIBRARY: ChordShape[]` con digitaciones abiertas comunes (mínimo): C, D, E, F, G, A,
  B; Am, Bm, Cm, Dm, Em, Fm, Gm; A7, B7, C7, D7, E7, G7; Am7, Dm7, Em7; Cmaj7, Fmaj7, Amaj7,
  Dmaj7; Asus2, Asus4, Dsus2, Dsus4, Esus4; Cadd9, Gadd9; G/B, D/F#, C/G, Am/G; Bb, Eb, F#m,
  C#m, G#m, Bm7, F#m7; A5, E5, D5, G5. Sistema de cuerdas: índice 0 = 6ª (E grave), 5 = 1ª
  (e aguda). `frets[i]`: -1 = no sonar, 0 = al aire, n = traste. `fingers[i]`: 0 = ninguno,
  1-4 índice..meñique. `barre?: { fret, fromString, toString }`. `baseFret`: traste donde
  empieza el diagrama (1 salvo acordes altos).
- `getChordShape(symbol: string | ChordSymbol): ChordShape | null`: busca por nombre
  normalizado (enarmónicos: `Bb` ≡ `A#`); si no existe, **genera una cejilla** a partir de la
  forma de E (raíz en 6ª) o de A (raíz en 5ª) para `maj`, `min`, `7`, `m7`, `maj7`, `sus4`,
  `5`, eligiendo la forma con el traste base más bajo (≥1). Devuelve `null` solo para
  cualidades no generables o `nc`.
- `shapePitchClasses(shape): number[]` a partir de la afinación estándar
  E2 A2 D3 G3 B3 E4 (midi 40 45 50 55 59 64) y los trastes. `shapeMidiNotes(shape)`.

## 5. DSP (todo con `Float32Array`, sin Web Audio, testeable en Node)

### fft.ts
- `class RealFFT { constructor(size: number /* potencia de 2 */); forward(input: Float32Array, outRe: Float32Array, outIm: Float32Array): void; magnitudes(input, outMag /* size/2+1 */): void }`.
  Ventana Hann aplicada dentro de `magnitudes` (parámetro `windowed = true`). Test contra
  DFT ingenua en tamaños 16/64 y con senos puros.

### chroma.ts
- `computeChroma(mag: Float32Array, sampleRate, fftSize, opts?): Float32Array(12)`:
  para cada nota MIDI de 40 (E2) a 88 (E6) suma la energía (`mag²`) de los bins cuya
  frecuencia cae dentro de ±50 cents de la nota (con `a4 = 440` configurable); acumula por
  pitch class con peso por octava (1.0 en octavas graves, 0.6 en la más aguda, lineal);
  aplica compresión `log(1 + 100·x)`; normaliza a norma L2 = 1 (o ceros si silencio).
- `buildTemplates(): ChordTemplate[]` para 12 raíces × { maj, min, 7, m7, maj7, sus2, sus4 }
  usando **plantillas armónicas**: por cada nota del acorde se añaden sus armónicos 1..4 con
  pesos 1, 0.5, 0.33, 0.25 (h-ésimo armónico → pitch class `(pc + round(12·log2(h))) % 12`),
  se normaliza L2. `templateForPitchClasses(pcs: number[])` igual para un voicing concreto.
- `matchChord(chroma, templates): { best: ChordTemplate, score: number, ranked: Array<{t, score}> }`
  con similitud coseno. `scoreAgainst(chroma, template): number`.

### onset.ts
- `class OnsetDetector { constructor(opts: { hopSeconds; minIntervalSec = 0.1; threshold = 1.5; historyFrames = 20 }); process(mag: Float32Array, timeSec: number): boolean }`.
  Spectral flux con rectificación de media onda sobre `log(1 + mag)`, umbral adaptativo =
  `median(últimos N flux) · threshold + eps`, y refractario `minIntervalSec`. Solo los bins
  entre 70 Hz y 5 kHz. Test: señal sintética con 4 golpes → 4 onsets ± 1 hop; ruido
  blanco estacionario → 0 onsets.

### detector.ts
- `class ChordDetector { constructor(opts: { sampleRate; fftSize = 8192; a4 = 440 }); process(frame: Float32Array /* fftSize muestras, la más reciente al final */, timeSec: number): DetectorFrame }`.
  Cada `process` calcula magnitudes, RMS (dBFS), chroma, onset. `DetectorFrame` (ver
  types) incluye `onset: boolean`, `chroma`, `rmsDb`, `bestChord` (nombre y score) o null
  si `rmsDb < gateDb (-50)`.
- Latencia objetivo: `process` de un frame de 8192 en < 3 ms en Node.
- Test de integración DSP: `synthChord(pcs, sr, seconds)` (suma de armónicos con decaimiento
  exponencial + ruido leve) para acordes reales de guitarra por voicing (E, A, D, G, C, Em,
  Am, Dm) → `matchChord` debe devolver el acorde correcto en top-1 en al menos 7 de 8, y el
  correcto siempre en top-2.

## 6. Audio (navegador)

### mic.ts
- `class MicInput { start(deviceId?): Promise<void>; stop(); onFrame(cb: (frame: Float32Array, timeSec: number) => void); listDevices(): Promise<MediaDeviceInfo[]>; readonly context: AudioContext }`.
  `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId } })`.
  `AnalyserNode.fftSize = 8192`, `smoothingTimeConstant = 0`. Bucle con `setInterval` a ~40 ms
  (hop ≈ 0.04 s; el detector recibe `getFloatTimeDomainData`), `timeSec = context.currentTime`.
- Un único `AudioContext` compartido con el metrónomo (exportar `getAudioContext()` en
  `audio/context.ts`).

### metronome.ts
- `class Metronome { constructor(ctx); scheduleClick(timeSec, accent: boolean); clear() }`.
  Clics de osciladores cortos (1000 Hz acento / 800 Hz normal, 30 ms, envolvente
  exponencial) — agudos y breves para que el detector no los confunda con un rasgueo (el
  onset detector ignora >5 kHz no ayuda aquí; el motor **ignora onsets en ±30 ms de un clic**).

## 7. Motor de práctica (`game/`)

### judge.ts (puro)
- `judgeEvent(event: StrumEvent, evidence: Evidence, opts: JudgeOpts): Verdict`
  - `Evidence = { onsets: number[] /* seg, ya corregidos por latencia */, chromaAt: (t0, t1) => Float32Array /* chroma medio en ventana */ }`
  - `JudgeOpts = { early = 0.15, late = 0.25, analysisWindow = 0.3, minScore = 0.55, margin = 0.05 }`.
  - Si no hay onset en `[t - early, t + late]` → `missed`.
  - Con onset `o` (el más cercano a `t`): chroma medio en `[o + 0.03, o + analysisWindow]`;
    ranking contra plantillas del vocabulario **más** la plantilla del voicing esperado.
    Si el esperado está en top-1, o (en top-2 y `score(expected) ≥ minScore` y
    `best - score(expected) ≤ margin`) → `correct` (con `timing = o - t`). Si no → `wrong`
    con `detected = best.name`.
  - Eventos con acorde `nc` → `skipped`.
- La sesión también rellena `timingLabel`: `'perfect'` si |timing| ≤ 0.07, `'good'` ≤ 0.15,
  `'late'|'early'` en el resto.

### engine.ts
- `class PracticeSession extends EventTarget` (o con `on(event, cb)`):
  - `constructor(song, { detector?: DetectorSource, metronome, ctx, settings })`.
  - `start()`: cuenta atrás de 1 compás (clics acentuados), luego arranca.
    `pause()/resume()/stop()/seekBar(n)`.
  - Reloj: `songTime = (ctx.currentTime - startAt) · tempoScale` — todo en segundos de
    canción; `beatToSec(beat)` con tramos de tempo; `settings.tempoScale` (0.5–1.2).
  - Planifica clics de metrónomo con look-ahead de 0.5 s si `settings.metronome`.
  - Recibe `DetectorFrame`s: guarda onsets (`t - settings.latencySec`), acumula chroma en un
    ring buffer de ~2 s para `chromaAt`.
  - Para cada evento: cuando `songTime > event.time + late + analysisWindow`, juzga y emite
    `verdict`. Si el mic está apagado (`settings.listen = false`), no juzga (verdict `skipped`).
  - `getState(): SessionState` (para el renderer, cada frame): `songTimeSec`, `beat`,
    `currentEventIndex`, `verdicts[]`, `score`, `streak`, `phase: 'countin'|'playing'|'paused'|'ended'`.
  - Al final: `summary: { total, correct, wrong, missed, accuracy, perChord: Record<name, {total, correct}> }`.
- Puntuación: correct = 100 (+10 si perfect), streak bonus ×1.1 cada 5 seguidos; wrong 0;
  missed 0.

## 8. UI

### Pantallas (router simple por hash: `#/`, `#/edit/:id`, `#/play/:id`, `#/settings`)
- **Biblioteca** (`#/`): lista de canciones (ejemplos + del usuario) con título, artista,
  tempo, nº de acordes; botones "Practicar", "Editar", "Duplicar", "Borrar"; "Nueva
  canción"; enlace a Ajustes.
- **Editor** (`#/edit/:id`): textarea grande (monospace) + panel lateral con: errores (línea +
  mensaje), lista de acordes usados con mini-diagrama (amarillo si sin digitación), duración
  total, botón "Probar" (va a Practicar) y "Guardar". Autosave en borrador.
- **Practicar** (`#/play/:id`):
  - Cabecera: título, tempo efectivo, selector de velocidad (50 %–120 %), toggles Metrónomo y
    Escuchar (micrófono), nivel de entrada (barra), acorde detectado en vivo (texto pequeño).
  - Zona superior: diagrama grande del acorde **actual** (con dedos numerados) y pequeño del
    **siguiente** con etiqueta "Siguiente".
  - Autopista (canvas, ancho completo, ~40 % de la altura): 6 líneas horizontales
    (cuerdas; 1ª arriba, 6ª abajo, como mira un diestro su propia guitarra). Línea de golpeo
    vertical fija al 25 % del ancho. Los eventos se desplazan de derecha a izquierda; cada
    evento dibuja en cada cuerda un círculo con el nº de traste (o "0" al aire, nada si
    muteada) y una flecha ↓/↑ de dirección; el nombre del acorde encima del primer evento
    de cada cambio. Líneas verticales tenues por beat, más marcadas por compás. Escala:
    1 beat = ~140 px (ajustable a la anchura).
  - **Pelota**: círculo que salta en parábola de un evento al siguiente y aterriza sobre la
    línea de golpeo exactamente en `event.time` (altura del salto proporcional a la
    duración). Cuando aterriza, onda expansiva. Color según veredicto del último evento.
  - Veredictos: el evento se colorea verde (`correct`), rojo (`wrong`, mostrando el acorde
    detectado debajo), gris (`missed`); texto flotante "¡Perfecto!/¡Bien!/Tarde/Pronto/Mal/…".
  - Pie: puntuación, racha, barra de progreso, botones Pausa/Reanudar, Reiniciar, Salir.
  - Cuenta atrás visual "4 3 2 1" sobre la autopista.
  - Sin micrófono (permiso denegado o `listen` off): la animación funciona igual, sin juicio.
- **Resumen**: precisión %, puntuación, tabla por acorde, botones Repetir / Biblioteca.
- **Ajustes** (`#/settings`): dispositivo de entrada, latencia (ms, slider -100..300) con
  botón "Calibrar" (8 clics de metrónomo; el usuario rasguea con cada uno; latencia =
  mediana de `onset - click`), sensibilidad del onset (umbral), afinación A4, tolerancias.
  Persistido en localStorage (`Settings` en types.ts).

### Estilo
- Tema oscuro, fuente del sistema, acento cian/verde; responsive (funciona en móvil en
  horizontal). `styles.css` con variables CSS.

## 9. Tests (Vitest)
- notes: parseo de símbolos (incluye `Bb`, `F#m7`, `G/B`, `N.C.`, entrada inválida).
- chords: biblioteca sin voicings inválidos (`frets.length === 6`, dedos coherentes),
  `shapePitchClasses(G) ⊇ {G,B,D}`, cejilla generada para `F#m`/`Bbm7`/`C#7`.
- parser: ejemplos de la sección 2, división equitativa, `*n`, errores con línea, cambio de
  tempo a mitad, patrón de rasgueo, evento extra al cambiar acorde sobre `-`.
- fft: vs DFT ingenua; seno puro → pico en el bin correcto.
- chroma/templates: seno puro de 440 Hz → chroma máximo en A; acordes sintetizados → top-1.
- onset: 4 golpes → 4 onsets; ruido → 0.
- judge: casos correct/wrong/missed/perfect/late.
- engine: con un `DetectorSource` falso (inyección de frames), `beatToSec` con cambios de
  tempo, cuenta atrás y resumen.

## 10. Criterios de aceptación
1. `npm run build` y `npm test` en verde.
2. Abrir `npm run dev`, ir a un ejemplo, "Practicar": la autopista se anima, la pelota aterriza
   en la línea de golpeo con cada rasgueo, el diagrama cambia con el acorde.
3. Con micrófono: al tocar el acorde esperado en el momento, evento verde; acorde
   distinto, rojo con el nombre detectado; sin tocar, gris.
4. Editor: crear una canción nueva con el formato de la sección 2, errores visibles con línea.
