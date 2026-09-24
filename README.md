# GuitarZero

Practica acordes de guitarra al estilo Yousician, con tus propias canciones:

- Escribes la canción como texto (acordes, compases, patrón de rasgueo, letra).
- La app muestra una **autopista** con las 6 cuerdas: los acordes se acercan a la línea de
  golpeo y una **pelota** bota marcando cada rasgueo. Arriba ves el diagrama con los dedos del
  acorde actual y del siguiente.
- El **micrófono** escucha lo que tocas y marca cada rasgueo en verde (bien), rojo (acorde
  incorrecto, con el acorde que ha oído) o gris (no sonó nada).
- Metrónomo, cuenta atrás, velocidad reducida (50 %–120 %), bucle por sección, resumen con
  precisión por acorde y calibración de latencia.

Todo corre en el navegador (Vite + TypeScript, Web Audio, Canvas). No envía audio a ningún
servidor.

## Arrancar

```bash
npm install
npm run dev
```

Abre la URL que imprime Vite (normalmente `http://localhost:5173`). El micrófono solo
funciona en `localhost` o en `https`.

Otros comandos:

```bash
npm test        # tests unitarios (vitest)
npm run build   # comprobación de tipos + build de producción en dist/
npm run preview # servir dist/
```

## Cómo se usa

