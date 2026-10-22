import {
  versionActiva,
  type DatosEstadisticas,
  type EncuestaVersion,
  type Pregunta,
  type RespuestaEncuesta,
  type ValorRespuesta,
} from './db.js';
import { esInformativa } from './tipos.js';

// Agregados del módulo de encuestas para el dashboard y la lista de
// proyectos. Se calculan aquí, en el servidor, para que el frontend no tenga
// que pedir respuesta por respuesta (ni por versión) sólo para pintar dos
// pantallas.

/** Estado de una encuesta según su actividad real, no según el calendario. */
export type EstadoEncuesta =
  | 'borrador'
  | 'enviada'
  | 'en_curso'
  | 'finalizada'
  | 'retrasada';

export interface EstadisticaEncuesta {
  id: string;
  titulo: string;
  descripcion?: string;
  estado: EstadoEncuesta;
  /** Respuestas recibidas de todas sus versiones. */
  respuestas: number;
  /** Preguntas respondibles de la versión activa. */
  preguntas: number;
  /** % de preguntas de la versión activa que ya tienen alguna respuesta. */
  cobertura: number;
  /** % promedio de llenado de las respuestas recibidas. */
  avance: number;
  versionNumero: number;
  sellada: boolean;
  creadaEn: string;
  ultimaRespuesta: string | null;
  ultimoEnvio: string | null;
  /** Destinatarios que recibieron esta encuesta por correo. */
  correosEnviados: number;
}

export interface AlertaEncuesta {
  id: string;
  titulo: string;
  motivo: string;
  severidad: 'alta' | 'media';
}

export interface Estadisticas {
  generadoEn: string;
  kpis: {
    encuestas: number;
    respuestas: number;
    correosEnviados: number;
    alertas: number;
    /** % promedio de cobertura de preguntas. */
    coberturaPromedio: number;
    /** % promedio de llenado de las respuestas. */
    llenadoPromedio: number;
  };
  /** Respuestas por mes (los últimos meses, incluido el actual). */
  serie: Array<{ clave: string; etiqueta: string; respuestas: number }>;
  encuestas: EstadisticaEncuesta[];
  alertas: AlertaEncuesta[];
}

/** Días sin actividad a partir de los cuales la encuesta deja de estar "viva". */
const DIAS_INACTIVIDAD = 30;

/** Cuántos meses se grafican en la serie de respuestas. */
const MESES_SERIE = 6;

const ETIQUETAS_MES = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

function diasDesde(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

function promedio(valores: number[]): number {
  if (valores.length === 0) return 0;
  return Math.round((valores.reduce((a, b) => a + b, 0) / valores.length) * 10) / 10;
}

/**
 * Las preguntas compuestas (matrices, doble eje) guardan una clave por fila:
 * `p1-Excelente`. Una pregunta cuenta como contestada si la respuesta trae
 * su clave exacta o alguna clave que empiece por `id-`.
 */
function tieneValor(valor: ValorRespuesta | undefined): boolean {
  if (valor === undefined || valor === null || valor === '') return false;
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor === 'object') return Object.keys(valor).length > 0;
  return true;
}

function respondio(respuestas: Record<string, ValorRespuesta>, preguntaId: string): boolean {
  for (const [clave, valor] of Object.entries(respuestas)) {
    if (clave !== preguntaId && !clave.startsWith(`${preguntaId}-`)) continue;
    if (tieneValor(valor)) return true;
  }
  return false;
}

function respondibles(version: EncuestaVersion): Pregunta[] {
  return version.preguntas.filter((p) => !esInformativa(p.tipo));
}

/** % de preguntas de una versión que esta respuesta sí contestar. */
function llenadoDe(
  respuesta: RespuestaEncuesta,
  preguntas: Pregunta[]
): number {
  if (preguntas.length === 0) return 0;
  let contestadas = 0;
  for (const p of preguntas) {
    if (respondio(respuesta.respuestas, p.id)) contestadas++;
  }
  return (contestadas / preguntas.length) * 100;
}

