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