1. **Biblioteca**: elige un ejemplo o crea una canción nueva ("Nueva canción" o "Progresión
   rápida" para meter cuatro acordes y repetirlos en bucle).
2. **Editor**: escribe la canción en el formato de abajo. A la derecha ves errores (con línea),
   los acordes usados con su diagrama y la duración. "Probar" te lleva a practicar.
3. **Practicar**: pulsa "Empezar" (el navegador pedirá permiso de micrófono). Hay una cuenta
   atrás de un compás y luego la autopista empieza a moverse. Rasguea cuando la pelota aterrice
   en la línea. Usa auriculares para que el micrófono no capte el metrónomo.
4. **Ajustes**: la primera vez, pulsa **Calibrar** y rasguea con cada clic; así "a tiempo"
   será a tiempo con tu micrófono y tu equipo.

## Formato de canción

```
title: Cielito Lindo
artist: Tradicional
tempo: 120          # pulsos por minuto
time: 4/4           # 4/4 (por defecto), 3/4, 2/4, 6/8
strum: D-DU-UDU     # patrón por compás: D abajo, U arriba, x apagado, - nada
capo: 2             # opcional: la detección se ajusta sola

[Intro]
C . . . | G . . . | C . G . |      # un token por beat; "." continúa el acorde
[Estrofa]
C G | Am F |                       # sin puntos: el compás se reparte a partes iguales
Am*3 F |                           # Am durante 3 beats, F el resto
N.C. | G . . . |                   # N.C. = sin acorde (no se juzga)
- - G . |                          # - = silencio de un beat
> Ay, ay, ay, ay, canta y no llores  # letra (se muestra bajo la autopista)
[Estribillo]
C . . . | G . . . | x2             # repite esta línea 2 veces
[Estrofa]                          # sección vacía = repite la última definición
[Estribillo] x2                    # repite la sección 2 veces
```

- Acordes reconocidos: mayores, menores, 7, maj7, m7, dim, dim7, m7b5, aug, sus2, sus4, 7sus4,
  add9, 6, m6, 9, power chords (`A5`) y bajos alternativos (`G/B`). Enarmónicos (`Bb` = `A#`).
- Si un acorde no está en la biblioteca de digitaciones, la app genera una cejilla
  automáticamente (mayor, menor, 7, m7, maj7, sus4, 5).
- El patrón `strum` admite 1, 2 o 4 caracteres por beat (negras, corcheas o semicorcheas).
- Los comentarios empiezan por `#` (al inicio de línea o tras un espacio; `F#m` no es comentario).

## Pista de audio: que suene la canción

Por defecto solo suena el metrónomo. Para que suene la canción real:

1. En la **Biblioteca**, pulsa "Editar" en tu canción (en un ejemplo, "Editar" crea una copia).
2. En el panel **Pista de audio** del editor, pulsa "Cargar audio…" y elige el archivo (MP3,
   WAV, OGG, M4A). Se guarda en tu navegador (IndexedDB); no se sube a ningún sitio.
3. Sincroniza la pista con los acordes:
   - Pulsa **"Detectar tempo e inicio"**: la app analiza el audio y propone el tempo (BPM) y el
     instante del primer pulso. "Aplicar tempo" escribe la cabecera `tempo:` de la canción.
   - Ajusta **"Inicio del compás 1"** hasta que las líneas de compás de la forma de onda caigan
     sobre los golpes de la canción (botones ±0,01 s, ±0,1 s y ±1 pulso, o arrastra el marcador;
     `Shift+click` en la forma de onda lo fija ahí).
   - Comprueba con **"Escuchar con metrónomo"**: si los clics caen en los pulsos de la canción,
     está sincronizada.
4. En **Practicar**, la pista arranca con la cuenta atrás, se para al pausar y vuelve a empezar
   al reanudar o al repetir el bucle. Sigue la velocidad elegida (a menos velocidad suena más
   grave). Toggle "Pista" y volumen en la cabecera.

Importante: si la pista suena por altavoces, el micrófono la oirá y la evaluación no será
fiable. Usa **auriculares**. En Ajustes hay una opción de cancelación de eco por si no puedes.
La sincronización supone tempo constante (sin cambios de `tempo:` a mitad).

## Subir una canción y obtener los acordes automáticamente

En la **Biblioteca**, pulsa **"Desde audio…"** y elige el archivo de la canción. La app:

1. Guarda el audio en el navegador y estima el tempo y el primer pulso.
2. Detecta la tonalidad y asigna un acorde a cada pulso (mayores y menores; opcionalmente
   séptimas), suavizando para que los cambios caigan en los compases.
3. Genera el texto de la canción (`tempo:`, `time:`, `strum:` y los compases con sus acordes)
   y abre el editor con la pista ya sincronizada.

4. Deduce el **patrón de rasgueo** de la grabación: mide qué corcheas de cada compás llevan un
   golpe y escribe la línea `strum:` con ↓ en los tiempos y ↑ en los contratiempos. En el editor
   puedes repetirlo con "Detectar rasgueo del audio" y ver las flechas sobre la forma de onda.

5. Sigue el **pulso real** de la grabación (si la canción acelera o frena, el texto lleva
   cambios de `tempo:`) y separa la **estructura** en secciones (`[Intro]`, `[Estrofa]`,
   `[Estribillo]`, `[Puente]`, `[Final]`) por repetición y energía, para practicar cada parte
   en bucle desde el desplegable "Sección".

Es un **borrador**: con voz, batería y bajo mezclados, la detección acierta la mayoría de los
acordes, pero conviene repasarlos en el editor (pulsa "Escuchar con metrónomo" y corrige lo
que no cuadre). En el panel "Pista de audio" del editor también puedes volver a lanzar
"Detectar acordes" eligiendo compás (4/4 o 3/4) e incluir séptimas.

## Simplificar una canción para tocarla con pocos acordes

En el editor, la tarjeta **Simplificar** convierte cualquier canción (detectada o escrita) en una
versión fácil:

- **Quitar séptimas y extensiones** (Cmaj7 → C, Am7 → Am, G/B → G).
- **Proponer cejilla**: busca el traste de cejilla con el que los acordes quedan en formas
  abiertas (por ejemplo Eb Ab Bb Cm → cejilla 3 → C F G Am). La app ajusta la detección sola.
- **Sustituir acordes difíciles** (cejillas como F, Bm, F#m) por el acorde fácil más cercano: el
  que comparte más notas y encaja en la tonalidad.
- **Máximo de acordes** (3 a 6): se conservan los más frecuentes y el resto se aproxima a ellos.
  La previsualización dice qué porcentaje de la canción tocas sin cambios.

En la lista de acordes cada uno lleva su nivel (fácil / medio / difícil) y, si es difícil, una
recomendación con un clic para sustituirlo en toda la canción. Siempre puedes deshacer.

## Cómo juzga la app

Cada rasgueo esperado tiene una ventana de tiempo (150 ms antes, 250 ms después). Si detecta
un ataque en esa ventana, aparece el anillo de "a tiempo" al instante; unos 300 ms después
analiza el espectro (chroma de 12 notas) y decide si el acorde coincide con el esperado,
comprobando además la tercera (mayor/menor). Si no hay ataque, el rasgueo se marca como
perdido. El metrónomo suena en una frecuencia que el detector ignora, para que el clic no
cuente como rasgueo.

## Estructura

Ver `docs/SPEC.md` para la especificación completa (formato, DSP, motor, pantallas, tests).

```
src/music   notas, acordes y digitaciones
src/song    parser del formato de canción, tempo, ejemplos, almacenamiento
src/dsp     FFT, chroma, detección de ataques, detector de acordes
src/audio   micrófono, metrónomo, calibración
src/game    juez y motor de práctica
src/ui      autopista, diagramas y pantallas
tests       vitest
```