function claveDeMes(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mesesDeSerie(cantidad: number): Array<{ clave: string; etiqueta: string; respuestas: number }> {
  const hoy = new Date();
  const serie: Array<{ clave: string; etiqueta: string; respuestas: number }> = [];
  for (let i = cantidad - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    serie.push({
      clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      etiqueta: ETIQUETAS_MES[d.getMonth()],
      respuestas: 0,
    });
  }
  return serie;
}

function ultima(fechas: string[]): string | null {
  if (fechas.length === 0) return null;
  return fechas.reduce((a, b) => (a > b ? a : b));
}

/** Calcula el resumen completo del módulo de encuestas. */
export function calcularEstadisticas(datos: DatosEstadisticas): Estadisticas {
  const { encuestas: listaEncuestas, respuestas, envios } = datos;

  // Respuestas agrupadas por encuesta (para no recorrer todo por cada una).
  const porEncuesta = new Map<string, RespuestaEncuesta[]>();
  for (const r of respuestas) {
    const lista = porEncuesta.get(r.encuestaId);
    if (lista) lista.push(r);
    else porEncuesta.set(r.encuestaId, [r]);
  }

  const serie = mesesDeSerie(MESES_SERIE);
  const indiceMes = new Map(serie.map((m) => [m.clave, m]));
  for (const r of respuestas) {
    const mes = indiceMes.get(claveDeMes(r.fechaRespuesta));
    if (mes) mes.respuestas++;
  }

  const encuestas: EstadisticaEncuesta[] = [];
  const alertas: AlertaEncuesta[] = [];

  for (const encuesta of listaEncuestas) {
    const version = versionActiva(encuesta);
    if (!version) continue;

    const propias = porEncuesta.get(encuesta.id) ?? [];
    const enviosPropios = envios.filter((e) => e.encuestaIds.includes(encuesta.id));

    // Cada respuesta se evalúa contra las preguntas de la versión que vio
    // quien respondió: si la encuesta cambió, el llenado sigue siendo justo.
    const preguntasPorVersion = new Map<string, Pregunta[]>();
    for (const v of encuesta.versiones) preguntasPorVersion.set(v.id, respondibles(v));
    const preguntasActivas = preguntasPorVersion.get(version.id) ?? [];

    const contestadas = new Set<string>();
    const llenados: number[] = [];
    for (const r of propias) {
      const preguntas =
        (r.versionId ? preguntasPorVersion.get(r.versionId) : undefined) ?? preguntasActivas;
      llenados.push(llenadoDe(r, preguntas));
      for (const p of preguntas) {
        if (respondio(r.respuestas, p.id)) contestadas.add(p.id);
      }
    }

    const cobertura =
      preguntasActivas.length === 0
        ? 0
        : Math.round((contestadas.size / preguntasActivas.length) * 100);
    const avance = Math.round(promedio(llenados));

    const ultimoEnvio = ultima(enviosPropios.map((e) => e.enviadoEn));
    const ultimaRespuesta = ultima(propias.map((r) => r.fechaRespuesta));

    let estado: EstadoEncuesta;
    if (propias.length > 0) {
      estado = diasDesde(ultimaRespuesta) > DIAS_INACTIVIDAD ? 'finalizada' : 'en_curso';
    } else if (enviosPropios.length > 0) {
      estado = diasDesde(ultimoEnvio) > DIAS_INACTIVIDAD ? 'retrasada' : 'enviada';
    } else {
      estado = 'borrador';
    }

    encuestas.push({
      id: encuesta.id,
      titulo: version.titulo,
      descripcion: version.descripcion,
      estado,
      respuestas: propias.length,
      preguntas: preguntasActivas.length,
      cobertura,
      avance,
      versionNumero: version.numero,
      sellada: version.sellada,
      creadaEn: encuesta.creadaEn,
      ultimaRespuesta,
      ultimoEnvio,
      correosEnviados: enviosPropios.length,
    });

    if (estado === 'retrasada') {
      alertas.push({
        id: encuesta.id,
        titulo: version.titulo,
        motivo: `Enviada hace ${Math.floor(diasDesde(ultimoEnvio))} días y sigue sin respuestas`,
        severidad: 'alta',
      });
    } else if (estado === 'borrador' && diasDesde(encuesta.creadaEn) > DIAS_INACTIVIDAD) {
      alertas.push({
        id: encuesta.id,
        titulo: version.titulo,
        motivo: `Creada hace ${Math.floor(diasDesde(encuesta.creadaEn))} días y nunca se envió`,
        severidad: 'media',
      });
    }
  }

  // Orden de la lista de proyectos: primero las que ya tienen respuestas
  // (son las que se pueden revisar), luego las que están esperando y al
  // final las que todavía no se difundieron. Dentro de cada grupo, la más
  // reciente primero.
  const prioridad = (estado: EstadoEncuesta): number => {
    switch (estado) {
      case 'en_curso':
        return 0;
      case 'finalizada':
        return 1;
      case 'retrasada':
        return 2;
      case 'enviada':
        return 3;
      default:
        return 4;
    }
  };

  encuestas.sort((a, b) => {
    const pa = prioridad(a.estado);
    const pb = prioridad(b.estado);
    if (pa !== pb) return pa - pb;
    const fa = a.ultimaRespuesta ?? a.ultimoEnvio ?? a.creadaEn;
    const fb = b.ultimaRespuesta ?? b.ultimoEnvio ?? b.creadaEn;
    return fa < fb ? 1 : fa > fb ? -1 : 0;
  });

  const conRespuestas = encuestas.filter((e) => e.respuestas > 0);

  // "Invitaciones": un mismo correo puede linkear varias encuestas, así que
  // se cuenta por encuesta enviada y no por correo.
  const invitaciones = envios.reduce(
    (a, e) => a + (e.encuestaIds?.length ?? 0),
    0
  );

  return {
    generadoEn: new Date().toISOString(),
    kpis: {
      encuestas: encuestas.length,
      respuestas: respuestas.length,
      correosEnviados: invitaciones,
      alertas: alertas.length,
      coberturaPromedio: promedio(conRespuestas.map((e) => e.cobertura)),
      llenadoPromedio: promedio(conRespuestas.map((e) => e.avance)),
    },
    serie,
    encuestas,
    alertas,
  };
}
