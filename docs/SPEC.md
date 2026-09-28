# GuitarZero — Especificación técnica (v2)

App web para practicar guitarra al estilo Yousician: el usuario introduce una canción con
acordes, la app muestra una "autopista" animada con los acordes que se acercan a una línea de
golpeo, una pelota que bota marcando cada rasgueo, el diagrama de dedos del acorde actual, y
escucha por el micrófono para juzgar cada rasgueo: bien (acorde correcto y a tiempo), mal
(acorde incorrecto) o perdido (no sonó nada).

UI en **español**. Código, identificadores y comentarios en **inglés**.

**`src/types.ts` es la fuente de verdad del contrato entre módulos.** Donde este documento
difiera, mandan los nombres y campos de `types.ts`. No cambiar `types.ts` sin avisar.

## 1. Stack y estructura

- Vite 6 + TypeScript 5 (vanilla, sin framework). Canvas 2D para la animación. Web Audio API
  para micrófono y metrónomo. Vitest para tests unitarios (entorno `node`).
- Sin dependencias de runtime (todo el DSP en TS puro, testeable en Node).
- `vite.config.ts` importa `defineConfig` de `'vitest/config'` (no de `'vite'`) para que
  `tsc --noEmit` acepte la clave `test`. No usar `/// <reference types="vitest/config" />`
  ni mover `test` a otro archivo.
- `npm run dev` en localhost es contexto seguro (necesario para `getUserMedia`). Para probar
  en un móvil por LAN haría falta HTTPS (`@vitejs/plugin-basic-ssl`), fuera del MVP.

```
index.html
src/main.ts               bootstrap, router por hash, registro de pantallas
src/styles.css
src/types.ts              contrato compartido (YA ESCRITO)
src/music/notes.ts        nombres de notas, pitch classes, midi<->Hz, parseo de símbolos
src/music/chords.ts       biblioteca de digitaciones + generador de cejillas
src/song/parser.ts        texto -> Song (compases, repeticiones, letra, eventos de rasgueo)
src/song/tempo.ts         beatToSec / secToBeat / songDurationSec (puro)
src/song/examples.ts      canciones de ejemplo (StoredSong[], builtin)
src/song/storage.ts       CRUD en localStorage + ajustes
src/dsp/fft.ts            FFT real radix-2
src/dsp/chroma.ts         espectro -> chroma (peak picking); compresión; plantillas; matching
src/dsp/onset.ts          detector de ataques (spectral flux, banda limitada)
src/dsp/detector.ts       ChordDetector: frame de audio -> DetectorFrame
src/audio/context.ts      AudioContext singleton (YA ESCRITO): getAudioContext(), ensureAudioContext()
src/audio/mic.ts          MicInput: getUserMedia + AnalyserNode + bucle de captura; MicError
src/audio/micDetector.ts  MicDetectorSource: compone MicInput + ChordDetector -> DetectorSource
src/audio/metronome.ts    Metronome implements ClickScheduler
src/audio/calibrate.ts    runCalibration(): mide la latencia con clics
src/game/judge.ts         judgeEvent (puro)
src/game/engine.ts        PracticeSession: reloj, cuenta atrás, bucle, asignación de onsets, veredictos
src/ui/dom.ts             helpers DOM (YA ESCRITO): h(), append(), clear(), qs(), fmtSeconds()
src/ui/highway.ts         HighwayRenderer (canvas): autopista + pelota
src/ui/chordDiagram.ts    drawChordDiagram (canvas)
src/ui/screens/library.ts, editor.ts, practice.ts (incluye la vista Resumen), settings.ts
tests/**                  vitest (tests/helpers/synth.ts: síntesis de audio para tests)
```

## 2. Formato de canción (texto)

```
title: Cielito Lindo
artist: Tradicional
tempo: 120          # pulsos por minuto de la figura del denominador del compás
time: 4/4           # compás: 4/4 (defecto), 3/4, 2/4, 6/8 (en x/8 el pulso es la corchea)
strum: D-DU-UDU     # patrón de rasgueo por compás (ver abajo)
capo: 2             # cejilla: se muestra y la detección se desplaza +2 semitonos

[Intro]             # sección (etiqueta)
C . . . | G . . . | C . G . |
# comentario
[Estrofa]
C G | Am F |        # acordes "desnudos": el compás se reparte a partes iguales (2+2)
Am*3 F |            # Am durante 3 beats, F el beat restante
N.C. | G . . . |    # N.C. = sin acorde (la pelota bota, no se juzga)
- - G . |           # - = silencio de 1 beat (sin rasgueo)
> Ay, ay, ay, ay, canta y no llores    # letra asociada a la línea de compases anterior
[Estribillo]
C . . . | G . . . | x2                  # repite los compases de esta línea 2 veces
[Estrofa]                                # sección vacía = vuelve a insertar la última definición
[Estribillo] x2                          # inserta la sección 2 veces
```

Ejemplo en 3/4:

```
title: Vals
tempo: 90
time: 3/4
strum: D-DUDU
C . . | G . . | G . C |
```

### Reglas del parser (`parseSong(source: string, opts?: { id?: string }): ParseResult`)

- `song.id = opts?.id ?? ''` (storage asigna el id real). `song` siempre existe; no hay
  errores fatales. Los compases con `error` se descartan (también sus eventos); las líneas con
  `warning` se conservan. `errors` ordenado por línea. **Como máximo un error por línea** (el
  primer token inválido); si la línea no contiene `|` el mensaje añade "si es letra, empieza la
  línea con `>`".
- Orden de reconocimiento por línea: (1) línea vacía; (2) letra `>` (primer carácter no blanco);
  (3) comentario `#` — `#` inicia comentario **solo al inicio de línea o precedido por espacio**
  (`/(^|\s)#.*$/`), para no romper `F#m`, `C#7`, `D/F#`; (4) cabecera
  `/^\s*(title|artist|tempo|time|strum|capo)\s*:\s*(.*)$/i`; (5) sección `[texto]` con `x<n>`
  opcional; (6) cualquier otra línea no vacía es una **línea de compases**.
- `tempo` opcional: 80 por defecto con `warning` "tempo no indicado, se usa 80".
  `tempoSegments[0] = { fromBeat: 0, bpm: tempo }` siempre. Un `tempo:` entre compases crea un
  segmento con `fromBeat = startBeat del siguiente compás` (si ya existe uno con ese
  `fromBeat`, lo sustituye). Un `tempo:` antes del primer compás solo fija el inicial.
  `tempo` fuera de 20..400 → `error` (se ignora la cabecera).
- `time:` a mitad aplica a los compases siguientes (`SongBar.beats`); `Song.timeSignature` es
  el inicial. Soportados: `4/4`, `3/4`, `2/4`, `6/8`. Un beat = 1/beatUnit; el tempo se expresa
  en esas unidades; `beatToSec` nunca consulta el compás.
- `strum`: caracteres `[DUx-]`. `D` abajo, `U` arriba, `x` apagado (`muted: true`,
  `direction: 'down'`), `-` nada. Longitud permitida: `beatsPerBar`, `2·beatsPerBar` o
  `4·beatsPerBar` (negras, corcheas o semicorcheas) → `charsPerBeat = length / beatsPerBar`.
  Otra longitud → `error` ("patrón de N caracteres; se esperaban M, 2M o 4M para X/Y") y se
  mantiene el patrón vigente. Patrón por defecto `'D-'.repeat(beatsPerBar)`. Al cambiar `time`,
  si el patrón vigente ya no encaja se vuelve al patrón por defecto (`warning`).
- `capo`: entero 0..12, si no `error`. Por defecto 0.
- Compases: la línea se divide por `|`, se recorta cada segmento y los vacíos se ignoran (barra
  final opcional; una línea sin `|` es un compás). Antes de dividir, se extrae un sufijo
  `x<n>`/`×<n>` final de línea (`/\s+[x×](\d+)\s*$/i`): repite los compases de esa línea n veces
  (1 ≤ n ≤ 32, si no `error`). Un `x2` dentro de un compás es error de símbolo.
