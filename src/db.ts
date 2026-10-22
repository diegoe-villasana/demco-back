import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

export type TipoPregunta =
  // Predefinidas (máscaras)
  | 'genero'
  | 'si_no'
  | 'idioma'
  | 'ranking'
  // Respuesta única
  | 'opcion_unica'
  | 'opcion_unica_comentario'
  | 'desplegable'
  | 'escala'
  | 'escala_n'
  // Opción múltiple
  | 'opcion_multiple'
  | 'opcion_multiple_comentario'
  // Texto libre
  | 'texto'
  | 'texto_linea'
  | 'texto_parrafos'
  | 'textos_multiples'
  // Numéricos y fecha
  | 'numero'
  | 'numero_multiple'
  | 'fecha'
  // Matrices
  | 'matriz'
  | 'matriz_escala'
  | 'matriz_aumentar'
  | 'matriz_sino'
  | 'matriz_texto'
  | 'matriz_numero'
  | 'matriz_doble_eje'
  | 'matriz_columnas'
  // Especiales
  | 'archivo'
  | 'mostrar_texto';

export type FormatoNumero = 'entero' | 'decimal' | 'porcentaje' | 'moneda';

// Una sección divide la encuesta en tramos. Las preguntas apuntan a su
// sección con `seccionId`; las que no lo tienen se muestran al final, sin
// encabezado.
export interface Seccion {
  id: string;
  titulo: string;
  descripcion?: string;
}

export interface Pregunta {
  id: string;
  texto: string;
  tipo: TipoPregunta;
  /** Sección a la que pertenece la pregunta (opcional). */
  seccionId?: string;
  /** Opciones de respuesta. En matrices son las filas. */
  opciones?: string[];
  /** Columnas de la matriz. En `matriz_columnas` son los ítems a calificar. */
  columnas?: string[];
  obligatorio?: boolean;
  placeholder?: string;
  minimo?: number;
  maximo?: number;
  formato?: FormatoNumero;
  puntos?: number;
  ejeIzquierdo?: string;
  ejeDerecho?: string;
  otro?: boolean;
  variosArchivos?: boolean;
  extensiones?: string[];
  tamanoMaximo?: number;
}

export type ValorRespuesta = string | number | string[] | Record<string, string>;

// Una versión es la foto inmutable de la encuesta que vio el respondent.
// Se "sella" en cuanto llega su primera respuesta: desde ahí no se edita, se
// crea una versión nueva. Así los resultados históricos siempre se pueden
// interpretar contra las preguntas que realmente vio quien respondió.
export interface EncuestaVersion {
  id: string;
  numero: number;
  titulo: string;
  descripcion?: string;
  preguntas: Pregunta[];
  /** Tramos de la encuesta (opcional). */
  secciones?: Seccion[];
  creadaEn: string;
  sellada: boolean;
}

export interface Encuesta {
  id: string;
  creadaEn: string;
  versiones: EncuestaVersion[];
}

export interface RespuestaEncuesta {
  id: string;
  encuestaId: string;
  // Qué versión vio el respondent. Las respuestas viejas (migradas) apuntan a
  // la primera versión, que es la única que existía antes del versionado.
  versionId: string | null;
  respuestas: Record<string, ValorRespuesta>;
  fechaRespuesta: string;
  recibidoEn: string; // fecha en la que el backend la recibió
}

export interface EnvioCorreo {
  id: string;
  destinatario: string;
  encuestaIds: string[];
  asunto: string;
  proveedor: string;
  enviadoEn: string;
}

interface DBSchema {
  encuestas: Encuesta[];
  respuestas: RespuestaEncuesta[];
  enviosCorreo: EnvioCorreo[];
}

const PREGUNTAS_ENC1: Pregunta[] = [
  { id: 'p1', texto: '¿Qué tan satisfecho estás con la estabilidad del servicio?', tipo: 'escala' },
  { id: 'p2', texto: '¿Has tenido interrupciones en el último mes?', tipo: 'opcion_multiple', opciones: ['Sí', 'No'] },
  { id: 'p3', texto: 'Comentarios adicionales', tipo: 'texto' },
];

const PREGUNTAS_ENC2: Pregunta[] = [
  { id: 'p1', texto: '¿Te interesaría instalar paneles solares?', tipo: 'opcion_multiple', opciones: ['Sí', 'No', 'Tal vez'] },
  { id: 'p2', texto: '¿Qué te detiene actualmente?', tipo: 'texto' },
];

