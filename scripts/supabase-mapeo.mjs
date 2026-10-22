// ============================================================================
//  DEMCO — Mapeo de lowdb -> Postgres
//
//  Funciones puras: traducen el shape de data/db.json (camelCase, strings)
//  al shape de las tablas de Supabase (snake_case, timestamptz, jsonb).
//  Sin dependencias de red: se puede testear contra un Postgres local.
// ============================================================================

// ---------------------------------------------------------------------------
// Encuestas + versiones
// ---------------------------------------------------------------------------

/**
 * @param {any[]} encuestas  array `db.encuestas`
 * @returns {{filasEncuestas: any[], filasVersiones: any[]}}
 */
export function mapearEncuestas(encuestas) {
  const filasEncuestas = [];
  const filasVersiones = [];

  for (const enc of encuestas) {
    const versiones = Array.isArray(enc.versiones) ? enc.versiones : [];

    // `versionActiva()` en db.ts tomaba la última del array.
    const activa = versiones.length
      ? versiones.reduce((a, b) => ((b.numero ?? 0) > (a.numero ?? 0) ? b : a))
      : undefined;

    filasEncuestas.push({
      id: enc.id,
      creada_en: enc.creadaEn ?? new Date().toISOString(),
      // Se deja en null a propósito: la versión aún no existe cuando se
      // inserta la encuesta (FK circular). El trigger
      // `trg_sync_version_activa` lo rellena al insertar las versiones.
      version_activa_id: null,
    });

    for (const v of versiones) {
      filasVersiones.push({
        id: v.id,
        encuesta_id: enc.id,
        numero: v.numero ?? 1,
        titulo: v.titulo ?? 'Encuesta sin título',
        descripcion: v.descripcion ?? null,
        preguntas: v.preguntas ?? [],
        secciones: v.secciones ?? [],
        creada_en: v.creadaEn ?? enc.creadaEn ?? new Date().toISOString(),
        sellada: Boolean(v.sellada),
      });
    }
  }

  return { filasEncuestas, filasVersiones };
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

/**
 * @param {any[]} respuestas  array `db.respuestas`
 * @param {Set<string>} idsVersion    ids de versión existentes
 * @param {Set<string>} idsEncuesta  ids de encuesta existentes
 * @returns {{filas: any[], avisos: string[]}}
 */
export function mapearRespuestas(respuestas, idsVersion, idsEncuesta) {
  const avisos = [];

  const filas = respuestas.map((r) => {
    if (!idsEncuesta.has(r.encuestaId)) {
      avisos.push(
        `respuesta ${r.id}: encuesta ${r.encuestaId} no existe -> se omite`
      );
      return null;
    }

    let versionId = r.versionId ?? null;
    if (versionId && !idsVersion.has(versionId)) {
      avisos.push(
        `respuesta ${r.id}: versión ${versionId} no existe -> version_id = null`
      );
      versionId = null;
    }

    return {
      id: r.id,
      encuesta_id: r.encuestaId,
      version_id: versionId,
      respuestas: r.respuestas ?? {},
      fecha_respuesta: r.fechaRespuesta ?? new Date().toISOString(),
      recibido_en: r.recibidoEn ?? r.fechaRespuesta ?? new Date().toISOString(),
    };
  });

  return { filas: filas.filter(Boolean), avisos };
}

// ---------------------------------------------------------------------------
// Envíos de correo + invitaciones
// ---------------------------------------------------------------------------

/**
 * @param {any[]} enviosCorreo  array `db.enviosCorreo`
 * @param {Set<string>} idsEncuesta  ids de encuesta existentes
 * @returns {{filasEnvios: any[], filasInvitaciones: any[], avisos: string[]}}
 */
export function mapearEnvios(enviosCorreo, idsEncuesta) {
  const avisos = [];
  const filasEnvios = [];
  const filasInvitaciones = [];

  for (const e of enviosCorreo) {
    filasEnvios.push({
      id: e.id,
      destinatario: e.destinatario,
      asunto: e.asunto ?? '',
      proveedor: e.proveedor ?? 'simulado',
      enviado_en: e.enviadoEn ?? new Date().toISOString(),
    });

    // `encuestaIds: string[]` -> tabla puente envio_correo_encuestas.
    for (const encId of e.encuestaIds ?? []) {
      if (!idsEncuesta.has(encId)) {
        avisos.push(
          `envío ${e.id}: encuesta ${encId} no existe -> invitación omitida`
        );
        continue;
      }
      filasInvitaciones.push({ envio_id: e.id, encuesta_id: encId });
    }
  }

  return { filasEnvios, filasInvitaciones, avisos };
}

// ---------------------------------------------------------------------------
// Encuestas huérfanas
// ---------------------------------------------------------------------------

/**
 * Hay respuestas cuyo `encuestaId` no existe en `db.encuestas` (la encuesta
 * se borró del backend pero su respuesta quedó, porque lowdb no tiene
 * foreign keys). Postgres SÍ las rechaza.
 *
 * Esta función crea una encuesta "recuperada" por cada id huérfano, para
 * que las respuestas se puedan conservar con sus valores intactos.
 *
 * Lo que NO se puede recuperar: el texto de las preguntas y la versión
 * (esas filas ya no existen en ningún lado). Por eso las respuestas
 * recuperadas quedan con `version_id = null`.
 *
 * @param {any[]} respuestas  array `db.respuestas`
 * @param {Set<string>} idsEncuesta  ids de encuesta que sí existen
 * @returns {{filas: any[], huerfanos: string[]}}
 */
export function mapearHuerfanas(respuestas, idsEncuesta) {
  const huerfanos = new Set();

  for (const r of respuestas) {
    if (!idsEncuesta.has(r.encuestaId)) huerfanos.add(r.encuestaId);
  }

  const filas = [...huerfanos].map((id) => {
    // Fecha de creación: la de la respuesta más vieja de esa encuesta.
    const fechas = respuestas
      .filter((r) => r.encuestaId === id)
      .map((r) => r.fechaRespuesta)
      .filter(Boolean)
      .sort();
    return {
      id,
      creada_en: fechas[0] ?? new Date().toISOString(),
      version_activa_id: null,
    };
  });

  return { filas, huerfanos: [...huerfanos] };
}
