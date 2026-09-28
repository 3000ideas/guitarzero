/**
 * Bundled example songs (SPEC.md section 8). They are read-only (`builtin: true`), never
 * persisted, and their ids start with `ex:`. Together they cover every feature of the song
 * format: 4/4 and 3/4, `*n`, `N.C.`, rests `-`, tempo changes, patterns with `U` and `x`,
 * line repeats (`x2`), section repeats (`[Sección] x2`), section recalls, lyrics (`>`) and capo.
 * Every example must parse with zero errors and zero warnings (tests/song/examples.test.ts).
 */
import type { StoredSong } from '../types';

/** Prefix of every bundled example id. */
export const EXAMPLE_ID_PREFIX = 'ex:';

/** Fixed `updatedAt` of the bundled examples (they are never sorted among user songs). */
export const EXAMPLES_UPDATED_AT = Date.UTC(2025, 0, 1);

export function isExampleId(id: string): boolean {
  return id.startsWith(EXAMPLE_ID_PREFIX);
}

function example(slug: string, title: string, artist: string, source: string): StoredSong {
  return { id: EXAMPLE_ID_PREFIX + slug, title, artist, source, updatedAt: EXAMPLES_UPDATED_AT, builtin: true };
}

// ---------------------------------------------------------------- sources

const POP_PROGRESSION = `title: Progresión pop (C G Am F)
artist: Progresión genérica
tempo: 100
time: 4/4
strum: D-DU-UDU

[Intro]
C . . . | G . . . | Am . . . | F . . . |

[Estrofa]
C . . . | G . . . | Am . . . | F . . . | x2

[Estribillo]
C G | Am F | x2                  # acordes desnudos: 2 + 2 beats
C . . . | G . . . | Am*2 F*2 | C . . . |

[Estrofa]                        # vuelve a insertar la estrofa

[Estribillo] x2                  # estribillo dos veces
`;

const BLUES_IN_A = `title: Blues en A (12 compases)
artist: Progresión genérica
tempo: 92
time: 4/4
strum: D-DUD-DU

[Intro]
N.C. . . . | N.C. . . . |        # riff de guitarra: la pelota bota, no se juzga
A7 - - - | E7 - - - |            # golpes en el primer tiempo (stop-time)

[Vuelta] x2
A7 . . . | D7 . . . | A7 . . . | A7 . . . |
D7 . . . | D7 . . . | A7 . . . | A7 . . . |
E7 . . . | D7 . . . | A7 . . . | A7*2 E7*2 |

[Final]
A7 . . . | D7 . . . | A7*2 E7*2 | A7 - - - |
`;

const CIELITO_LINDO = `title: Cielito Lindo
artist: Tradicional (México)
tempo: 140
time: 3/4
strum: D-DUDU

[Intro]
C . . | G7 . . | G7 . . | C . . | x2

[Estrofa]
C . . | C . . | C . . | G7 . . |
G7 . . | G7 . . | G7 . . | C . . |
C . . | C7 . . | F . . | F . . |
G7 . . | G7 . . | C . . | C . . |

[Estribillo]
C . . | C . . | G7 . . | G7 . . |
> Ay, ay, ay, ay, canta y no llores
G7 . . | G7 . . | C . . | C . . |
C . . | C7 . . | F . . | F . . |
G7 . . | G7 . . | C . . | C . . |

[Estrofa]
[Estribillo]
`;

const CUMPLEANOS_FELIZ = `title: Cumpleaños feliz
artist: Tradicional
tempo: 116
time: 3/4
strum: D-DUDU

[Canción] x2
- - C |                          # anacrusa: el canto empieza en el tercer tiempo
> Cumpleaños feliz, cumpleaños feliz
C . . | G7 . . | G7 . . | C . . |
C . . | F . . | C*2 G7 | C . . |
> te deseamos todos, cumpleaños feliz
`;

const AMAZING_GRACE = `title: Amazing Grace
artist: John Newton (1779), tradicional
tempo: 72
time: 3/4
strum: D-DUDU

[Estrofa]
- - G |                          # anacrusa ("A-")
G . . | C . . | G . . | G . . |
> Amazing grace, how sweet the sound
G . . | G*2 Em | D . . | D . . |
> that saved a wretch like me
G . . | C . . | G . . | G . . |
> I once was lost, but now am found,
G . . | D . . | G . . | G . . |
> was blind, but now I see

[Estrofa]                        # segunda vuelta

[Final]                          # coda más lenta
tempo: 60
G . . | D . . | G . . | G - - |
> was blind, but now I see
`;

const BALLAD_EM_C_G_D = `title: Balada Em C G D
artist: Progresión genérica
tempo: 84
time: 4/4
strum: D-DU-UDU
capo: 2

[Intro]
Em . . . | C . . . | G . . . | D . . . |

[Estrofa]
Em . . . | C . . . | G . . . | D . . . | x2
Em . . . | C . . . | G*2 D*2 | Em . . . |

[Estribillo]
C . . . | D . . . | Em . . . | Em . . . |
C . . . | D . . . | G . . . | G . . . |

[Puente]
tempo: 72                        # el puente va más lento
Am . . . | C . . . | G . . . | D . . . |
Am . . . | C . . . | D . . . | D . . . |

[Estrofa]                        # se recupera con su tempo original (84)

[Estribillo] x2

[Final]
tempo: 64
C . . . | D . . . | Em*2 - - | Em - - - |
`;

const SODOMA_INTRO = `title: Sodoma (primera intro)
artist: Canción personal
tempo: 80
strum: D-D-U-U-

D . . . | F#m . . . | D . . . | A . . . |
D . . . | F#m . . . | D . . . | D . . . |
`;

const LA_BAMBA = `title: La Bamba
artist: Tradicional (Veracruz)
tempo: 150
time: 4/4
strum: D-DUxUDU

[Intro]
N.C. . . . | N.C. . . . |        # riff de guitarra sobre C F G
C . F . | G . . . | x2

[Estrofa]
C . F . | G . . . | x4

[Estribillo]
C . F . | G . . . | x4

[Estrofa]

[Estribillo] x2

[Final]
C . F . | G*2 - - | C*2 - - |
`;

// ---------------------------------------------------------------- catalogue

export const EXAMPLE_SONGS: StoredSong[] = [
  example('pop-c-g-am-f', 'Progresión pop (C G Am F)', 'Progresión genérica', POP_PROGRESSION),
  example('blues-en-a', 'Blues en A (12 compases)', 'Progresión genérica', BLUES_IN_A),
  example('cielito-lindo', 'Cielito Lindo', 'Tradicional (México)', CIELITO_LINDO),
  example('cumpleanos-feliz', 'Cumpleaños feliz', 'Tradicional', CUMPLEANOS_FELIZ),
  example('amazing-grace', 'Amazing Grace', 'John Newton (1779), tradicional', AMAZING_GRACE),
  example('balada-em-c-g-d', 'Balada Em C G D', 'Progresión genérica', BALLAD_EM_C_G_D),
  example('la-bamba', 'La Bamba', 'Tradicional (Veracruz)', LA_BAMBA),
  example('sodoma-intro', 'Sodoma (primera intro)', 'Canción personal', SODOMA_INTRO),
];
