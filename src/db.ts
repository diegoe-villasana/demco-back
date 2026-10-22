// ============================================================================
//  DEMCO — Modelo de dominio + contrato de persistencia
//
//  Este archivo define QUÉ es una encuesta, una respuesta, etc. (los tipos
//  que consume el resto del backend) y CÓMO se guardan (la interfaz
//  `Repositorio`). La implementación de Supabase vive en
//  `repositorio-supabase.ts`.
//
//  Antes esto era un archivo lowdb con `db.read()` / `db.write()` y la lógica
//  de negocio accessing `db.data` directamente. Con una base de datos real
//  eso no funciona: no hay un array en memoria que mutar y volcar. Por eso
//  ahora todo pasa por un repositorio con métodos explícitos.
// ============================================================================

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

/** Actividad de una encuesta: respuestas, última actividad e invitaciones. */
export interface ResumenEncuesta {
  total: number;
  ultima: string | null;
  correos: number;
}

/** Datos que necesita el cálculo de estadísticas. */
export interface DatosEstadisticas {
  encuestas: Encuesta[];
  respuestas: RespuestaEncuesta[];
  envios: EnvioCorreo[];
}

/**
 * Contrato de persistencia. Todo lo que el backend necesita guardar pasa
 * por aquí; ninguna otra capa toca la base de datos.
 */
export interface Repositorio {
  /** Prepara la conexión y comprueba que el esquema existe. */
  init(): Promise<void>;

  // --- Encuestas -----------------------------------------------------------
  /** Todas las encuestas con su historial completo de versiones. */
  listarEncuestas(): Promise<Encuesta[]>;
  /** Una encuesta con su historial. `undefined` si no existe. */
  obtenerEncuesta(id: string): Promise<Encuesta | undefined>;
  /** Crea la encuesta con su primera versión. */
  crearEncuesta(encuesta: Encuesta): Promise<void>;
  /** Reemplaza el contenido editable de una versión. */
  actualizarVersion(encuestaId: string, version: EncuestaVersion): Promise<void>;
  /** Agrega una versión nueva al historial. */
  crearVersion(encuestaId: string, version: EncuestaVersion): Promise<void>;
  /** Borra la encuesta (y sus versiones, respuestas e invitaciones). */
  borrarEncuesta(id: string): Promise<void>;

  // --- Respuestas ----------------------------------------------------------
  /** Respuestas de una encuesta, o de todas si no se filtra. */
  listarRespuestas(encuestaId?: string): Promise<RespuestaEncuesta[]>;
  /** Guarda una respuesta. */
  guardarRespuesta(respuesta: RespuestaEncuesta): Promise<void>;
  /** Marca una versión como sellada (ya tiene respuestas). */
  sellarVersion(versionId: string): Promise<void>;
  /** Cuántas respuestas tiene cada versión. */
  conteoRespuestasPorVersion(): Promise<Map<string, number>>;

  // --- Correo ---------------------------------------------------------------
  /** Todos los envíos registrados. */
  listarEnvios(): Promise<EnvioCorreo[]>;
  /** Registra un envío de invitaciones. */
  registrarEnvio(envio: EnvioCorreo): Promise<void>;

  // --- Resúmenes -----------------------------------------------------------
  /** Actividad de cada encuesta (respuestas, última, invitaciones). */
  resumenPorEncuesta(): Promise<Map<string, ResumenEncuesta>>;
}

// ---------------------------------------------------------------------------
// Helpers puros (no dependen de la base de datos)
// ---------------------------------------------------------------------------

/** Devuelve la versión vigente de una encuesta (la de mayor número). */
export function versionActiva(encuesta: Encuesta | undefined): EncuestaVersion | undefined {
  if (!encuesta || !encuesta.versiones?.length) return undefined;
  return encuesta.versiones[encuesta.versiones.length - 1];
}

/** Busca una versión concreta dentro de una encuesta. */
export function buscarVersion(
  encuesta: Encuesta | undefined,
  versionId: string
): EncuestaVersion | undefined {
  return encuesta?.versiones.find((v) => v.id === versionId);
}
