// ============================================================================
//  DEMCO — Repositorio sobre Supabase (Postgres)
//
//  Habla con Postgres por la API REST de PostgREST (supabase-js). Los
//  nombres de columna son snake_case; aquí se traduce al modelo de dominio
//  (camelCase) que consume el resto del backend.
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  type Encuesta,
  type EncuestaVersion,
  type EnvioCorreo,
  type Pregunta,
  type Repositorio,
  type RespuestaEncuesta,
  type ResumenEncuesta,
  type Seccion,
  type ValorRespuesta,
} from './db.js';

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------

let cliente: SupabaseClient | null = null;

function obtenerCliente(): SupabaseClient {
  if (cliente) return cliente;

  const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el .env del backend. ' +
        'Copia .env.example a .env y pega las credenciales de Supabase (Settings > API).'
    );
  }

  cliente = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cliente;
}

/**
 * Ejecuta una consulta y lanza si Supabase devuelve error.
 *
 * El parámetro va como `any` a propósito: los builders de supabase-js tienen
 * tipos dependentemente del esquema (que no tenemos generado) y encajarlos
 * aquí solo produciría ruido. El tipo de la fila se fija en la llamada.
 */
async function consultar<T>(operacion: any): Promise<T[]> {
  const { data, error } = await operacion;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return (data ?? []) as T[];
}

// ---------------------------------------------------------------------------
// Traducción entre filas de Postgres y el modelo de dominio
// ---------------------------------------------------------------------------

interface FilaEncuesta {
  id: string;
  creada_en: string;
  version_activa_id: string | null;
}

interface FilaVersion {
  id: string;
  encuesta_id: string;
  numero: number;
  titulo: string;
  descripcion: string | null;
  preguntas: Pregunta[];
  secciones: Seccion[] | null;
  creada_en: string;
  sellada: boolean;
}

interface FilaRespuesta {
  id: string;
  encuesta_id: string;
  version_id: string | null;
  respuestas: Record<string, ValorRespuesta>;
  fecha_respuesta: string;
  recibido_en: string;
}

interface FilaEnvio {
  id: string;
  destinatario: string;
  asunto: string;
  proveedor: string;
  enviado_en: string;
}