function crearSemilla(): DBSchema {
  const ahora = new Date().toISOString();
  return {
    encuestas: [
      {
        id: 'enc-1',
        creadaEn: ahora,
        versiones: [
          {
            id: randomUUID(),
            numero: 1,
            titulo: 'Satisfacción del servicio eléctrico',
            descripcion: 'Ayúdanos a mejorar tu experiencia con DEMCO',
            preguntas: PREGUNTAS_ENC1,
            creadaEn: ahora,
            sellada: false,
          },
        ],
      },
      {
        id: 'enc-2',
        creadaEn: ahora,
        versiones: [
          {
            id: randomUUID(),
            numero: 1,
            titulo: 'Interés en energía solar',
            preguntas: PREGUNTAS_ENC2,
            creadaEn: ahora,
            sellada: false,
          },
        ],
      },
    ],
    respuestas: [],
    enviosCorreo: [],
  };
}

const adapter = new JSONFile<DBSchema>(DB_FILE);
export const db = new Low<DBSchema>(adapter, crearSemilla());

// Devuelve la versión vigente de una encuesta (la de mayor número), o
// undefined si la encuesta no existe. `GET /` y `/e/:id` usan esta.
export function versionActiva(encuesta: Encuesta | undefined): EncuestaVersion | undefined {
  if (!encuesta || !encuesta.versiones?.length) return undefined;
  return encuesta.versiones[encuesta.versiones.length - 1];
}

export function buscarEncuesta(id: string): Encuesta | undefined {
  return db.data!.encuestas.find((e) => e.id === id);
}

export function buscarVersion(encuestaId: string, versionId: string): EncuestaVersion | undefined {
  return buscarEncuesta(encuestaId)?.versiones.find((v) => v.id === versionId);
}

// Migra bases escritas antes del versionado:
//   1. encuestas planas -> contenedor con una sola versión
//   2. respuestas sin versionId -> apuntan a esa primera versión
//   3. versiones que ya tienen respuestas -> selladas
// Es idempotente: se puede correr en cada arranque.
function migrar(): void {
  const ahora = new Date().toISOString();

  for (const encuesta of db.data!.encuestas) {
    if (Array.isArray(encuesta.versiones) && encuesta.versiones.length > 0) continue;

    // Shape viejo: titulo/descripcion/preguntas viven en la encuesta.
    const legacy = encuesta as unknown as Record<string, unknown>;
    const preguntas = Array.isArray(legacy.preguntas) ? (legacy.preguntas as Pregunta[]) : [];
    const titulo = typeof legacy.titulo === 'string' ? legacy.titulo : 'Encuesta sin título';

    encuesta.versiones = [
      {
        id: randomUUID(),
        numero: 1,
        titulo,
        descripcion: typeof legacy.descripcion === 'string' ? legacy.descripcion : undefined,
        preguntas,
        creadaEn: typeof encuesta.creadaEn === 'string' ? encuesta.creadaEn : ahora,
        sellada: false,
      },
    ];
    encuesta.creadaEn = typeof encuesta.creadaEn === 'string' ? encuesta.creadaEn : ahora;
    delete legacy.titulo;
    delete legacy.descripcion;
    delete legacy.preguntas;
  }

  for (const respuesta of db.data!.respuestas) {
    if (respuesta.versionId) continue;
    const encuesta = buscarEncuesta(respuesta.encuestaId);
    respuesta.versionId = encuesta?.versiones[0]?.id ?? null;
  }

  // Sella cualquier versión que ya tenga respuestas: a partir de aquí es
  // inmutable, porque sus respuestas dependen de sus preguntas exactas.
  const porVersion = new Map<string, number>();
  for (const r of db.data!.respuestas) {
    if (!r.versionId) continue;
    porVersion.set(r.versionId, (porVersion.get(r.versionId) ?? 0) + 1);
  }
  for (const encuesta of db.data!.encuestas) {
    for (const version of encuesta.versiones) {
      if ((porVersion.get(version.id) ?? 0) > 0) version.sellada = true;
    }
  }
}

export async function initDB() {
  await db.read();
  if (!db.data) {
    db.data = crearSemilla();
    await db.write();
    return;
  }
  db.data.encuestas ||= [];
  db.data.respuestas ||= [];
  db.data.enviosCorreo ||= [];
  migrar();
  await db.write();
}
