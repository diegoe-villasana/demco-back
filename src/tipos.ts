import type { FormatoNumero, Pregunta, TipoPregunta, ValorRespuesta } from './db.js';

// Contrato compartido por el backend: qué tipos existen, cómo se llaman sus
// claves en el formulario HTML y qué hay que validar. Debe mantenerse en
// sincronía con src/services/tiposPregunta.ts del frontend.

export const TIPOS_VALIDOS: TipoPregunta[] = [
  'genero',
  'si_no',
  'idioma',
  'ranking',
  'opcion_unica',
  'opcion_unica_comentario',
  'desplegable',
  'escala',
  'escala_n',
  'opcion_multiple',
  'opcion_multiple_comentario',
  'texto',
  'texto_linea',
  'texto_parrafos',
  'textos_multiples',
  'numero',
  'numero_multiple',
  'fecha',
  'matriz',
  'matriz_escala',
  'matriz_aumentar',
  'matriz_sino',
  'matriz_texto',
  'matriz_numero',
  'matriz_doble_eje',
  'matriz_columnas',
  'archivo',
  'mostrar_texto',
];

export const FORMATOS_NUMERO: FormatoNumero[] = ['entero', 'decimal', 'porcentaje', 'moneda'];

/** `opciones` es la lista de respuestas, o las filas si el tipo es matriz. */
export const TIPOS_CON_OPCIONES: TipoPregunta[] = [
  'genero',
  'si_no',
  'idioma',
  'ranking',
  'opcion_unica',
  'opcion_unica_comentario',
  'desplegable',
  'opcion_multiple',
  'opcion_multiple_comentario',
  'textos_multiples',
  'numero_multiple',
  'matriz',
  'matriz_escala',
  'matriz_aumentar',
  'matriz_sino',
  'matriz_texto',
  'matriz_numero',
  'matriz_doble_eje',
  'matriz_columnas',
];

export const TIPOS_MATRIZ: TipoPregunta[] = [
  'matriz',
  'matriz_escala',
  'matriz_aumentar',
  'matriz_sino',
  'matriz_texto',
  'matriz_numero',
  'matriz_doble_eje',
  'matriz_columnas',
];

/** Columnas que el autor puede editar. */
export const TIPOS_MATRIZ_CON_COLUMNAS: TipoPregunta[] = [
  'matriz',
  'matriz_aumentar',
  'matriz_sino',
  'matriz_columnas',
];

/**
 * Columnas obligatorias. En el resto son un valor por defecto del catálogo:
 * `matriz_escala` las genera del rango y `matriz_aumentar`/`matriz_sino` usan
 * su escala fija.
 */
export const TIPOS_MATRIZ_REQUIEREN_COLUMNAS: TipoPregunta[] = ['matriz_columnas'];

/** Tipos cuya respuesta es una lista ordenada o de varias opciones. */
export const TIPOS_MULTIVALOR: TipoPregunta[] = [
  'opcion_multiple',
  'opcion_multiple_comentario',
  'ranking',
  'archivo',
];

export const FILAS_MATRIZ_DEFAULT = [
  'Muy en desacuerdo',
  'En desacuerdo',
  'Neutral',
  'De acuerdo',
  'Muy de acuerdo',
];

export function esMatriz(tipo: TipoPregunta): boolean {
  return TIPOS_MATRIZ.includes(tipo);
}

export function usaOpciones(tipo: TipoPregunta): boolean {
  return TIPOS_CON_OPCIONES.includes(tipo);
}

export function usaColumnas(tipo: TipoPregunta): boolean {
  return TIPOS_MATRIZ_CON_COLUMNAS.includes(tipo);
}

export function esMultivalor(tipo: TipoPregunta): boolean {
  return TIPOS_MULTIVALOR.includes(tipo);
}

/** Bloque informativo: no genera control ni respuesta. */
export function esInformativa(tipo: TipoPregunta): boolean {
  return tipo === 'mostrar_texto';
}

export function rangoEscala(pregunta: Pregunta): { min: number; max: number } {
  const min = pregunta.minimo ?? 1;
  const max = Math.max(pregunta.maximo ?? 5, min);
  return { min, max };
}

/** Sufijo de la clave de una fila / ítem, igual que en el frontend. */
export function claveFila(preguntaId: string, fila: string): string {
  return `${preguntaId}-${fila}`;
}

export function claveComentario(preguntaId: string, opcion?: string): string {
  return opcion ? `${preguntaId}-comentario-${opcion}` : `${preguntaId}-comentario`;
}

export function valoresNumericos(valor: unknown): number[] {
  if (valor === undefined || valor === null || valor === '') return [];
  const n = typeof valor === 'number' ? valor : Number(String(valor));
  return Number.isFinite(n) ? [n] : [];
}

export function textos(valor: unknown): string[] {
  if (valor === undefined || valor === null || valor === '') return [];
  if (Array.isArray(valor)) return valor.map(String).filter(Boolean);
  if (typeof valor === 'object') return Object.values(valor as Record<string, string>).filter(Boolean);
  return [String(valor)];
}

/** Deja la respuesta solo si trae algo; si no, la quita del mapa. */
export function asignar(
  destino: Record<string, ValorRespuesta>,
  clave: string,
  valor: ValorRespuesta | undefined
): void {
  if (valor === undefined) return;
  if (typeof valor === 'string' && !valor.trim()) return;
  if (Array.isArray(valor) && valor.length === 0) return;
  if (typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor).length === 0) return;
  destino[clave] = valor;
}