/** Postgres devuelve `2026-08-10T01:15:04.29+00:00`; lo normalizamos a ISO. */
function iso(valor: string | null | undefined): string {
  if (!valor) return new Date().toISOString();
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function isoOpcional(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function aVersion(fila: FilaVersion): EncuestaVersion {
  return {
    id: fila.id,
    numero: fila.numero,
    titulo: fila.titulo,
    descripcion: fila.descripcion ?? undefined,
    preguntas: fila.preguntas ?? [],
    secciones: fila.secciones ?? [],
    creadaEn: iso(fila.creada_en),
    sellada: fila.sellada,
  };
}

function aRespuesta(fila: FilaRespuesta): RespuestaEncuesta {
  return {
    id: fila.id,
    encuestaId: fila.encuesta_id,
    versionId: fila.version_id,
    respuestas: fila.respuestas ?? {},
    fechaRespuesta: iso(fila.fecha_respuesta),
    recibidoEn: iso(fila.recibido_en),
  };
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export const repositorioSupabase: Repositorio = {
  async init() {
    const sb = obtenerCliente();

    // Comprobación de humo: si el esquema no está aplicado, esto falla con
    // un mensaje claro en vez de un error raro en la primera request.
    const { error } = await sb
      .from('encuestas')
      .select('id', { count: 'exact', head: true });
    if (error) {
      throw new Error(
        `No se pudo leer la tabla "encuestas" en Supabase: ${error.message}\n` +
          '¿Ya aplicaste supabase/schema.sql en el SQL Editor de Supabase Studio?'
      );
    }

    // La vista es una optimización, no un requisito: si falta, el conteo por
    // versión se hace en memoria. Avisamos para que la apliquen.
    const { error: errorVista } = await sb
      .from('v_respuestas_por_version')
      .select('version_id')
      .limit(1);
    if (errorVista) {
      console.warn(
        '[aviso] Falta la vista "v_respuestas_por_version". Vuelve a aplicar ' +
          'supabase/schema.sql en el SQL Editor de Supabase para activarla.'
      );
    }
  },

  // --- Encuestas -----------------------------------------------------------

  async listarEncuestas(): Promise<Encuesta[]> {
    const sb = obtenerCliente();

    const [filasEncuesta, filasVersion] = await Promise.all([
      consultar<FilaEncuesta>(sb.from('encuestas').select('*').order('creada_en')),
      consultar<FilaVersion>(
        sb.from('encuesta_versiones').select('*').order('encuesta_id').order('numero')
      ),
    ]);

    const porEncuesta = new Map<string, EncuestaVersion[]>();
    for (const fila of filasVersion) {
      const lista = porEncuesta.get(fila.encuesta_id);
      const version = aVersion(fila);
      if (lista) lista.push(version);
      else porEncuesta.set(fila.encuesta_id, [version]);
    }

    return filasEncuesta.map((fila) => ({
      id: fila.id,
      creadaEn: iso(fila.creada_en),
      versiones: porEncuesta.get(fila.id) ?? [],
    }));
  },

  async obtenerEncuesta(id: string): Promise<Encuesta | undefined> {
    const sb = obtenerCliente();

    const { data: fila, error } = await sb
      .from('encuestas')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Supabase: ${error.message}`);
    if (!fila) return undefined;

    const filasVersion = await consultar<FilaVersion>(
      sb.from('encuesta_versiones').select('*').eq('encuesta_id', id).order('numero')
    );

    return {
      id: fila.id,
      creadaEn: iso(fila.creada_en),
      versiones: filasVersion.map(aVersion),
    };
  },

  async crearEncuesta(encuesta: Encuesta): Promise<void> {
    const sb = obtenerCliente();
    const primera = encuesta.versiones[0];
    if (!primera) throw new Error('Una encuesta necesita al menos una versión');

    const { error: e1 } = await sb.from('encuestas').insert({
      id: encuesta.id,
      creada_en: encuesta.creadaEn,
      // El puntero lo pone el trigger cuando entra la versión.
      version_activa_id: null,
    });
    if (e1) throw new Error(`Supabase: ${e1.message}`);

    const { error: e2 } = await sb.from('encuesta_versiones').insert({
      id: primera.id,
      encuesta_id: encuesta.id,
      numero: primera.numero,
      titulo: primera.titulo,
      descripcion: primera.descripcion ?? null,
      preguntas: primera.preguntas,
      secciones: primera.secciones ?? [],
      creada_en: primera.creadaEn,
      sellada: primera.sellada,
    });
    if (e2) throw new Error(`Supabase: ${e2.message}`);
  },

  async actualizarVersion(encuestaId: string, version: EncuestaVersion): Promise<void> {
    const sb = obtenerCliente();

    const { error } = await sb
      .from('encuesta_versiones')
      .update({
        titulo: version.titulo,
        descripcion: version.descripcion ?? null,
        preguntas: version.preguntas,
        secciones: version.secciones ?? [],
        sellada: version.sellada,
      })
      .eq('id', version.id)
      .eq('encuesta_id', encuestaId);
    if (error) throw new Error(`Supabase: ${error.message}`);
  },

  async crearVersion(encuestaId: string, version: EncuestaVersion): Promise<void> {
    const sb = obtenerCliente();

    const { error } = await sb.from('encuesta_versiones').insert({
      id: version.id,
      encuesta_id: encuestaId,
      numero: version.numero,
      titulo: version.titulo,
      descripcion: version.descripcion ?? null,
      preguntas: version.preguntas,
      secciones: version.secciones ?? [],
      creada_en: version.creadaEn,
      sellada: version.sellada,
    });
    if (error) throw new Error(`Supabase: ${error.message}`);

    // El trigger pone `version_activa_id` en la versión de mayor número.
  },

  async borrarEncuesta(id: string): Promise<void> {
    const sb = obtenerCliente();

    // Las versiones, respuestas e invitaciones caen por ON DELETE CASCADE.
    const { error } = await sb.from('encuestas').delete().eq('id', id);
    if (error) throw new Error(`Supabase: ${error.message}`);
  },

  // --- Respuestas ----------------------------------------------------------

  async listarRespuestas(encuestaId?: string): Promise<RespuestaEncuesta[]> {
    const sb = obtenerCliente();

    let consulta = sb.from('respuestas').select('*').order('fecha_respuesta');
    if (encuestaId) consulta = consulta.eq('encuesta_id', encuestaId);

    const filas = await consultar<FilaRespuesta>(consulta);
    return filas.map(aRespuesta);
  },

  async guardarRespuesta(respuesta: RespuestaEncuesta): Promise<void> {
    const sb = obtenerCliente();

    // ignoreDuplicates: el front puede reintentar el envío (Background Sync
    // disparó dos veces) y no debe crear dos respuestas.
    const { error } = await sb.from('respuestas').upsert(
      {
        id: respuesta.id,
        encuesta_id: respuesta.encuestaId,
        version_id: respuesta.versionId,
        respuestas: respuesta.respuestas,
        fecha_respuesta: respuesta.fechaRespuesta,
        recibido_en: respuesta.recibidoEn,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );
    if (error) throw new Error(`Supabase: ${error.message}`);
  },

  async sellarVersion(versionId: string): Promise<void> {
    const sb = obtenerCliente();

    const { error } = await sb
      .from('encuesta_versiones')
      .update({ sellada: true })
      .eq('id', versionId);
    if (error) throw new Error(`Supabase: ${error.message}`);
  },

  async conteoRespuestasPorVersion(): Promise<Map<string, number>> {
    const sb = obtenerCliente();

    // Preferred: la vista `v_respuestas_por_version` (agrega en Postgres).
    // Si el esquema se aplicó antes de que existiera esa vista, se cae al
    // conteo en memoria para no romper.
    const { data, error } = await sb.from('v_respuestas_por_version').select('*');
    if (!error && data) {
      const conteo = new Map<string, number>();
      for (const fila of data as Array<{ version_id: string; total: number }>) {
        conteo.set(fila.version_id, fila.total);
      }
      return conteo;
    }

    const filas = await consultar<{ version_id: string | null }>(
      sb.from('respuestas').select('version_id')
    );
    const conteo = new Map<string, number>();
    for (const fila of filas) {
      if (!fila.version_id) continue;
      conteo.set(fila.version_id, (conteo.get(fila.version_id) ?? 0) + 1);
    }
    return conteo;
  },

  // --- Correo ---------------------------------------------------------------

  async listarEnvios(): Promise<EnvioCorreo[]> {
    const sb = obtenerCliente();

    const [filasEnvio, filasInvitacion] = await Promise.all([
      consultar<FilaEnvio>(sb.from('envios_correo').select('*').order('enviado_en')),
      consultar<{ envio_id: string; encuesta_id: string }>(
        sb.from('envio_correo_encuestas').select('*')
      ),
    ]);

    const porEnvio = new Map<string, string[]>();
    for (const fila of filasInvitacion) {
      const lista = porEnvio.get(fila.envio_id);
      if (lista) lista.push(fila.encuesta_id);
      else porEnvio.set(fila.envio_id, [fila.encuesta_id]);
    }

    return filasEnvio.map((fila) => ({
      id: fila.id,
      destinatario: fila.destinatario,
      encuestaIds: porEnvio.get(fila.id) ?? [],
      asunto: fila.asunto,
      proveedor: fila.proveedor,
      enviadoEn: iso(fila.enviado_en),
    }));
  },

  async registrarEnvio(envio: EnvioCorreo): Promise<void> {
    const sb = obtenerCliente();

    const { error: e1 } = await sb.from('envios_correo').insert({
      id: envio.id,
      destinatario: envio.destinatario,
      asunto: envio.asunto,
      proveedor: envio.proveedor,
      enviado_en: envio.enviadoEn,
    });
    if (e1) throw new Error(`Supabase: ${e1.message}`);

    if (envio.encuestaIds.length === 0) return;

    const { error: e2 } = await sb.from('envio_correo_encuestas').insert(
      envio.encuestaIds.map((encuestaId) => ({
        envio_id: envio.id,
        encuesta_id: encuestaId,
      }))
    );
    if (e2) throw new Error(`Supabase: ${e2.message}`);
  },

  // --- Resúmenes -----------------------------------------------------------

  async resumenPorEncuesta(): Promise<Map<string, ResumenEncuesta>> {
    const sb = obtenerCliente();

    const filas = await consultar<{
      encuesta_id: string;
      total_respuestas: number;
      ultima_respuesta: string | null;
      invitaciones: number;
    }>(sb.from('v_encuesta_resumen').select('*'));

    const resumen = new Map<string, ResumenEncuesta>();
    for (const fila of filas) {
      resumen.set(fila.encuesta_id, {
        total: fila.total_respuestas,
        ultima: isoOpcional(fila.ultima_respuesta),
        correos: fila.invitaciones,
      });
    }
    return resumen;
  },
};