- Tokens de un compás: símbolo de acorde (`C`, `Am7`, `F#m`, `Bb`, `G/B`, `Dsus4`, `Cadd9`,
  `N.C.`/`NC`), `.`, `-`, `X*n` (n entero ≥ 1). Un **grupo** = token de acorde, `-` o `N.C.`
  seguido de sus `.`. Duraciones: `X*n` → n beats (explícito); grupo con m puntos → 1+m beats
  (explícito); acorde desnudo → implícito. `restantes = beatsPerBar − Σ explícitos`; `< 0` →
  `error` ("compás sobrepasado"); `== 0` con acordes desnudos pendientes → `error` ("compás
  lleno, X no cabe"). Los grupos implícitos se reparten `restantes` a partes iguales; la parte
  debe ser > 0 y múltiplo de `1/charsPerBeat`, si no `error` ("no se pueden repartir N beats
  entre M acordes; usa `.` o `*n`"). Con esto `C . G |` en 4/4 → C=2, G=2; `C G Am |` → error.
  Un `.` al inicio de compás prolonga el último grupo del compás anterior (`error` si no hay).
  Un compás cuyos grupos suman menos de `beatsPerBar` sin acordes desnudos → `error`
  ("compás incompleto: N de M beats").
- `-` (silencio): no genera eventos; en `SongBar.chords` se guarda
  `{ name: '-', root: -1, quality: 'nc', bass: null }`. `N.C.` sí genera eventos con acorde
  `nc` (veredicto `skipped`, la pelota bota). `chordNames` excluye `nc` y `-`.
- Eventos: por cada compás y cada carácter `D`/`U`/`x` del patrón en la posición `k` se crea un
  `StrumEvent` en `barStart + k/charsPerBeat` con el acorde vigente en ese instante. Si el
  acorde cambia (o empieza tras un silencio) en un instante donde el patrón tiene `-`, se crea
  igualmente un evento `D` en ese instante. Durante un silencio `-` no se crean eventos.
  `chordChange = true` en el primer evento de la canción y en el primero tras un silencio, un
  `N.C.` o un acorde distinto (comparar `root`, `quality` y `bass`, no el texto).
- Secciones y repeticiones: `[Nombre]` etiqueta los compases siguientes hasta la siguiente
  etiqueta (`section: null` antes de la primera). `[Nombre] x<n>` inserta la sección completa n
  veces. `[Nombre]` **sin ningún compás** antes de la siguiente cabecera de sección o el fin del
  texto vuelve a insertar la última definición con ese nombre (comparación ignorando
  mayúsculas y espacios sobrantes), n veces si lleva `x<n>`; si no existe → `error` con línea
  ("sección vacía y no definida antes"). Un `[Nombre]` con compases debajo define o redefine.
  El parser guarda por compás el `strum`, `time` y `tempo` vigentes al definirlo; las copias
  conservan exactamente esos valores (mismos acordes, patrón y tempo), recalculando `index` y
  `startBeat`; `tempoSegments` se reconstruye coalesciendo compases consecutivos con el mismo
  bpm. Los `StrumEvent` se generan DESPUÉS de expandir, sobre la lista final de compases. Las
  cabeceras `tempo:/strum:/time:` solo afectan a compases definidos después, nunca a copias.
  `Song.source` conserva el texto sin expandir.
- Letra: una línea `>` se guarda en `song.lyricLines` con `barIndex` = índice del primer compás
  de la última línea de compases parseada (0 si aún no hay). Nunca genera errores ni compases.
  Las letras de una sección se copian con ella al repetirla/recuperarla (ajustando `barIndex`).
- Acordes desconocidos por la biblioteca NO son error: el parser solo valida la sintaxis.

## 3. Música

### notes.ts
- `NOTE_NAMES_SHARP`, `NOTE_NAMES_FLAT`, `pitchClassOf('F#') === 6` (acepta `#`, `b`, `♯`, `♭`),
  `midiToFreq(midi, a4 = 440)`, `freqToMidi(freq, a4 = 440)`, `noteName(midi, flats = false)`.
- `parseChordSymbol(text): ChordSymbol | null` (null si la sintaxis es inválida). Cualidades e
  intervalos (semitonos desde la fundamental):
  `maj` [0,4,7] (`C`, `Cmaj`, `CM`); `min` [0,3,7] (`Cm`, `Cmin`, `C-`); `7` [0,4,7,10];
  `maj7` [0,4,7,11] (`Cmaj7`, `CM7`, `CΔ7`); `m7` [0,3,7,10] (`Cm7`, `Cmin7`, `C-7`); `dim` [0,3,6]
  (`Cdim`, `C°`); `dim7` [0,3,6,9]; `m7b5` [0,3,6,10] (`Cm7b5`, `Cø`); `aug` [0,4,8] (`Caug`, `C+`);
  `sus2` [0,2,7]; `sus4` [0,5,7] (`Csus4`, `Csus`); `7sus4` [0,5,7,10]; `add9` [0,4,7,2]; `6`
  [0,4,7,9]; `m6` [0,3,7,9]; `9` [0,4,7,10,2]; `5` [0,7]. Bajo alternativo `G/B` → `bass: 11`.
  `N.C.`/`NC`/`-` → `{ root: -1, quality: 'nc', bass: null }`. `name` conserva el texto original.
- `chordPitchClasses(sym): number[]` (únicos, ascendentes; incluye el bajo; `[]` para `nc`).
- `qualityThird(q): 3 | 4 | null` — tercera de la cualidad (maj/7/maj7/add9/6/9 → 4; min/m7/m6/
  dim/dim7/m7b5 → 3; sus/5/aug/nc → null). `swapThirdName(sym)`: nombre del acorde de la misma
  raíz con la otra tercera (`A` ↔ `Am`, `C7` → `Cm7`, `Am7` → `A7`; para cualidades sin
  pareja natural devuelve `<raíz>m` o `<raíz>`).

### chords.ts
- `CHORD_LIBRARY: ChordShape[]` con digitaciones abiertas comunes (mínimo): C, D, E, F, G, A, B;
  Am, Bm, Cm, Dm, Em, Fm, Gm; A7, B7, C7, D7, E7, G7; Am7, Dm7, Em7; Cmaj7, Fmaj7, Amaj7, Dmaj7;
  Asus2, Asus4, Dsus2, Dsus4, Esus4; Cadd9, Gadd9; G/B, D/F#, C/G, Am/G; Bb, Eb, F#m, C#m, G#m,
  Bm7, F#m7; A5, E5, D5, G5. Convención de `types.ts` (índice 0 = 6ª cuerda). `baseFret` = 1
  salvo acordes altos; `frets` son trastes absolutos.
- `getChordShape(symbol: string | ChordSymbol): ChordShape | null`: busca por nombre
  normalizado (enarmónicos `Bb` ≡ `A#`, `CM7` ≡ `Cmaj7`; comparar por `root`+`quality`+`bass`);
  si no existe, **genera una cejilla** a partir de la forma de E (raíz en 6ª: E, Em, E7, Em7,
  Emaj7, Esus4, E5) o de A (raíz en 5ª), para `maj`, `min`, `7`, `m7`, `maj7`, `sus4`, `5`,
  eligiendo la forma con el traste base más bajo (≥ 1), `generated: true`, `barre` correcto.
  Devuelve `null` para cualidades no generables, `nc`, o sintaxis inválida.
- `shapePitchClasses(shape): number[]` (únicos, ascendentes) y `shapeMidiNotes(shape): number[]`
  a partir de la afinación estándar E2 A2 D3 G3 B3 E4 (midi 40 45 50 55 59 64).

## 4. DSP (todo con `Float32Array`, sin Web Audio, testeable en Node)

### fft.ts
- `class RealFFT { constructor(size /* potencia de 2 */); forward(input, outRe, outIm); magnitudes(input, outMag /* size/2+1 */, windowed = true) }`.
  Ventana Hann dentro de `magnitudes`. Magnitudes **sin normalizar** (sin 1/N). Test contra DFT
  ingenua (16 y 64) y seno puro → pico en el bin correcto.

### chroma.ts
- `computeEnergyChroma(mag, sampleRate, fftSize, opts: { a4 = 440 }, out?: Float32Array(12)): Float32Array`
  — chroma de energía por **peak picking** (sin sumar bins por banda, que mezcla E2/F2):
  1. `df = sampleRate / fftSize`; banda `kLo = max(1, floor(midiToFreq(40)·2^(-50/1200)/df))`,
     `kHi = min(fftSize/2 − 1, ceil(midiToFreq(88)·2^(50/1200)/df))`.
  2. `peakFloor = 8 · median(mag[kLo..kHi])` (mediana sobre una copia del tramo).
  3. Para cada `k` con `mag[k] > mag[k−1] && mag[k] >= mag[k+1] && mag[k] > peakFloor`:
     interpolación parabólica en log: `a = ln(mag[k−1]+1e-12)`, `b = ln(mag[k]+1e-12)`,
     `g = ln(mag[k+1]+1e-12)`, `den = a − 2b + g`, `d = den === 0 ? 0 : clamp(0.5·(a−g)/den, −0.5, 0.5)`,
     `f = (k+d)·df`, `energy = exp(2·(b − 0.25·(a−g)·d))`, `midi = round(69 + 12·log2(f/a4))`;
     descartar si `midi < 40 || midi > 88 || |1200·log2(f/midiToFreq(midi))| > 50`;
     `out[midi % 12] += octaveWeight(midi) · energy`, con `octaveWeight` lineal 1.0 (midi 40) →
     0.6 (midi 88).
  4. Limitación documentada: dos parciales a menos de ~2 bins (~12 Hz a 48 kHz) se funden.
- `compressChroma(energy, gamma = 10, out?): Float32Array` — `e' = e / max(e)` (si `max == 0`
  → ceros), `c = log(1 + γ·e') / log(1 + γ)`, luego L2 = 1. Invariante de escala:
  `compress(x) == compress(0.01·x)`.
- `rollChroma(v, shift, out?)`: `out[pc] = v[(pc + shift) % 12]` (sonante = escrito + shift;
  el bin escrito lee el bin sonante `shift` semitonos más arriba). `shift` ya normalizado 0..11.
- `templateForPitchClasses(pcs, name, root, quality, gamma = 10): ChordTemplate` — en el
  **dominio de energía**: por cada nota `p` armónicos `h = 1..6` con energía `(0.6^(h−1))²` en
  el pitch class `(p + [0,12,19,24,28,31][h−1]) % 12`; luego **el mismo camino** que el chroma:
  `compressChroma(energy, gamma)`. `pcs` guarda las notas del acorde (únicas, ascendentes).
- `buildTemplates(gamma = 10): ChordTemplate[]` — 12 raíces × { maj, min, 7, m7, maj7, sus2,
  sus4 } (84) con `chordPitchClasses` de `notes.ts`; nombre con sostenidos (`F#m`).
- `cosine(a, b): number` (0 si alguno es nulo, nunca NaN).
- `matchChord(chroma, templates): { best: ChordTemplate | null, score, ranked }` — coseno; con
  chroma nulo devuelve `best: null, score: 0, ranked: []`.
- `mergeExpectedTemplate(templates, expected): ChordTemplate[]` — devuelve el vocabulario con
  la plantilla esperada **sustituyendo** a la entrada con el mismo conjunto `pcs` (o añadida si
  no hay), para que top-1 nunca tenga dos veces el mismo acorde.

### onset.ts
- `class OnsetDetector { constructor(sampleRate, fftSize, opts: { hopSeconds = 0.04; minIntervalSec = 0.1; threshold = 1.5; historyFrames = 24; loHz = 70; hiHz = 3500 }); process(mag: Float32Array, timeSec: number): boolean; setThreshold(t) }`.
  Spectral flux con rectificación de media onda sobre `log(1 + mag)`, **solo los bins entre
  `loHz` y `hiHz`** (el clic del metrónomo vive por encima). Umbral adaptativo
  `median(últimos N flux) · threshold + eps`, con `eps` un suelo absoluto pequeño (fijado por el
  test "ruido/silencio → 0 onsets"). Refractario `minIntervalSec` usando el delta real entre
  `timeSec` consecutivos. El primer frame nunca es onset.
- Tests: 4 golpes sintéticos → 4 onsets (±1 hop); ruido blanco estacionario → 0; silencio → 0;
  ráfagas de clic a 4500 y 5500 Hz (25 ms, ataque 3 ms, τ = 8 ms, −20 dBFS) sobre silencio → 0
  onsets; clic + rasgueo 60 ms después → exactamente 1 onset.

### detector.ts
- `class ChordDetector { constructor(sampleRate: number, opts?: DetectorOpts); process(frame: Float32Array /* fftSize muestras, la más reciente al final */, timeSec: number): DetectorFrame; setOptions(patch: Partial<Pick<DetectorOpts, 'a4'|'gateDb'|'onsetThreshold'>>); setTranspose(semitones: number); getNoiseFloorDb(): number; getGateDb(): number }`.
  Cada `process`: magnitudes (Hann, sin normalizar) → `rmsDb` (RMS del frame en dBFS) →
  seguimiento del suelo de ruido → puerta → chroma → onset. Devuelve un `DetectorFrame` nuevo
  (no reutilizar arrays entre frames: el motor los guarda en un ring buffer).
- **Suelo de ruido y puerta**: ring buffer de los últimos 75 `rmsDb`. `noiseFloor` = percentil 10
  del buffer, actualizado solo cuando no se ha aceptado ningún onset en el último 1 s (así la
  cuenta atrás, silencios y pausas lo fijan); se inicializa con los primeros 0.5 s de frames
  (hasta entonces `noiseFloor = −100`). `gate = max(opts.gateDb, noiseFloor + 10)`. Si
  `rmsDb < gate`: `energyChroma` y `chroma` a ceros, `bestChord = null`, `onset = false`.
- **Onset**: `OnsetDetector.process(mag, timeSec)`; si dispara y `rmsDb >= gate` → `onset =
  true` y **refinamiento del instante**: RMS en bloques de 128 muestras (dB) sobre las últimas
  ~200 ms del frame; elegir el bloque con mayor subida respecto al bloque ~10 ms anterior
  (≈4 bloques); si la subida ≥ 6 dB, `onsetTimeSec = timeSec − (N − onsetSample)/sampleRate`;
  si no, `onsetTimeSec = timeSec − hop` (fallback). Test: golpe sintético en instante conocido
  → `onsetTimeSec` a ±5 ms.
- **Chroma**: `computeEnergyChroma` → `rollChroma(·, transpose)` → `energyChroma`;
  `chroma = compressChroma(energyChroma, gamma)`; `bestChord = matchChord(chroma, templates)`
  (vocabulario `buildTemplates` construido una vez en el constructor; `bestChord = null` si
  `score === 0`).
- `setTranspose(s)` guarda `((s % 12) + 12) % 12`. Con transposición, `chroma`, `energyChroma` y
  `bestChord` ya están en espacio escrito.
- Rendimiento: `process` de un frame de 8192 en < 3 ms en Node.
- Test de integración (`tests/helpers/synth.ts` — exportar `synthChord`, `synthStrum`, `synthClick`,
  `silence`, `mix`): `synthChord(midiNotes, sampleRate, seconds, opts)` con armónicos 1..8 y
  pesos `0.7^(h−1)`, decaimiento exponencial por cuerda (graves 1.5 s, agudos 0.6 s), variación
  aleatoria ±30 % por armónico (semilla fija), cuerdas graves 6 dB más fuertes, ataque de 10 ms
  de ruido. Voicings reales de E, A, D, G, C, Em, Am, Dm (de `CHORD_LIBRARY`) →
  `matchChord(compress(energyChroma))` top-1 correcto en ≥ 7 de 8 y siempre en top-2, a 44100 y
  48000 Hz y a −20 y −44 dBFS. Senos puros E2 (82.41), F2 (87.31), A2 (110) a 44100, 48000 y
  96000 → `chroma[pc] ≥ 0.95` y el resto ≤ 0.1. E2+B2 → E y B ≥ 0.5, F y C ≤ 0.1.
  `rollChroma(chroma(A mayor), 2)` → máximos en G, B, D.

## 5. Audio (navegador)

### context.ts (ya escrito)
`getAudioContext()` (singleton perezoso) y `ensureAudioContext()` (resume). Regla: nunca crear
ni reanudar el contexto al montar una pantalla, solo dentro de un handler de click/touch, y
llamar a `resume()` **antes de cualquier `await`** (iOS). Un contexto `suspended` tiene
`currentTime` congelado: el reloj de la sesión y el metrónomo no avanzan.

### mic.ts
- `class MicInput { constructor(fftSize = 8192); readonly fftSize; readonly context: AudioContext; start(deviceId?: string): Promise<void>; stop(): void; onFrame(cb: (frame: Float32Array, timeSec: number) => void): () => void; listDevices(): Promise<MediaDeviceInfo[]>; getTrackSettings(): MediaTrackSettings | null; isRunning(): boolean }`.
- `start(deviceId?, opts?: { echoCancellation?: boolean; autoGainControl?: boolean })`: `getUserMedia({ audio: { echoCancellation: opts.echoCancellation ?? false, noiseSuppression: false, autoGainControl: opts.autoGainControl ?? false, deviceId /* valor "ideal", no exact */ } })`.
  `noiseSuppression` siempre false. `autoGainControl` false por defecto (practice.ts avisa si el
  track lo reporta activado: distorsiona la amplitud que usan el juicio de acordes/onsets), pero
  el afinador (`#/tuner`) lo pide a `true` — una sola nota sostenida no tiene nada de amplitud que
  juzgar, y una guitarra acústica floja sin amplificar se beneficia mucho del refuerzo automático.
  Rechaza con `class MicError extends Error { code: 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'device' }`
  (`insecure` si `!window.isSecureContext`; `unsupported` si no hay `getUserMedia`; `denied` ←
  `NotAllowedError`/`SecurityError`; `notfound` ← `NotFoundError`; `device` ← el resto).
  `AnalyserNode.fftSize = fftSize`, `smoothingTimeConstant = 0`. Bucle `setInterval` ~40 ms que
  llama a `getFloatTimeDomainData` en un buffer **nuevo por frame** y a los suscriptores con
  `timeSec = context.currentTime` (RAW, sin corregir latencia; solo el motor la aplica). Varios
  suscriptores; `onFrame` devuelve unsubscribe. `stop()` para el intervalo y las pistas.
- `listDevices()` solo tiene etiquetas tras un `start()` con permiso.

### micDetector.ts
- `class MicDetectorSource implements DetectorSource { constructor(mic: MicInput, opts: DetectorOpts); onFrame(cb): () => void; setOptions(patch); setTranspose(s); readonly detector: ChordDetector }`
  — crea `new ChordDetector(mic.context.sampleRate, { ...opts, fftSize: mic.fftSize })` y hace
  fan-out de un `DetectorFrame` por frame del mic.
- `detectorOptsFromSettings(s: Settings): DetectorOpts` → `{ a4, gateDb, onsetThreshold }`.

### metronome.ts
- `class Metronome implements ClickScheduler { constructor(ctx: AudioContext); scheduleClick(nominalSec, accent); clear(); setEnabled(b) }`.
  Clic **espectralmente separado** del análisis: seno a **4500 Hz (normal) / 5500 Hz (acento)**,
  ganancia 0 → 0.5 con rampa lineal de 3 ms, luego `setTargetAtTime(0, t + 0.003, 0.008)`,
  `osc.stop(t + 0.05)`. Rationale: el chroma solo mira MIDI 40..88 (+50 cents ≈ 1358 Hz) y el
  flujo de onsets se corta en 3500 Hz, así que el clic no puede crear ni onsets ni energía de
  chroma. **No existe ningún filtro temporal de onsets cerca de un clic** (un rasgueo perfecto
  coincide con el clic por construcción).
- `scheduleClick(nominal)` arranca el oscilador en `nominal − (ctx.outputLatency || 0.03)` para
  que se **oiga** en el instante nominal (cuando la pelota aterriza). `clear()` para todos los
  osciladores pendientes (guardar referencias). `setEnabled(false)` hace que `scheduleClick` sea
  no-op (sin romper la planificación del motor).

### calibrate.ts
- `runCalibration(source: DetectorSource, clicks: ClickScheduler, clock: Clock, opts?: { n = 8; intervalSec = 1; onProgress?: (i) => void }): Promise<{ latencySec: number; samples: number[] } >`
  — programa `n` clics nominales a `clock.now() + 1 + i·intervalSec`; para cada clic toma el
  onset RAW (`onsetTimeSec ?? timeSec`) más cercano en `[nominal − 0.15, nominal + 0.5]`;
  exige ≥ 5 muestras y desviación absoluta mediana ≤ 0.04 s, si no rechaza con
  `CalibrationError` (mensaje en español: "No se detectaron suficientes rasgueos" /
  "Demasiada variación, repite la calibración"); `latencySec = median(onset − nominal)`
  acotado a [−0.1, 0.5]. Con el clic fuera de banda, los únicos onsets son los rasgueos del
  usuario, y `median(onset − nominal)` mide exactamente el desfase que ve el juez cuando el
  usuario sigue el metrónomo/pelota. Termina (resuelve o rechaza) como muy tarde 1 s después
  del último clic, usando `setTimeout`. Test con `DetectorSource`, `ClickScheduler` y `Clock` falsos.

## 6. tempo.ts (puro)
- `beatToSec(segments: TempoSegment[], beat): number` (tramos; extrapolación lineal con
  `segments[0]` para `beat < 0`), `secToBeat(segments, sec)`, `songDurationSec(song)` =
  `beatToSec(song.tempoSegments, song.totalBeats)` (sin `tempoScale`).
- Tests: `[{0,120},{8,60}]` → `beatToSec(12) === 8`; `beatToSec(−4) === −2`;
  `secToBeat(beatToSec(b)) ≈ b` para varios b incluidos negativos; un compás de 6/8 a 120 dura 3 s.

## 7. Motor de práctica (`game/`)

### judge.ts (puro)
`judgeEvent(input: JudgeInput, evidence: Evidence, opts: JudgeOpts): JudgeResult`.
Todo en segundos de reloj (wall). Reglas, en orden:
1. `input.chord.quality === 'nc'` → `kind: 'skipped'`, `timingLabel: null`.
2. `evidence.onset === null` → `missed`.
3. `timing = onset − expectedSec`; `timingLabel` = `perfect` si `|timing| ≤ perfectSec`, `good`
   si `≤ goodSec`, si no `early`/`late` según el signo.
4. `input.muted` → `correct` (solo timing, sin chroma).
5. `t0 = onset + 0.02`; `t1 = min(onset + analysisWindowSec, nextOnset − 0.02 si hay)`; si
   `t1 − t0 < 0.05` → `t1 = t0 + 0.05`. `c = chromaAt(t0, t1)`. Si `c` es todo ceros → `missed`
   (`timing` y `timingLabel: null` se descartan: el veredicto `missed` no lleva timing).
6. `vocab = mergeExpectedTemplate(opts.templates, input.expectedTemplate)`;
   `{ best } = matchChord(c, vocab)`; `expectedScore = cosine(c, expectedTemplate.vector)`.
   `E = input.expectedPcs`, `B = best.pcs`.
7. `expectedScore < minScore` → `wrong`, `detected = best.name`.
8. Si `B ≠ E` (como conjuntos): si `B ⊇ E`, `d = min_{p∈E} c[p] − max_{p∈B\E} c[p]`; si no,
   `d = mean_{p∈E\B} c[p] − mean_{p∈B\E} c[p]` (media de conjunto vacío = 0). `d < 0` → `wrong`,
   `detected = best.name`.
9. Comprobación de tercera, **siempre**: `third = qualityThird(input.chord.quality)`; si no es
   null, `other = third === 4 ? 3 : 4`; si `c[(root+third)%12] < c[(root+other)%12]` → `wrong`,
   `detected = swapThirdName(input.chord)`.
10. Si no, `correct` con `timing`, `timingLabel`, `expectedScore`.
`timingLabel` solo es no-null cuando `kind === 'correct'`; `timing` se incluye en `correct` y
`wrong`. `detected` solo en `wrong`.

### engine.ts
`class PracticeSession` — `constructor(song: Song, deps: SessionDeps)`.
- `on<K extends keyof SessionEvents>(k: K, cb: (e: SessionEvents[K]) => void): () => void`.
  Sin `EventTarget`. **Sin temporizadores propios**: la pantalla llama `update()` en cada rAF;
  los tests lo llaman a mano con un `Clock` falso.
- **Reloj**: `segments = song.tempoSegments`; `songSec(beat) = beatToSec(segments, beat)`.
  Anclaje en cada arranque (`playFrom`): `anchorBeat = startBeat − beatsPerBar(compás de
  arranque)`, `anchorWall = clock.now() + 0.1`. `wallSec(beat) = anchorWall + (songSec(beat) −
  songSec(anchorBeat)) / tempoScale`. `beat(now) = secToBeat(segments, songSec(anchorBeat) +
  (now − anchorWall) · tempoScale)`. `songTimeSec = songSec(beat)`. `tempoScale` solo afecta al
  reloj; tolerancias, latencia y ventanas son segundos reales.
- **Fases** (`phase = 'idle'` tras el constructor):
  - `playFrom(barIndex)` (interno): `startBeat = bars[barIndex].startBeat`; borra `verdicts[i]` y
    `hits[i]` de eventos con `time >= startBeat`; vacía los buffers de evidencia (onsets y ring
    de chroma); recalcula `score`, `streak` y `bestStreak` recorriendo `verdicts`; ancla el
    reloj; `phase = 'countin'` (clics acentuados en cada beat entero de
    `[anchorBeat, startBeat)`; `countInBeatsLeft = ceil(startBeat − beat)`); al llegar a
    `beat >= startBeat` → `'playing'`. Emite `phase` en cada transición.
  - `start(fromBar = 0)`: solo en `'idle'`; = `playFrom(fromBar)`.
  - `pause()`: solo en `'countin'`/`'playing'`; congela (`pausedBeat = beat`), `clicks.clear()`,
    ignora `DetectorFrame`s mientras dura, `phase = 'paused'`.
  - `resume()`: solo en `'paused'`; = `playFrom(índice del compás que contiene max(0, pausedBeat))`
    (cuenta atrás de 1 compás y se repite el compás actual completo).
  - `seekBar(n)`: solo en `'idle'`/`'paused'`; `n` acotado a `[0, bars.length − 1]`; fija la
    posición (`pausedBeat = bars[n].startBeat`), borra veredictos con `time >= startBeat` y marca
    `skipped` (0 puntos) los anteriores sin veredicto; no arranca.
  - `setLoop(range: LoopRange | null)`: en cualquier fase no terminada; fin del bucle =
    `bars[toBar].startBeat + bars[toBar].beats`. Al alcanzar el fin del bucle (con margen para
    juzgar los últimos eventos: cuando `now ≥ wallSec(loopEndBeat) + latencySec + lateSec +
    analysisWindowSec + 0.1`, o cuando todos los eventos del tramo tienen veredicto), se vuelcan
    los veredictos de la pasada a los contadores acumulados, `pass++`, y `playFrom(fromBar)`
    (con cuenta atrás). Los onsets durante la cuenta atrás no caen en ninguna ventana y se
    ignoran. Con bucle activo la sesión no termina sola.
  - Fin natural (sin bucle): cuando `now ≥ wallSec(song.totalBeats) + latencySec + lateSec +
    analysisWindowSec + 0.1` → `finish('finished')`.
  - `stop()`: en cualquier fase salvo `'ended'` → `finish('stopped')`.
  - `finish(reason)`: `clicks.clear()`, los eventos de la pasada actual sin veredicto pasan a
    `skipped`, se calcula `summary` (acumulados de todas las pasadas + la actual), `phase =
    'ended'`, emite `ended`; después la sesión es inerte (todos los métodos son no-op).
  - `setSettings(patch: Partial<Settings>)`: `metronome`/`listen`/tolerancias/`latencySec` se
    aplican en vivo; `tempoScale` solo en `'idle'`/`'paused'`.
  - `getState(): SessionState` — lectura pura, O(1), puede devolver el mismo objeto mutado (el
    renderer no lo muta). `update(): SessionState` = avanzar + `getState()`.
- **Metrónomo**: en `update()`, si `settings.metronome && deps.clicks`, planifica con 0.5 s de
  antelación los clics de los beats enteros (acento en el primer beat de cada compás y en la
  cuenta atrás) hasta el fin de la canción/bucle. Llevar `lastScheduledBeat`.
- **Evidencia** (solo si `deps.detector && settings.listen`; si no, todos los eventos reciben
  `skipped` cuando pasa su instante):
  - Al recibir un `DetectorFrame` (ignorado en `'paused'`/`'idle'`/`'ended'`): guardar en un ring
    buffer de ~3 s `{ start: timeSec − fftSize/sampleRate, end: timeSec, energyChroma, gated:
    max(energyChroma) === 0 }` (`fftSize/sampleRate` = 8192/`ctx.sampleRate`; pasar
    `frameSeconds` en el constructor de la sesión si se quiere; por defecto 8192/48000). Si
    `frame.onset`, `o = frame.onsetTimeSec ?? frame.timeSec`; añadir a la lista de onsets (RAW);
    **asignación**: buscar el evento no-`nc` sin onset asignado cuya ventana
    `[expectedSec(e) − earlySec, expectedSec(e) + lateSec]` contenga `o`, el más cercano por
    `|o − expectedSec(e)|` (con `expectedSec(e) = wallSec(e.time) + latencySec`); si existe,
    `hits[e] = { eventIndex, timing: o − expectedSec, timingLabel }` y emitir `hit`. Un onset se
    asigna como máximo a un evento y viceversa.
  - `live` se actualiza con cada frame (`rmsDb`, `bestChord`, `gateDb` del detector si expone
    `getGateDb`, si no `settings.gateDb`).
  - **Veredicto** del evento `e` (en `update()`), en orden de índice:
    - con onset asignado `o`: cuando el último frame recibido tiene `end ≥ min(o +
      analysisWindowSec, nextOnset − 0.02)` (el ring ya cubre la ventana) → `judgeEvent` con
      `Evidence = { onset: o, nextOnset, chromaAt }`;
    - sin onset: cuando el último frame recibido tiene `end > expectedSec(e) + lateSec + 0.05`
      (o `now > expectedSec + lateSec + 0.5` como respaldo si no llegan frames) → `missed`;
    - `nc` → `skipped` cuando `now ≥ expectedSec(e)`.
    `chromaAt(t0, t1)`: media de `energyChroma` de los frames no gated con `start ≥ t0 && end ≤
    t1`; si ninguno cabe, el frame no gated con mayor solapamiento con `[t0, t1]`; si todos
    están gated → ceros; luego `compressChroma`. El motor construye `JudgeOpts` una vez
    (`templates = buildTemplates()`, tolerancias de `settings`, `analysisWindowSec = 0.3`,
    `minScore = 0.6`, `perfectSec = 0.07`, `goodSec = 0.15`) y cachea por nombre de acorde
    `expectedPcs`/`expectedTemplate` (`deps.shapes[name]` → `shapePitchClasses`, si es `null`
    → `chordPitchClasses(chord)`).
  - `points` (motor): `streak` cuenta `correct` consecutivos incluyendo el actual; `wrong` y
    `missed` ponen `streak = 0` y valen 0; `skipped` no altera la racha y vale 0.
    `points = round((100 + (timingLabel === 'perfect' ? 10 : 0)) · 1.1 ** min(floor(streak / 5), 5))`.
    `score = Σ points`; `bestStreak = máximo de streak`. `Verdict = { ...result, points }`,
    guardado en `verdicts[eventIndex]`, emitido como `verdict`.
- **Capo/afinación**: la pantalla llama `source.setTranspose(song.capo + settings.tuningOffset)`;
  el motor no transpone nada (los frames ya vienen en espacio escrito).
- **Resumen**: `total = eventos juzgados en todas las pasadas` (`correct + wrong + missed +
  skipped === total`), `accuracy = judged > 0 ? correct / judged : 0` con `judged = total −
  skipped`, `passes`, `medianTimingSec` (mediana de `timing` de los `correct`, `null` si < 4),
  `perChord[name]` (excluye `skipped`), `score`, `bestStreak`.
- Invariantes: `verdicts.length === hits.length === song.events.length` (prealocado con
  `undefined`); `summary.score === state.score`.

## 8. UI

### Router y almacenamiento
- Rutas: `#/` (Biblioteca), `#/edit/:id`, `#/play/:id`, `#/settings`. Ids `[a-z0-9_:-]+`
  (`newId()` → `s_<base36 timestamp><4 aleatorios>`; sin `crypto.randomUUID`). Ruta desconocida o
  id inexistente → `location.replace('#/')`. Resumen no es ruta: es la vista de Practicar
  cuando `phase === 'ended'`.
- `main.ts`: `current: (() => void) | null`; en carga inicial y en cada `hashchange`:
  `current?.()`, `root.replaceChildren()`, `current = screen.mount(root, params)`.
- `examples.ts` exporta `EXAMPLE_SONGS: StoredSong[]` con `id: 'ex:<slug>'`, `builtin: true`
  (nunca se persisten). Al menos 6 ejemplos, en conjunto cubriendo: 4/4 y 3/4, `*n`, `N.C.`,
  silencios `-`, cambio de tempo, patrón con `U` y `x`, repeticiones (`x2`, `[Sección] x2`,
  recuperación de sección), letra `>`, capo. Sugeridos (dominio público/tradicionales o
  progresiones genéricas): "Progresión pop (C G Am F)", "Blues en A (12 compases)", "Cielito
  Lindo" (3/4), "Cumpleaños feliz" (3/4), "Amazing Grace" (3/4), "Balada Em C G D", "La Bamba"
  (C F G). Todos deben parsear **sin errores ni warnings** (test).
- `storage.ts`: claves `guitarzero.songs` (`{ version: 1, songs: StoredSong[] }`) y
  `guitarzero.settings` (`{ version: 1, settings: Partial<Settings> }`); versión distinta o JSON
  inválido → `console.warn` y vacío. Todo acceso a `localStorage` en try/catch con copia en
  memoria como fallback. API: `listSongs(): StoredSong[]` (ejemplos + usuario, usuario por
  `updatedAt` desc), `getSong(id): StoredSong | null`, `saveSong(s)` (fija `updatedAt`; ignora
  builtin), `deleteSong(id)`, `duplicateSong(id): StoredSong` (título + " (copia)"),
  `newSong(template?): StoredSong`, `newId()`, `loadSettings(): Settings` =
  `{ ...DEFAULT_SETTINGS, ...pick(stored, keys(DEFAULT_SETTINGS)) }` con clamps (`tempoScale`
  0.5..1.2, `latencySec` −0.1..0.5, `earlySec`/`lateSec` 0..1, `a4` 415..466, `tuningOffset`
  −12..12), `saveSettings(s)`, `getFlag(name): boolean` / `setFlag(name, v)` (p. ej.
  `latencyCalibrated`, `loop:<songId>`).

### Biblioteca (`#/`)
Lista de canciones (ejemplos con etiqueta "Ejemplo" + del usuario) con título, artista, tempo,
compás, nº de acordes, duración; botones "Practicar", "Editar" (en builtin = duplicar y abrir
la copia), "Duplicar", "Borrar" (deshabilitado en builtin, con confirmación); "Nueva canción"
(crea `newSong()` con plantilla `title: Nueva canción\ntempo: 80\n\nC . . . | G . . . |` y navega
a `#/edit/<id>`); "Progresión rápida" (plantilla `title: Progresión\ntempo: 80\nstrum: D-DU-UDU\n\nC | G | Am | F |`
y abre el Editor); enlace a Ajustes. Cabecera con el nombre de la app.

### Editor (`#/edit/:id`)
Textarea grande (monospace) + panel lateral con: errores y warnings (línea + mensaje, click
lleva a la línea), lista de acordes usados con mini-diagrama (amarillo + "sin digitación" si
`getChordShape` es null), compases, duración total (`songDurationSec`, expandida), botones
"Probar" (flush + `#/play/:id`) y "Guardar" (flush + feedback visual "Guardado"), "Volver".
Autosave = `saveSong` con debounce 500 ms y flush en unmount. `<details>` plegable "Formato" con
la gramática de la sección 2 resumida (incluyendo `>`, `x2`, `*n`, `-`, `N.C.`). `#/edit/ex:*`
directo → `location.replace('#/')`.

### Practicar (`#/play/:id`)
- Al montar: parsea `getSong(id).source`; construye `shapes` (`getChordShape` por
  `song.chordNames`, clave = nombre tal como lo escribió el usuario); crea `MicInput`,
  `MicDetectorSource(mic, detectorOptsFromSettings(settings))` (+ `setTranspose(song.capo +
  settings.tuningOffset)`), `Metronome(getAudioContext())` **sin reanudar el contexto** y la
  `PracticeSession` con `clock = { now: () => ctx.currentTime }`. `phase = 'idle'` con una capa
  "Empezar" grande sobre la autopista (también Espacio). Nunca arranca sola.
- Handler de "Empezar", en este orden: `getAudioContext().resume()` (síncrono, antes de
  cualquier `await`); si `settings.listen`, `try { await mic.start(settings.inputDeviceId ??
  undefined) } catch (e: MicError) { mostrar el motivo en español y continuar con
  `live.listening = false` }`; `navigator.wakeLock?.request('screen')` en try/catch; luego
  `session.start()` (o `seekBar` + `start` según la sección elegida).
- Durante `'idle'` el HUD ya muestra nivel de entrada y acorde detectado en cuanto el mic está
  activo (botón "Probar micrófono" que hace `mic.start()` sin arrancar la sesión), para
  comprobar que la app oye la guitarra.
- Cabecera (una fila): título; tempo efectivo; selector de velocidad (50 %–120 %, paso 10;
  si está sonando → `pause()`, aplicar, `resume()`); toggle Metrónomo; toggle Escuchar con estado
  del micrófono ("Micrófono: activo | permiso denegado [Reintentar] | sin dispositivo |
  desactivado | no seguro (usa https/localhost)"); barra de nivel de entrada con marca en el
  umbral (`live.gateDb`); acorde detectado en vivo (≥ 24 px); toggle "Repetir" (atajo `L`) y,
  solo si la canción tiene secciones, desplegable "Sección" ("Toda la canción" + un tramo por
  bloque contiguo de compases con la misma etiqueta, "Estrofa (c. 5–12)"); insignia "Sin
  evaluación" cuando no se escucha. Pista: "Usa auriculares para que el micrófono no capte el
  metrónomo". Aviso no bloqueante si `mic.getTrackSettings()` indica `autoGainControl`,
  `noiseSuppression` o `echoCancellation` activados o indefinidos.
- Banner descartable mientras `!getFlag('latencyCalibrated')`: "Primera vez con micrófono:
  calibra la latencia (unos 10 s) para que 'a tiempo' sea a tiempo" → `#/settings`.
- Zona de diagramas: actual grande (dedos numerados) + siguiente pequeño con "Siguiente".
  Actual = `song.events[max(nextEventIndex − 1, 0)].chord`; siguiente = primer evento
  `j ≥ nextEventIndex` con `chordChange` y nombre distinto.
- **Autopista** (`HighwayRenderer`): 6 líneas horizontales (cuerdas; 1ª arriba, 6ª abajo como en
  una tablatura; `settings.invertStrings` pone la 6ª arriba: `rowOf(i) = invert ? i : 5 − i`).
  Línea de golpeo vertical fija en `strikeX = 0.25 · width`. Se dibuja en beats:
  `x = strikeX + (event.time − state.beat) · pxPerBeat`, `pxPerBeat = clamp(width / 8, 90, 160)`.
  Líneas verticales tenues por beat, más marcadas por compás, con el nº de compás y la
  etiqueta de sección. Marcadores: si `event.chordChange` → columna completa (círculo con nº de
  traste por cuerda, "0" al aire, nada si muteada) con el nombre encima; resto de eventos →
  barra vertical fina que cruza las 6 cuerdas con flecha ↓/↑ (más tenue para `up`); `muted` →
  X sobre las cuerdas; `nc` → solo la etiqueta "N.C."; `shapes[name] === null` → marcador único
  con el nombre en amarillo. Letra: bloque DOM bajo el canvas con la línea actual (última con
  `barIndex ≤ compás actual`) resaltada y la siguiente en gris; oculto si no hay letra.
- **Pelota**: X fija en la línea de golpeo, bota en vertical: `y = h · 4f(1−f)` con
  `f = (beat − t_i) / (t_{i+1} − t_i)` entre eventos consecutivos (incluidos `nc`);
  `h = clamp(0.5 · Δbeats · pxPerBeat, 24, 0.6 · alto)`. Al aterrizar (`beat − t_i < 0.5` beats),
  onda expansiva. En la cuenta atrás bota en cada beat con altura fija y el número encima
  (`beatsPerBar … 1`), y el último bote aterriza sobre el primer evento. Color: neutro; flash
  breve (~0.4 s) del color del último veredicto emitido; en modo sin evaluación siempre neutro.
- **Feedback en dos fases**: al aparecer `state.hits[i]` → anillo blanco en el evento + texto
  flotante del timing ("¡Perfecto!" / "¡Bien!" / "Tarde" / "Pronto") en color neutro; al
  aparecer `state.verdicts[i]` → colorear el marcador verde (`correct`), rojo (`wrong`, con el
  acorde detectado debajo y "Mal"), gris (`missed`, "Perdido"). El renderer cachea por
  identidad de objeto (`Map<index, {hit, verdict, firstSeenMs}>`): entrada nueva → `firstSeenMs
  = nowMs`, anima 1 s; si el objeto deja de coincidir (Reiniciar/seek) se descarta.
- Pie: puntuación, racha, "Pasada N" si hay bucle, barra de progreso (del tramo si hay bucle),
  botones Pausa/Reanudar, Reiniciar (`stop()` ignorando ese `ended`, nueva sesión, `start()`),
  Salir (`stop()` → Resumen). Toque/click en el canvas = pausa/reanudar. Teclado: Espacio =
  empezar/pausa/reanudar, `R` = reiniciar, `Esc` = salir, `L` = bucle. `visibilitychange` oculto
  o `ctx.state !== 'running'` → `pause()`; al reanudar (siempre desde un gesto) `ctx.resume()`,
  si la pista del mic terminó → `mic.start()`, y volver a pedir el wake lock.
- Estado inicial de "Repetir": el valor guardado (`getFlag('loop:<id>')`) o, si no hay, ON si
  la canción no tiene secciones y tiene ≤ 8 compases; se guarda al cambiarlo. Con bucle,
  `setLoop` cubre la sección elegida o toda la canción.
- **Resumen** (misma pantalla, `phase === 'ended'`): precisión % (o "Sesión sin evaluación
  (micrófono desactivado)" si `judged === 0`), puntuación, mejor racha, pasadas, tabla por
  acorde (acierto %, o "—"), pista de latencia si `medianTimingSec !== null && |mediana| ≥ 0.08`:
  "De media tocas X ms tarde/pronto. Si seguías el metrónomo, casi seguro es latencia del
  audio, no tú." con botones "Compensar (+X ms)" (`latencySec = clamp(latencySec + mediana,
  −0.1, 0.5)`, guardar, `setFlag('latencyCalibrated')`) y "Calibrar en Ajustes"; si `missed /
  judged ≥ 0.5` mostrar solo "Calibrar en Ajustes" + "El micrófono capta poco: acércalo o baja el
  umbral en Ajustes". Botones Repetir / Biblioteca.
- Unmount: `session.stop()`, unsubscribe de frames, `mic.stop()`, `cancelAnimationFrame`,
  `metronome.clear()`, liberar wake lock, quitar listeners de teclado/visibilidad. El contexto
  compartido no se cierra.
- Bucle rAF (propiedad de la pantalla): `session.update()` → `renderer.render(state,
  performance.now())` → actualizar HUD DOM solo si cambió. `resize()` desde un `ResizeObserver`.

### API de render
```ts
// ui/highway.ts
export class HighwayRenderer {
  constructor(canvas: HTMLCanvasElement, song: Song, shapes: Record<string, ChordShape | null>, settings: Settings);
  setSettings(s: Settings): void;
  resize(): void;   // canvas.width/height = clientWidth/Height * devicePixelRatio; ctx.setTransform(dpr,0,0,dpr,0,0); layout en px CSS
  render(state: SessionState, nowMs: number): void;  // nowMs = performance.now()
}
// ui/chordDiagram.ts
export function drawChordDiagram(ctx: CanvasRenderingContext2D, shape: ChordShape | null,
  box: { x: number; y: number; w: number; h: number }, opts?: { title?: string; showFingers?: boolean; muted?: boolean }): void;
// shape null -> caja con el título y "sin digitación". Diagrama vertical estándar: 6ª a la izquierda,
// cejuela arriba (o "3fr" si baseFret > 1), X/O sobre las cuerdas, cejilla como barra, dedos numerados.
```

### Ajustes (`#/settings`)
Dispositivo de entrada ("Dispositivo por defecto" + botón "Detectar dispositivos" que hace
`start()` → `listDevices()` → `stop()`), latencia (slider −100..500 ms) con botón "Calibrar"
(instrucciones: "Rasguea con cada clic"; progreso i/8; resultado o error; guarda y
`setFlag('latencyCalibrated')`), umbral mínimo de silencio (`gateDb`, −70..−20), sensibilidad
del onset (`onsetThreshold`, 1.0..3.0), afinación A4 (415..466), afinación de la guitarra
(`tuningOffset`: "Estándar" 0, "Medio tono abajo (Eb)" −1, "Un tono abajo (D)" −2), tolerancias
(`earlySec`, `lateSec`), "Invertir cuerdas en la autopista (6ª arriba)", metrónomo por
defecto, escuchar por defecto. Persistido con `saveSettings`. Unmount: `mic.stop()`.

### Estilo
Tema oscuro, fuente del sistema, acento cian/verde; variables CSS en `:root`. Responsive:
vertical/escritorio → autopista ~40 % de la altura; `@media (orientation: landscape) and
(max-height: 500px)` → cabecera y pie en una sola fila compacta, columna izquierda (~30 %) con
los diagramas, autopista con `flex: 1` en el resto. Botones táctiles grandes (≥ 44 px).

## 9. Tests (Vitest, `tests/**/*.test.ts`)
- notes: parseo de símbolos (`Bb`, `F#m7`, `G/B`, `N.C.`, `CM7`, `C-7`, inválidos), `qualityThird`,
  `swapThirdName`.
- chords: biblioteca válida (`frets.length === 6`, dedos coherentes con trastes, barre dentro
  de rango), `shapePitchClasses(G) ⊇ {G,B,D}`, cejilla generada para `F#m`/`Bbm7`/`C#7`/`Ab`.
- parser: todos los ejemplos de la sección 2, reparto equitativo, `*n`, `.` a inicio de compás,
  errores con línea (y severidad), cambio de tempo a mitad (`tempoSegments`), patrón de rasgueo
  con `U`/`x`/longitud 4/8/16, evento extra al cambiar acorde sobre `-`, silencios sin eventos,
  `N.C.`, `x3` de línea, `[Sección] x2`, recuperación de sección (con otro tempo), errores
  `x0`/`x99`/`x2` en compás, `>` sin errores y con `barIndex` correcto, `chordChange`, `capo`.
- tempo: sección 6.
- fft: vs DFT ingenua; seno puro.
- chroma: senos puros a 3 sample rates; acordes sintetizados; invariante de escala;
  `rollChroma`; `mergeExpectedTemplate`; `cosine` sin NaN.
- onset: sección 4.
- detector: gated en silencio; onset refinado ±5 ms; suelo de ruido; `setTranspose`.
- judge: correct/wrong/missed/perfect/late/early; `nc` → skipped; muted → solo timing; chroma
  cero → missed; superset detectado (Am7 con Am esperado) → correct; A vs Am por tercera; C vs
  Am relativo; ventana acotada por `nextOnset`.
- engine (Clock, DetectorSource y ClickScheduler falsos; sin `vi.useFakeTimers`): cuenta atrás
  (`countInBeatsLeft` 4→0, `phase` 'playing'); onset en `expectedSec` exacto → `hit` inmediato y
  `correct` `perfect`; sin frames → `missed`; `listen = false` → `skipped` y `accuracy === 0` sin
  NaN; `tempoScale = 0.5` no ensancha tolerancias; pausa/reanudación con cuenta atrás; bucle de
  2 compases → cuenta atrás y vuelta a `fromBar`, `summary.passes === 3` tras 3 pasadas;
  `latencySec = 0.2`: los frames usados por `chromaAt` están después del onset; clics
  planificados en los beats correctos; `ended` con `perChord`.
- calibrate: con fakes, 8 clics con onsets a +80 ms → `latencySec ≈ 0.08`; 3 onsets → rechazo.
- storage: ida y vuelta, merge de ajustes con defaults y clamps, JSON inválido → vacío.
- examples: todos parsean sin errores ni warnings.

## 10. Criterios de aceptación
1. `npm run build` y `npm test` en verde.
2. `npm run dev`, abrir un ejemplo, "Practicar", pulsar "Empezar": la autopista se anima, la pelota
   aterriza en la línea de golpeo con cada rasgueo, el diagrama cambia con el acorde. Recargar
   la página en `#/play/:id` y pulsar "Empezar" funciona igual.
3. Con micrófono: al tocar el acorde esperado en el momento, anillo inmediato y evento verde;
   acorde distinto, rojo con el nombre detectado; sin tocar, gris. El flash aparece antes de que
   el evento salga de la línea de golpeo.
4. Editor: crear una canción nueva con el formato de la sección 2, errores visibles con línea.
5. Bucle de una progresión de 4 compases con cuenta atrás entre pasadas.
6. Pista de audio (sección 11): cargar un MP3 en el editor, detectar tempo e inicio, ajustarlo en
   la forma de onda, y en Practicar la pista suena sincronizada con la autopista, se para al
   pausar y vuelve a empezar (con cuenta atrás) al reanudar o al repetir el bucle.

## 11. Pista de audio (backing track)

Objetivo: que la canción **suene** mientras se practica. El usuario carga un archivo de audio
por canción (MP3, WAV, OGG, M4A…), lo sincroniza con la rejilla de compases (dónde cae el
compás 1 y a qué tempo) y la app lo reproduce durante la práctica siguiendo la velocidad, las
pausas, los saltos de sección y los bucles. Todo local: el archivo se guarda en IndexedDB del
navegador; no se sube a ningún sitio.

Tipos (ya añadidos a `types.ts`): `AudioTrackInfo`, `StoredSong.audio`, `TempoEstimate`,
`SessionState.countInStartBeat`, `Settings.backingTrack`, `Settings.echoCancellation`.

### song/audioStore.ts
- IndexedDB `guitarzero` (versión 1), object store `tracks` con clave `songId` y valor
  `{ songId, blob: Blob, name, type, size, addedAt }`.
- API (todas async): `putTrack(songId, blob, meta: { name, type, size }): Promise<void>`,
  `getTrack(songId): Promise<Blob | null>`, `deleteTrack(songId): Promise<void>`,
  `copyTrack(fromId, toId): Promise<boolean>`, `hasIndexedDb(): boolean`. Si no hay IndexedDB
  (o falla al abrir), fallback a un `Map` en memoria (no persiste; `hasIndexedDb()` false).
  Errores → `reject(new Error('<mensaje en español>'))`.
- `storage.ts`: `duplicateSong` copia `audio` y llama `void copyTrack(id, newId)`;
  `deleteSong` llama `void deleteTrack(id)`; `saveSong` conserva `audio` tal cual (puede ser
  `null` para quitar la pista). `listSongs`/tarjetas: la Biblioteca muestra una insignia "♪ pista"
  cuando `audio` existe.

### audio/backing.ts
- `class BackingTrack { constructor(ctx: AudioContext); load(blob: Blob): Promise<{ durationSec: number; sampleRate: number; channels: number }>; readonly buffer: AudioBuffer | null; start(whenWall: number, audioOffsetSec: number, rate: number): void; stop(): void; setGain(g: number): void; isPlaying(): boolean; monoSamples(): Float32Array; dispose(): void }`.
- `load`: `blob.arrayBuffer()` → `ctx.decodeAudioData` (funciona con el contexto suspendido).
- `start(whenWall, audioOffsetSec, rate)`: nuevo `AudioBufferSourceNode` → `GainNode` →
  `destination`; `playbackRate.value = rate`. Si `audioOffsetSec >= 0`: `source.start(max(whenWall,
  ctx.currentTime), audioOffsetSec)` (si `whenWall` ya pasó, compensar: `offset += (ctx.currentTime −
  whenWall)·rate`). Si `audioOffsetSec < 0` (la rejilla empieza antes que el audio):
  `source.start(whenWall − audioOffsetSec / rate, 0)`. Si `audioOffsetSec >= duration` → no hace
  nada. `stop()` para y desconecta la fuente actual (idempotente).
- `monoSamples()`: mezcla de canales a mono (para análisis y forma de onda), cacheada.

### dsp/tempoEstimate.ts (puro, testeable)
- `estimateTempo(samples: Float32Array, sampleRate: number, opts?: { minBpm?: 60; maxBpm?: 200; maxSeconds?: 90 }): TempoEstimate`.
- Algoritmo: (1) decimación por promedio de bloques a ≈ 11025 Hz de los primeros
  `maxSeconds`; (2) envolvente de ataques: STFT (RealFFT 1024, hop 256, Hann) → flujo de media
  onda sobre `log(1 + mag)` → `o[n]`; restar media móvil de 0.5 s y rectificar; (3)
  autocorrelación de `o` para lags entre `60/maxBpm` y `60/minBpm` s, ponderada por una
  preferencia log-gaussiana centrada en 120 BPM (σ = 0.8 octavas); (4) pico → `beatPeriodSec`
  (interpolación parabólica); comparar con ×2 y ×½ dentro del rango y elegir el de mayor
  puntuación ponderada; `bpm = 60 / beatPeriodSec` redondeado a 0.1; (5) fase: φ ∈ [0, T)
  que maximiza Σ o[φ + k·T]; `firstBeatSec` = el primer φ + k·T cuyo `o` local supera el 30 %
  del máximo de la envolvente (para no señalar silencio inicial); (6) `confidence` = (pico −
  media) / (máx − media) de la autocorrelación en el rango, acotado a 0..1. Con señal casi
  nula (RMS < 1e-4) → `{ bpm: 120, confidence: 0, firstBeatSec: 0 }`.
- Tests (`tests/dsp/tempoEstimate.test.ts`): clics sintéticos (ruido corto con decaimiento) a
  100 BPM desde 0.37 s durante 30 s + ruido −40 dBFS → `bpm` 100 ± 1, `firstBeatSec ≡ 0.37 (mod
  0.6) ± 0.03`, `confidence ≥ 0.5`; 140 BPM → 140 ± 1.5; silencio → `confidence === 0`;
  rendimiento: 60 s de audio a 44.1 kHz en < 1.5 s en Node.

### ui/waveform.ts
- `class WaveformView { constructor(canvas: HTMLCanvasElement, opts: { onOffsetChange: (sec: number) => void; onSeek?: (sec: number) => void }); setAudio(samples: Float32Array, sampleRate: number): void; setGrid(grid: { bpm: number; beatsPerBar: number; offsetSec: number; totalBeats: number } | null): void; setPlayhead(sec: number | null): void; setViewport(startSec: number, seconds: number): void; zoomBy(factor: number, aroundSec?: number): void; scrollBy(sec: number): void; resize(): void; render(): void; dispose(): void }`.
- Precalcula picos (min/max) por milisegundo en `setAudio`. Dibuja: forma de onda (tema
  oscuro), líneas de beat tenues y de compás marcadas con el número de compás, marcador de
  inicio (offset) como una línea de acento con asa arrastrable (pointer events; `onOffsetChange`
  al soltar y durante el arrastre), playhead. Click simple → `onSeek(sec)`; `Shift+click` → fija
  el inicio ahí (`onOffsetChange`). Rueda → zoom alrededor del cursor; arrastre con botón
  central o `Alt` → scroll. DPR correcto; `resize()` desde `ResizeObserver` del dueño.

### Editor — panel "Pista de audio" (bajo el textarea, ancho completo)
- Sin pista: botón "Cargar audio…" (`<input type=file accept="audio/*">` oculto) + nota
  "MP3, WAV, OGG, M4A. Se guarda en este navegador, no se sube a ningún sitio". Al cargar:
  `putTrack` + `BackingTrack.load` (para duración y muestras) + `saveSong({ ...song, audio })` con
  `offsetSec: 0`, `gain: 0.8`. Mostrar errores (formato no soportado, cuota) en español.
- Con pista: nombre, duración (`fmtSeconds`), tamaño (MB), botón "Quitar" (confirm →
  `deleteTrack` + `audio: null`).
- Forma de onda (`WaveformView`) con la rejilla de `tempo`/`time`/`totalBeats` del texto actual
  (se actualiza al re-parsear el texto, en el mismo debounce del autosave).
- Sincronización: campo numérico "Inicio del compás 1 (s)" (paso 0.01) con botones
  `−0.1 −0.01 +0.01 +0.1` y `−1 pulso`/`+1 pulso` (±60/bpm); "Marcar inicio" (fija el inicio en
  la posición actual del playhead mientras suena; si no suena, en la posición del último
  `onSeek`); "Detectar tempo e inicio" → `estimateTempo(backing.monoSamples(), sampleRate)`
  tras un `setTimeout(0)` con "Analizando…"; resultado "≈ 96 BPM (confianza alta ≥ 0.6 /
  media ≥ 0.3 / baja), inicio 1.32 s" con botones "Aplicar tempo" (reescribe o inserta la
  cabecera `tempo:` en el texto del textarea y dispara el autosave) y "Aplicar inicio".
  Aviso si `tempoSegments.length > 1`: "La pista solo se sincroniza con tempo constante".
- Escucha de prueba: "▶ Escuchar con metrónomo" (reanuda el contexto; reproduce desde
  `offset − 1 compás` si ≥ 0, si no desde 0; clics de `Metronome` en cada beat de la rejilla
  durante 8 compases, acento en el 1; playhead moviéndose en la forma de onda con rAF) y "▶
  Desde aquí" (desde el último `onSeek`, sin clics); "■ Parar". Volumen (0–100 %) → `gain`.
- Todo cambio de `offsetSec`/`gain` se guarda con `saveSong` (debounce 300 ms).

### Practicar
- Al montar, si `stored.audio` y `settings.backingTrack`: `getTrack(id)` → `BackingTrack.load`;
  texto "Cargando pista…" en la cabecera; "Empezar" espera a la carga (o continúa sin pista si
  falla, con aviso). Toggle "Pista" (persiste `settings.backingTrack`) y slider de volumen (solo
  si hay pista). Aviso junto a Escuchar cuando `backingTrack && listen`: "Con la pista por
  altavoces el micrófono la oirá y la evaluación no será fiable: usa auriculares".
- Sincronización con el motor (la pantalla es la dueña de la pista): en cada evento
  `phase === 'countin'` (arranque, reanudación, bucle): `backing.stop()`; `b =
  state.countInStartBeat`; `backing.start(session.wallSec(b), audio.offsetSec +
  beatToSec(song.tempoSegments, b), settings.tempoScale)`. En `paused`/`ended` → `stop()`.
  El cambio de velocidad ya pasa por pausa/reanudación (reinicia con el nuevo `rate`; a menos
  velocidad suena más grave — indicarlo en el título del selector).
- Motor: `playFrom` fija `countInStartBeat` en el estado.
- Mic: `MicInput.start` usa `echoCancellation: settings.echoCancellation` (pasar por
  `detectorOptsFromSettings`/parámetro de `start(deviceId, { echoCancellation })`). Ajustes:
  casilla "Cancelación de eco (si usas altavoces con la pista)" y "Reproducir pista de audio".

### Tests
- `tests/dsp/tempoEstimate.test.ts` (arriba). `tests/song/storage.test.ts`: `duplicateSong`
  copia `audio`; `saveSong` con `audio: null`. `audioStore`/`backing`/`waveform`: solo
  typecheck (navegador). Motor: `countInStartBeat` correcto tras `start()`, `resume()` y
  bucle.

## 12. Transcripción automática de acordes

Objetivo: al subir una canción (audio), la app **propone la tablatura de acordes** completa:
tempo, compás, tonalidad y un acorde por pulso, y genera el texto de la sección 2 listo para
practicar. Es un borrador (con voz y batería mezcladas acierta la mayoría de acordes, no todos):
el usuario lo revisa en el editor. Tipos (ya en `types.ts`): `TranscribedBeat`,
`TranscribedBar`, `ChordTranscription`.

### dsp/chordTranscribe.ts (puro, testeable en Node)
- `transcribeChords(samples: Float32Array, sampleRate: number, opts?: { bpm?: number; firstBeatSec?: number; beatsPerBar?: 4 | 3; vocabulary?: 'basic' | 'extended'; a4?: number; onProgress?: (p: number) => void }): ChordTranscription`.
- Pasos:
  1. Tempo: si `opts.bpm` falta, `estimateTempo` (sección 11); `firstBeatSec` igual. Rejilla de
     pulsos `t_k = firstBeatSec + k·60/bpm` hasta el final del audio (descartar pulsos con
     energía casi nula al principio y al final para no producir compases vacíos de más de 2 al
     inicio; los del final se cortan cuando la energía cae bajo el 5 % del máximo durante > 2
     compases).
  2. Chroma por pulso: decimar a 11025 Hz (reutilizar la decimación de `tempoEstimate.ts` si es
     exportable; si no, una función local equivalente), STFT con `RealFFT(4096)`, hop 1024,
     `computeEnergyChroma(mag, 11025, 4096, { a4 })` por frame; el chroma de un pulso = media
     de `energyChroma` de los frames cuyo centro cae en `[t_k, t_{k+1})`; después
     `compressChroma`. Energía del pulso = media de `Σ energyChroma`.
  3. Tonalidad: chroma global (suma de energías) correlacionado (Pearson) con los perfiles de
     Krumhansl-Kessler mayor `[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]` y
     menor `[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]` en las 12 rotaciones →
     `key`. `name` en español: "Do mayor", "La menor" (`NOTE_NAMES_SHARP` → Do Do# Re Re# Mi Fa
     Fa# Sol Sol# La La# Si).
  4. Vocabulario: `basic` = 12 × {maj, min} (24); `extended` = + {7, m7, maj7} (60). Plantillas
     con `templateForPitchClasses`. Acordes diatónicos de la tonalidad (mayor: I ii iii IV V vi
     + V7; menor natural/armónica: i III iv v/V VI VII + V7): `bonus = +0.06`; el resto `−0.03`.
  5. Emisión por pulso y acorde: `cosine(chromaPulso, plantilla) + bonus`. Estado extra `N`
     (sin acorde): emisión `0.45` si la energía del pulso < 8 % de la mediana de energías, si
     no `0`.
  6. Decodificación Viterbi sobre los pulsos: `score = Σ emisión − Σ penalizaciones`;
     penalización por cambio de acorde `0.28` en pulsos que no son inicio de compás y `0.10` en
     inicios de compás. Como el primer tiempo fuerte no se conoce, se decodifica para cada fase
     `φ ∈ [0, beatsPerBar)` (inicio de compás = `k ≡ φ mod beatsPerBar`) y se elige la fase
     con mayor puntuación total → `firstDownbeatSec = t_φ` (los pulsos anteriores a φ se
     descartan). `confidence` = media de `(mejor − segunda emisión)` por pulso, acotada 0..1.
  7. `bars`: agrupar los pulsos desde `φ` de `beatsPerBar` en `beatsPerBar` fusionando
     consecutivos iguales; el último compás incompleto se rellena con el último acorde.
- Rendimiento: 4 min de audio a 44.1 kHz en < 3 s en Node.
- Tests (`tests/dsp/chordTranscribe.test.ts`): sintetizar con `tests/helpers/synth.ts` la
  progresión C G Am F (voicings de `CHORD_LIBRARY`, 4 pulsos por acorde, rasgueo en cada
  pulso, 100 BPM, 2 vueltas, ruido −40 dBFS, sin silencio inicial) → `bpm` 100 ± 1, `key`
  Do mayor, ≥ 90 % de pulsos con el acorde correcto, `bars` = 8 compases con un acorde cada uno,
  `firstDownbeatSec ≈ 0` (±0.1). Segunda prueba con 1.5 s de silencio inicial y Em C G D →
  `firstDownbeatSec ≈ 1.5` (±0.1), ≥ 85 % de pulsos. Tercera: 3/4 (`beatsPerBar: 3`) con
  Am F C → compases de 3. Caso `extended`: G7 detectado en un G7 sintetizado al menos en la
  mitad de sus pulsos (o `G`: nunca otra raíz).

### song/chartFromTranscription.ts (puro)
- `chartFromTranscription(t: ChordTranscription, opts: { title: string; artist?: string; strum?: string }): string`
  — texto de la sección 2: cabeceras `title`, `artist` (si hay), `tempo: <bpm redondeado>`,
  `time: <beatsPerBar>/4`, `strum:` (una vez por pulso, `D-D-D-D-` en 4/4, salvo `opts.strum`; el editor ofrece presets de rasgueo),
  línea `# Acordes detectados automáticamente: revisa y corrige. Tonalidad: <key.name>`, y los
  compases, 4 por línea: cada acorde `X` seguido de `.` por cada pulso adicional
  (`C . . . | G . Am . |`), `N.C.` para `null`. Nombres con sostenidos tal cual (`F#m`).
- `replaceChart(source: string, chart: string): string` — sustituye en un texto existente todo
  lo que no sea `title:`/`artist:`/`capo:` por el nuevo chart (conserva esas cabeceras del
  original si existen).
- Tests: el texto generado parsea sin errores ni warnings y reproduce `bars`; `replaceChart`
  conserva título y artista.

### UI
- Editor, panel "Pista de audio": botón **"Detectar acordes"** (activo con pista cargada) con
  selector "Compás" (4/4 | 3/4) y casilla "Incluir séptimas". Al pulsar: "Analizando acordes…"
  (progreso %), luego un resumen "Tonalidad Sol mayor · 96 BPM · 48 compases · G D Em C" con
  botones **"Sustituir acordes"** (`replaceChart` sobre el textarea, fija `offsetSec =
  firstDownbeatSec`, autosave) e **"Insertar al final"**. Aviso de confianza baja (< 0.15):
  "Confianza baja: revisa los acordes".
- Biblioteca: botón **"Desde audio…"** junto a "Nueva canción": `<input type=file
  accept="audio/*">`; al elegir: crea la canción (`newSong`, título = nombre del archivo sin
  extensión), `putTrack`, decodifica con `BackingTrack.load` (contexto compartido; no hace
  falta reanudarlo), `estimateTempo` + `transcribeChords` (con progreso en un pequeño diálogo
  "Analizando <archivo>… 40 %"), `chartFromTranscription`, `saveSong` con `audio`
  (`offsetSec = firstDownbeatSec`, `gain 0.8`) y navega a `#/edit/<id>`. Errores en español.
- Prueba en navegador: el archivo se genera por JavaScript en el sandbox (no hay diálogo de
  archivos), como en la sección 11.

## 13. Simplificar acordes

Objetivo: convertir cualquier canción (detectada automáticamente o escrita) en una versión
**fácil de tocar**: sin séptimas ni extensiones, con cejilla si eso convierte los acordes en
formas abiertas, sustituyendo los acordes difíciles por el acorde fácil más cercano, y con la
opción de limitarse a N acordes (p. ej. 4) para tocar la canción entera con ellos.

### music/simplify.ts (puro)
- `EASY_CHORDS: string[]` = `C D E G A Am Em Dm` (nivel 1) y `A7 D7 E7 G7 C7 B7 Am7 Em7 Dm7 Cmaj7 Fmaj7 Asus2 Asus4 Dsus2 Dsus4 Esus4 Cadd9` (nivel 2, "abiertos con extensión").
- `chordDifficulty(sym: string | ChordSymbol): { level: 1 | 2 | 3; label: 'fácil' | 'medio' | 'difícil'; reason: string }`:
  nivel 1 si su nombre normalizado (raíz + cualidad, sin bajo) está en el conjunto de nivel 1;
  nivel 2 si está en el de nivel 2 o si `getChordShape` devuelve una forma de biblioteca sin
  cejilla con ≤ 4 dedos; nivel 3 si la forma tiene `barre`, es `generated`, o no existe.
  `reason` en español ("cejilla", "acorde de séptima", "sin digitación", …).
- `transposeName(name: string, semitones: number): string` — transpone la raíz (y el bajo) con
  sostenidos salvo para las raíces que suelen escribirse con bemol (`Bb`, `Eb`, `Ab`) cuando no
  existe forma con sostenido en la biblioteca; conserva la cualidad textual.
- `reduceQuality(sym: ChordSymbol): ChordSymbol` — `maj7/7/add9/6/9/sus2/sus4/7sus4/aug/5` → `maj`;
  `m7/m6/dim/dim7/m7b5` → `min`; elimina el bajo alternativo. `name` regenerado.
- `nearestEasyChord(sym, opts: { key: { root, mode } | null; allowSevenths: boolean; candidates?: string[] }): { name: string; shared: number; score: number } | null`
  — candidatos = `EASY_CHORDS` (nivel 1, más nivel 2 si `allowSevenths`) o `opts.candidates`;
  puntuación = notas compartidas ponderadas (raíz 1.5, tercera 1.0, quinta 0.5, otras 0.5)
  + 0.5 si es diatónico en `key` − 0.3 si la cualidad (mayor/menor) cambia; se exige ≥ 2 notas
  compartidas; empates → el candidato con menor nivel, luego orden en `EASY_CHORDS`.
  Ejemplos que deben cumplirse: `F` → `Fmaj7` (allowSevenths) o `Dm`/`Am` (sin séptimas, con
  tonalidad Do mayor → `Dm` o `Am`, nunca `C`); `Bm` (Sol mayor) → `D` o `G`; `B7` → `B7` si
  allowSevenths (nivel 2 no se sustituye).
- `bestCapo(chords: Array<{ name: string; beats: number }>, maxCapo = 7): { capo: number; difficulty: number; names: string[] }`
  — para `capo` 0..maxCapo, transpone cada acorde `−capo` semitonos y suma `beats × level`;
  devuelve el mínimo (empate → menor capo). Solo se propone si reduce la suma en ≥ 15 %.
- `keepTopChords(chords: Array<{ name: string; beats: number }>, n: number, key): Map<string, string>`
  — conserva los `n` acordes con más beats (empate → primero en aparecer) y mapea cada uno de
  los demás al más cercano del conjunto conservado (`nearestEasyChord` con `candidates` = los
  conservados, sin exigir ≥ 2 notas: si ninguno comparte notas, el conservado más frecuente).
- `simplifyChart(source: string, opts: { removeExtensions: boolean; substituteHard: boolean; maxChords: number | null; suggestCapo: boolean; allowSevenths: boolean }): SimplifyResult`
  con `SimplifyResult = { source: string; capo: number; substitutions: Array<{ from: string; to: string; beats: number; reason: string }>; chordsBefore: string[]; chordsAfter: string[]; unchangedBeatsRatio: number /* beats cuyo acorde no cambió / beats con acorde */ }`.
  Pipeline: parsear con `parseSong` (beats por acorde de `song.bars`); (1) `reduceQuality` si
  `removeExtensions`; (2) `bestCapo` si `suggestCapo` (cabecera `capo:` añadida/actualizada y
  todos los nombres transpuestos; si la canción ya tenía `capo: n`, se parte de los acordes
  escritos y el nuevo capo es total); (3) `substituteHard` → cada acorde de nivel 3 →
  `nearestEasyChord` (tonalidad estimada del texto: `estimateKeyFromChords(chords)` = raíz/modo
  que maximiza el nº de beats diatónicos); (4) `maxChords` → `keepTopChords`. Reescritura del
  texto: solo los **tokens de acorde** de las líneas de compases (regex sobre tokens separados
  por espacios y `|`: `^([A-G][#b]?[^\s|*\/]*)(\/[A-G][#b]?)?(\*\d+)?$`), conservando `.`, `-`,
  `N.C.`, `*n`, comentarios, cabeceras, secciones, `x2` y letras; el bajo alternativo se elimina
  cuando el acorde cambia. `estimateKeyFromChords` exportada.
- Tests (`tests/music/simplify.test.ts`): dificultad de `C`/`F`/`Bm`/`G7`/`F#m`/`Bbm7`;
  `transposeName('Bb', -1) === 'A'`, `('F#m', 2) === 'G#m'`; `reduceQuality` de `Cmaj7`, `Am7`,
  `G/B`; `nearestEasyChord` con los ejemplos anteriores; `bestCapo` de `Eb Ab Bb Cm` → capo 3
  (`C F G Am`) o 1 (`D G A Bm`) según niveles: el resultado debe minimizar la suma; `keepTopChords`
  con 5 acordes y n = 4; `simplifyChart` sobre un texto con secciones, `x2`, comentarios `#`,
  letras `>`, `Am7*2`, `G/B`: el resultado parsea sin errores, conserva la estructura
  (mismo nº de compases y eventos) y cumple `chordsAfter.length ≤ maxChords`.

### UI (editor)
- Nueva tarjeta **"Simplificar"** en el panel lateral, debajo de la lista de acordes: casillas
  "Quitar séptimas y extensiones" (on), "Sustituir acordes difíciles" (on), "Proponer cejilla"
  (on), "Permitir séptimas abiertas (A7, E7…)" (off), selector "Máximo de acordes" (Sin límite,
  3, 4, 5, 6; por defecto 4), botón **"Simplificar"** → previsualización: capo propuesto, tabla
  `antes → después` (con nivel y beats afectados), "Tocas el N % de la canción sin cambios", y
  botones **"Aplicar"** (sustituye el texto del textarea; guarda el texto anterior para
  **"Deshacer"**, visible hasta el siguiente cambio manual) y "Cancelar".
- Lista de acordes (chips): insignia de nivel (verde fácil / ámbar medio / rojo difícil) y, en
  los difíciles, "→ X" con `title` "Acorde fácil más cercano: X (comparte n notas)"; click en la
  flecha sustituye ese acorde en todo el texto (mismo mecanismo de reescritura por tokens).
- Tras "Detectar acordes" (sección 12) o "Desde audio…", el resumen incluye el enlace "Simplificar
  para principiantes" que abre la tarjeta con los valores por defecto.

## 14. Detección del rasgueo desde el audio

Objetivo: que las flechas ↓/↑ de la autopista **coincidan con la grabación**. A partir de la
rejilla de pulsos (tempo, inicio del compás 1 y compás) se mide qué subdivisiones de cada
compás llevan un ataque en el audio y se deduce el patrón `strum:` real de la canción. Tipo
(ya en `types.ts`): `StrumDetection`.

### dsp/strumDetect.ts (puro, testeable)
- `detectStrumPattern(samples: Float32Array, sampleRate: number, opts: { bpm: number; firstDownbeatSec: number; beatsPerBar: number; maxSeconds?: 120; a4?: number }): StrumDetection`.
- Algoritmo:
  1. Envolvente de ataques como en `tempoEstimate.ts` (decimación a ≈ 11025 Hz, STFT 1024/256,
     flujo de media onda sobre `log(1+mag)`, resta de media móvil 0.5 s, rectificado). Reutilizar
     la función existente si está exportada; si no, exportarla desde `tempoEstimate.ts`
     (cambio aditivo) en vez de duplicarla.
  2. Rejilla: pulso `T = 60/bpm`; compases desde `firstDownbeatSec` hasta el final del audio
     (o `maxSeconds`); descartar compases con energía total < 10 % de la mediana (silencios).
  3. Fuerza por slot: para semicorcheas (4 slots por pulso) `s[k]` = máximo de la envolvente en
     `[t_k − 0.12·T/4, t_k + 0.12·T/4 + 0.03 s]` (el ataque puede llegar unos ms tarde);
     acumular la media por slot del compás sobre todos los compases; normalizar al máximo →
     `slot16[]` (`4·beatsPerBar` valores).
  4. Subdivisión: si la suma de los slots impares de semicorchea (posiciones 1 y 3 de cada
     pulso) supera el 35 % de la suma de los slots de corchea → `charsPerBeat = 4`; si no, 2;
     si además los contratiempos de corchea no superan el 25 % de los tiempos → 1.
     `slotStrength` es el vector reducido a esa resolución (media de los slots agrupados).
  5. Umbral: un slot es rasgueo si `slotStrength ≥ 0.4` (el primer slot del compás siempre lo
     es). Dirección: slots que caen en tiempo (o en la primera mitad del pulso a resolución 4:
     posiciones 0 y 1) → `D`; contratiempos (posición 1 a resolución 2; posiciones 2 y 3 a
     resolución 4) → `U`; resto `-`. Si todos los slots activos fueran tiempos → todo `D`.
  6. `confidence`: fracción de compases en los que el conjunto de slots activos (con el mismo
     umbral aplicado al compás individual) coincide con el patrón en ≥ 75 % de las posiciones.
- Tests (`tests/dsp/strumDetect.test.ts`) con un helper nuevo en `tests/helpers/synth.ts`:
  `synthStrummedProgression(chords, sampleRate, { bpm, pattern, rounds, noiseDb })` que toca la
  progresión rasgueando solo en los slots del patrón (cada rasgueo = ataque de 10 ms con las
  cuerdas escalonadas 8 ms, acentuado en `D`). Casos: `D-DU-UDU` a 100 BPM → mismo patrón,
  `charsPerBeat 2`, `confidence ≥ 0.8`; `D-D-D-D-` → `D-D-D-D-`; `DUDUDUDU` → mismo; `D---D---`
  → mismo; 3/4 `D-DUDU` → mismo; semicorcheas `D-DUD-DUD-DUD-DU` (16 chars) → `charsPerBeat 4`
  y patrón igual en ≥ 14 de 16 posiciones; silencio → `pattern` = `'D-'.repeat(beatsPerBar)`,
  `confidence 0`. Rendimiento: 3 min en < 1.5 s.

### UI
- Editor, tarjeta **Rasgueo**: botón **"Detectar rasgueo del audio"** (activo con pista cargada;
  usa `bpm` y `beatsPerBar` del texto y `offsetSec` de la pista) → escribe el patrón detectado
  en el campo de letras, selecciona el preset correspondiente o "Personalizado", y muestra
  "Detectado en N compases (confianza alta/media/baja)"; "Aplicar" lo escribe en `strum:`.
  Junto al botón, la nota: "Las flechas se calculan con los golpes del audio: ↓ en los tiempos,
  ↑ en los contratiempos".
- Forma de onda: `WaveformView.setStrum(pattern: string | null, charsPerBeat)` dibuja bajo cada
  compás visible pequeñas marcas ↓/↑ en los slots del patrón (mismos colores que la
  autopista: ↓ azul, ↑ rosa) para comprobar a simple vista que caen sobre los golpes. El
  editor la llama con el patrón vigente del texto en cada `syncGrid()`.
- Importación **"Desde audio…"** y **"Detectar acordes"** → tras transcribir, `detectStrumPattern`
  con la rejilla de la transcripción y el patrón se pasa a `chartFromTranscription` como
  `opts.strum` (si `confidence ≥ 0.3`; si no, una por pulso).

## 15. Seguimiento de pulsos, mapa de tempo y estructura (secciones)

Objetivo: que la autopista y la pista sigan **pegadas a la grabación de principio a fin**
aunque el tempo no sea perfectamente constante, y que la tablatura generada venga separada en
partes (`[Intro]`, `[Estrofa]`, `[Estribillo]`, `[Puente]`, `[Final]`) para poder practicar
cada una en bucle. Tipos (ya en `types.ts`): `TranscribedSection`,
`ChordTranscription.barTempos?`, `ChordTranscription.sections?`.

### dsp/beatTrack.ts (puro)
- `trackBeats(samples: Float32Array, sampleRate: number, opts: { bpm: number; firstBeatSec?: number; maxSeconds?: number; tightness?: number /* 100 */ }): { beatTimes: number[]; bpm: number }`.
- Seguidor de pulsos por programación dinámica (Ellis 2007) sobre la envolvente de ataques de
  `tempoEstimate.ts` (`onsetEnvelope` + `decimateForTempo`, hop 256 @ ≈ 11025 Hz ≈ 23 ms):
  `τ = 60/bpm` en frames; para cada frame `t`: `score[t] = env[t] + max_{p ∈ [t − 2τ, t − τ/2]}
  (score[p] − tightness · (log(( t − p)/τ))²)`; `backlink[t] = argmax`. Se parte del último
  máximo local de `score` y se retrocede por `backlink` → tiempos de pulso; se descartan los
  pulsos anteriores al primer ataque significativo. Si se da `firstBeatSec`, el pulso más
  cercano se usa como referencia y se ajusta la fase (los pulsos no cambian, solo la
  numeración). `bpm` devuelto = 60 / mediana de los intervalos. Interpolación parabólica del
  instante en la envolvente para precisión sub-frame.
- Tests (`tests/dsp/beatTrack.test.ts`): clics a 100 BPM constantes → intervalos 0.6 ± 0.02 s;
  **rampa** de 96 → 104 BPM a lo largo de 40 s → cada pulso detectado a ±35 ms del sintetizado
  (≥ 95 % de los pulsos) y `bpm` ≈ 100 ± 2; **salto** 100 → 110 BPM en el segundo 20 → tras 2
  s del salto los intervalos son 0.545 ± 0.02; progresión rasgueada `D-DU-UDU` (helper
  existente) → pulsos en los tiempos, no en los contratiempos (≥ 90 %); rendimiento: 4 min
  en < 1.5 s.

### Integración en `dsp/chordTranscribe.ts`
- Nueva opción `opts.trackBeats?: boolean` (por defecto `true`). Con ella, la rejilla de pulsos
  es `trackBeats(...)` (con `bpm`/`firstBeatSec` de `estimateTempo` o de `opts`) en lugar de
  la rejilla constante; el resto (chroma por pulso, tonalidad, Viterbi por fases, compases) no
  cambia. `beats[k].timeSec` = tiempo real del pulso. `barTempos[i]` = `60 · beatsPerBar /
  (t_{inicio del compás i+1} − t_{inicio del compás i})` (último compás: el anterior),
  redondeado a 0.1. `bpm` = mediana de `barTempos`. Con `trackBeats: false` se mantiene el
  comportamiento actual (sin `barTempos`).
- **Estructura** (`opts.detectSections?: boolean`, por defecto `true`; función pura exportada
  `segmentStructure(barChroma: Float32Array[], barEnergy: number[], barChords: (string|null)[][], beatsPerBar: number): TranscribedSection[]`):
  1. Características por compás: chroma medio (L2) y energía media (dB relativo al máximo).
  2. Matriz de autosimilitud `S[i][j]` = coseno de chroma × (1 si las secuencias de acordes de
     los compases coinciden, 0.7 si no).
  3. Novedad: kernel de tablero de ajedrez de tamaño 4 compases sobre la diagonal; picos por
     encima de `media + 0.5·σ` y separados ≥ 4 compases → límites; cada límite se ajusta al
     múltiplo de 4 compases más cercano si está a ≤ 1 compás (los primeros compases pueden
     formar una sección corta de 1–3 compases: intro/anacrusa).
  4. Etiquetado por repetición: dos segmentos comparten letra si la correlación media de
     `S` entre sus compases alineados (misma longitud, o el más corto contra el prefijo del más
     largo) ≥ 0.75; letras A, B, C… por orden de aparición.
  5. Nombres: la letra que más veces aparece con mayor energía media → `Estribillo`; la otra
     letra más repetida → `Estrofa`; un segmento único al principio (antes del primer
     repetido) → `Intro`; único en el medio → `Puente`; único al final → `Final`; el resto →
     `Parte <letra>`. Si solo hay una sección → `sections` ausente.
  6. Tests (`tests/dsp/structure.test.ts`): sintético con estructura Intro(4) A(8) B(8) A(8) B(8)
     Final(4) con progresiones distintas (A: C G Am F; B: F G C C con más energía) →
     6 secciones con límites en 4, 12, 20, 28, 36 (±1 compás), etiquetas Intro, Estrofa,
     Estribillo, Estrofa, Estribillo, Final; con una sola progresión constante → `undefined`.

### `song/chartFromTranscription.ts`
- Cabeceras y compases como hasta ahora, más: (a) `tempo:` inicial = `t.bpm`; entre compases,
  cuando `barTempos[i]` difiere del tempo vigente en ≥ 1.5 % **de forma sostenida** (mediana
  de los 2 compases siguientes también difiere), se emite una línea `tempo: <bpm>` antes de
  ese compás (nunca más de una por 2 compases; sin cambios en el último compás); (b) si
  `sections` existe, cada sección empieza con `[Etiqueta]` en su propia línea y sus compases
  van en líneas de 4 (una sección repetida se escribe entera cada vez: el parser la
  redefine); (c) el patrón `strum:` sigue siendo global.
- Tests: chart con `barTempos` [100×8, 104×8] → una línea `tempo: 104` antes del compás 9 y
  `parseSong` da `tempoSegments` de 2 tramos; con secciones → etiquetas en el texto y
  `song.bars[i].section` correcto; sin cambios de tempo → ninguna línea `tempo:` extra.

### UI
- `WaveformView.setGrid` acepta `segments?: TempoSegment[]` (de `song.tempoSegments`) y
  dibuja los pulsos con `beatToSec(segments, beat)`; el editor los pasa en `syncGrid()`. El
  aviso "La pista solo se sincroniza con tempo constante" se elimina (el motor y la pista ya
  siguen el mapa de tempo).
- Editor, tras "Detectar acordes": el resumen añade "N secciones: Intro · Estrofa · Estribillo…"
  y "tempo variable (96–104 BPM)" cuando `barTempos` varía.
- "Desde audio…" usa `trackBeats` y `detectSections` por defecto.
- Practicar: sin cambios (el desplegable "Sección" ya muestra los tramos y el bucle por
  sección ya existe).

## 16. Rasgueo grabado a mano y rasgueo por sección

Objetivo: que el patrón `strum:` coincida con lo que el usuario oye y quiere tocar, aunque el
análisis automático falle (batería, mezclas densas): el usuario **marca el rasgueo tocando**
mientras suena la canción, y el patrón puede ser **distinto por sección**.

### dsp/strumFromTaps.ts (puro)
- `patternFromTaps(tapsSec: number[], beatTimes: number[], beatsPerBar: number, opts?: { minBarFraction?: 0.5; latencySec?: number | 'auto' }): StrumDetection`.
  1. Rejilla: pulsos `beatTimes` (beat 0 = primer tiempo del compás 1; se extrapolan con el
     último intervalo si faltan); slots de semicorchea interpolados entre pulsos.
  2. Latencia del toque: si `latencySec === 'auto'` (defecto), `δ = mediana(tap − slot de
     corchea más cercano)` acotada a [−0.05, 0.2] s; se resta a todos los toques.
  3. Cada toque se asigna al slot de semicorchea más cercano del compás en que cae; se cuentan
     toques por slot (máximo uno por toque) y compases con al menos un toque (`bars`).
  4. Subdivisión: si los slots impares de semicorchea reúnen ≥ 20 % de los toques →
     `charsPerBeat = 4`; si no, 2. `slotStrength[k]` = toques del slot / `bars` (0..1) a esa
     resolución.
  5. Slot activo si `slotStrength ≥ minBarFraction` (0.5: en al menos la mitad de los compases);
     el primer slot del compás es activo si hay algún toque en ≥ 25 % de los compases.
     Dirección: tiempo → `D`, contratiempo → `U` (a resolución 4: slots pares `D`, impares `U`).
     Si ningún slot resulta activo → `'D-'.repeat(beatsPerBar)` con `confidence 0`.
  6. `confidence` = fracción de compases cuyo conjunto de slots con toque coincide con el patrón
     en ≥ 75 % de las posiciones.
- Tests (`tests/dsp/strumFromTaps.test.ts`): toques exactos en `D-DU-UDU` durante 8 compases a
  100 BPM → mismo patrón, `charsPerBeat 2`, `confidence 1`; los mismos toques con +90 ms de
  latencia constante → mismo patrón (auto-latencia); toques con jitter ±40 ms → mismo patrón,
  `confidence ≥ 0.75`; un compás con un toque de más no cambia el patrón; semicorcheas
  `D-DUD-DUD-DUD-DU` → `charsPerBeat 4` y ≥ 14/16; rejilla con rampa de tempo (pulsos de
  `rampBeatTimes`) → patrón correcto; sin toques → una por pulso y `confidence 0`.

### Rasgueo por sección
- `chartFromTranscription(t, { …, sectionStrums?: (string | undefined)[] })`: con `sections` y
  `sectionStrums[i]` definido, tras la línea `[Etiqueta]` de la sección i se escribe
  `strum: <patrón>` si difiere del patrón vigente (la cabecera global sigue siendo el de la
  primera sección con patrón, o `opts.strum`). Test: dos secciones con patrones distintos →
  una línea `strum:` extra y `parseSong` sin errores con eventos distintos por sección.
- Importación "Desde audio…" y "Detectar acordes": si hay secciones, `detectStrumPattern` se
  ejecuta por sección (con los `beatTimes` de sus pulsos y `firstDownbeatSec` = su primer
  pulso); se usa el patrón de la sección si `confidence ≥ 0.3` y `bars ≥ 2`; si no, el global.

### UI (editor, tarjeta Rasgueo)
- Botón **"Grabar rasgueo tocando"**: reanuda el contexto, reproduce la pista desde un compás
  antes del compás 1 con el metrónomo (como "Escuchar con metrónomo", pero hasta 16 compases
  o hasta "Parar") y entra en modo grabación: un botón grande **"¡Rasgueo!"** (y la barra
  espaciadora, salvo cuando el foco está en un campo de texto) registra cada toque con la
  posición de audio del playhead. Indicador "Grabando… N toques · compás M". Al pulsar
  "Parar" o al terminar: `patternFromTaps` con los `beatTimes` del mapa de tempo del texto
  (`offsetSec + beatToSec(segments, k)`) → rellena el campo de letras, selecciona preset o
  "Personalizado", muestra "Grabado en N compases (confianza …)" y activa "Aplicar". Si no hubo
  toques: "No se registró ningún rasgueo". Salir de la pantalla cancela la grabación.
- Nota bajo el botón: "Toca la barra espaciadora (o el botón) en cada rasgueo mientras suena.
  Abajo en los tiempos, arriba en los contratiempos."

## 17. Análisis del micrófono en un hilo aparte (Worker)

Motivo: en algunos ordenadores, con "Escuchar" activado y la pista de acompañamiento sonando a
la vez, la reproducción se cortaba. La causa más probable es que el análisis del micrófono
(FFT, chroma, detección de ataques) se ejecutaba en el hilo principal del navegador, compitiendo
por CPU con el resto de la página justo en el momento en que el sistema también tiene que grabar
y reproducir audio a la vez. Se ha movido ese análisis a un **Web Worker** dedicado, para que
nunca pueda competir con la reproducción ni con el resto de la interfaz, sin cambiar el
comportamiento observable de la detección.

### audio/detectorWorker.ts (nuevo)
- Script de worker: solo cálculo puro (`ChordDetector` de `dsp/detector.ts`), sin DOM ni Web
  Audio. `self` se tipa como `Worker` (no `DedicatedWorkerGlobalScope`) para no mezclar las
  librerías TS `dom` y `webworker` en el mismo `tsconfig`.
- Mensajes de entrada: `{ type: 'init', sampleRate, opts }`, `{ type: 'frame', frame, timeSec }`
  (el `frame` se transfiere, no se copia), `{ type: 'setOptions', patch }`,
  `{ type: 'setTranspose', semitones }`.
- Mensajes de salida: `{ type: 'result', frame: DetectorFrame, gateDb, noiseFloorDb }` (los dos
  últimos campos van fuera de `DetectorFrame`, que no cambia) o `{ type: 'error', message }`. Los
  `Float32Array` de `energyChroma`/`chroma` se transfieren de vuelta (se asignan nuevos en cada
  `process()`, así que transferirlos es seguro).
- Sin test propio: es solo el cableado de mensajes alrededor de `ChordDetector`, ya probado a
  fondo; no se puede instanciar un `Worker` real en Vitest (entorno Node).

### audio/micDetector.ts (reescrito, mismo contrato público)
- `MicDetectorSource` intenta crear el worker en el constructor
  (`new Worker(new URL('./detectorWorker.ts', import.meta.url), { type: 'module' })`); si
  `Worker` no existe (tests en Node, navegador antiguo) o la creación lanza, usa **el mismo
  `ChordDetector` de siempre en el hilo principal**, exactamente como antes. Ningún otro módulo
  necesita saber cuál de los dos casos está activo.
- `getGateDb()`/`getNoiseFloorDb()` devuelven el último valor recibido del worker (llegan en
  cada mensaje `result`) cuando hay worker, o se leen directamente del detector en modo
  respaldo. `setOptions`/`setTranspose` se reenvían al worker con `postMessage` (sin esperar
  respuesta) o se aplican directamente en modo respaldo.
- Nuevo método `usingWorker(): boolean` (diagnóstico).
- `dispose()` también termina el worker (`worker.terminate()`).
- Test (`tests/audio/micDetector.test.ts`): cubre la ruta de respaldo (la única que corre en
  Node) con un `MicInput` falso: entrega síncrona de `DetectorFrame`, detección real de un
  acorde sintetizado, `setOptions`/`setTranspose`, valores por defecto antes del primer
  fotograma, `dispose()`, y que un suscriptor que lanza no rompe a los demás.
- Verificado a mano en el navegador real (Vite dev, sin usar el micrófono): construir
  `MicDetectorSource` con un `MicInput` falso, comprobar `usingWorker() === true`, empujar un
  fotograma sintetizado y comprobar que el resultado (acorde, chroma, rms) llega igual que en
  modo respaldo.

## 18. AudioContext: sin forzar frecuencia ni la menor latencia posible

`audio/context.ts` fijaba `sampleRate: 48000` y `latencyHint: 'interactive'` (el búfer de
hardware más pequeño posible). Todo el DSP recibe `sampleRate` como parámetro y está probado a
44100/48000/96000, así que no depende de un valor fijo; forzarlo obliga al navegador a
remuestrear en tiempo real cuando no coincide con el formato nativo del dispositivo. Un búfer
mínimo dificulta más aún mantener el ritmo cuando el sistema graba y reproduce a la vez. Ahora
`getAudioContext()` no fija `sampleRate` (usa el nativo del dispositivo) y pide
`latencyHint: 'playback'` (búfer más grande y estable); el retraso fijo adicional que esto
añade ya lo absorbe la calibración de latencia existente (`Settings.latencySec`, "Calibrar" en
Ajustes).

## 19. Afinador (`#/tuner`)

Afinador cromático guiado, independiente de cualquier canción: responde a una pregunta que el
detector de acordes/rasgueo no puede responder por sí solo — ¿está afinada la guitarra? Guiado
(no por auto-detección): la pantalla siempre nombra UNA cuerda objetivo ("6ª · Mi (E2)") y
compara lo que suena contra ESA nota, nunca contra "la nota de referencia numéricamente más
cercana" (eso falla justo cuando más importa: una cuerda a más de medio semitono de su objetivo
se compararía silenciosamente con la cuerda vecina equivocada). El jugador elige la cuerda (los
6 chips, Anterior/Siguiente, o las flechas ← → / ↑ ↓ del teclado) o sigue el orden por defecto
(6ª a 1ª); mantenerla afinada ~1 s pasa sola a la siguiente.

- `dsp/tuner.ts` (puro, testeable): `detectPitch(mag, sampleRate, fftSize, opts)` — pico más
  fuerte en [70, 400] Hz (cubre las 6 cuerdas al aire con margen), refinado por interpolación
  parabólica (igual que `chroma.ts`), convertido a MIDI/cents. Monofónico a propósito (una
  cuerda a la vez, como cualquier afinador).
- `ui/screens/tuner.ts`: reutiliza `MicInput` directamente (no el Worker de
  `micDetector.ts` — una sola nota es mucho más simple que reconocer acordes) con su propio
  `AudioContext` de captura. Filtro de silencio: `rmsDbOf(samples) < settings.gateDb` descarta
  el fotograma entero (sin esto, "el pico más fuerte del fotograma" sigue siendo un pico aunque
  sea silencio, y el afinador "oía" una nota fantasma nada más empezar a escuchar).
- La última lectura se queda fija en pantalla (no se borra a los 400 ms) para dar tiempo a leer
  el consejo; un piloto (punto de color junto al estado: gris parado, pulsando mientras escucha,
  verde en cuanto hay señal real) y un aviso "sin sonido ahora" cuando la lectura lleva más de
  `TUNER_STALE_MS` (2.5 s) sin refrescarse dejan claro cuándo el número ya NO refleja lo que
  suena en ese instante (p. ej. mientras se gira la clavija sin volver a tocar la cuerda).
- `tunerAdvice(cents)`: en vez de un número abstracto, "más tensa: afloja" / "más floja:
  aprieta" (más allá de `TUNER_FAR_CENTS` = 150, sugiere comprobar si es la cuerda correcta).
- Diagrama SVG de las 6 cuerdas (gruesa arriba = 6ª, fina abajo = 1ª) orientado como el jugador
  ve su propia guitarra al tocar, no como se ve en una foto de frente.

## 20. Pista de acordes simplificada (sintetizada)

Alternativa a la grabación real subida: en vez de la mezcla completa (batería, bajo, voz…),
sintetiza SOLO los acordes en el ritmo exacto de `song.events` (los mismos datos que dibujan la
autopista), para practicar controlando el ritmo y los acordes sin el ruido de las demás pistas.

- `audio/chordSynth.ts`, separado en dos capas (como el resto de `audio/`: envoltorio de Web
  Audio fino y sin tests, lógica pura y sí testeada):
  - `planChordTrack(song, a4 = 440): PlannedVoice[]` — puro, sin Web Audio, testeable en Node.
    Por cada evento no silencioso (`chord.quality !== 'nc'`): un rasgueo mudo (`muted`) se
    convierte en un golpe percusivo (`{kind:'mute'}`); un rasgueo real usa
    `getChordShape`/`shapeMidiNotes` (music/chords.ts) para obtener las notas MIDI que suenan
    en esa digitación y genera una nota por cuerda, de grave a aguda para un rasgueo hacia abajo
    y de aguda a grave para uno hacia arriba, cada una desplazada `CHORD_SYNTH_STRING_STAGGER_SEC`
    (10 ms) respecto a la anterior (el "barrido" de un rasgueo real, no todas las cuerdas a la vez).
  - `renderChordTrack(song, sampleRate, a4): Promise<AudioBuffer>` — `OfflineAudioContext`;
    cada nota es un oscilador `triangle` con envolvente rápida (4 ms de ataque, decaimiento
    exponencial τ = 0.35 s); cada golpe mudo es una ráfaga corta de ruido blanco filtrada en
    banda (~2200 Hz); todo pasa por un único filtro paso-bajo maestro (3500 Hz) para un timbre
    cálido con muy pocos nodos. Requiere navegador real (`OfflineAudioContext` no existe en
    Node/Vitest); verificado a mano — sin errores, pico y RMS dentro de rango, sin saturar.
- `audio/backing.ts`: `BackingTrack.loadBuffer(buffer: AudioBuffer)` — como `load(blob)` pero
  para un `AudioBuffer` ya decodificado, reutilizando toda la lógica de sincronización/ganancia
  existente.
- `Settings.backingSource: 'audio' | 'chords'` (por defecto `'audio'`), selector "Grabación
  original" / "Solo acordes (simplificado)" en Practicar, solo visible cuando la canción tiene
  audio subido. La pista sintetizada se renderiza una vez por canción y se cachea; a diferencia
  del audio subido, su muestra 0 ES el beat 0 exacto (sin `audio.offsetSec` propio).
