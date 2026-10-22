import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, buscarEncuesta, versionActiva, type EncuestaVersion, type Pregunta, type Seccion } from '../db.js';
import { calcularEstadisticas } from '../estadisticas.js';
import { enviarCorreo, construirCorreoEncuestas, type EncuestaParaCorreo } from '../mailer.js';
import {
  FORMATOS_NUMERO,
  TIPOS_MATRIZ_REQUIEREN_COLUMNAS,
  TIPOS_VALIDOS,
  usaOpciones,
} from '../tipos.js';

export const encuestasRouter = Router();

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function urlBasePublica(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

// Forma que consume el frontend: la versión aplanada + metadata de versión,
// para que la app pueda cachear y mostrar "v3" sin conocer el contenedor.
function aplanar(
  encuestaId: string,
  version: EncuestaVersion,
  totalRespuestas: number,
  ultimaRespuesta: string | null,
  correosEnviados: number
) {
  return {
    id: encuestaId,
    titulo: version.titulo,
    descripcion: version.descripcion,
    preguntas: version.preguntas,
    secciones: version.secciones ?? [],
    versionId: version.id,
    versionNumero: version.numero,
    creadaEn: version.creadaEn,
    sellada: version.sellada,
    totalRespuestas,
    ultimaRespuesta,
    correosEnviados,
  };
}

// Resumen de actividad de una encuesta: cuántas respuestas tiene, cuándo llegó
// la última y a cuántos destinatarios se le envió.
function resumenDe(encuestaId: string): {
  total: number;
  ultima: string | null;
  correos: number;
} {
  let total = 0;
  let ultima: string | null = null;
  for (const r of db.data!.respuestas) {
    if (r.encuestaId !== encuestaId) continue;
    total++;
    if (!ultima || r.fechaRespuesta > ultima) ultima = r.fechaRespuesta;
  }
  const correos = db.data!.enviosCorreo.filter((e) => e.encuestaIds.includes(encuestaId)).length;
  return { total, ultima, correos };
}

// Contenido editable de una encuesta, ya validado y normalizado.
interface EncuestaEditable {
  titulo: string;
  descripcion?: string;
  preguntas: Pregunta[];
  secciones?: Seccion[];
}

// Lee un número opcional del cuerpo, descartando basura (NaN, null, Infinity).
function numeroOpcional(valor: unknown): number | undefined {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : undefined;
  if (typeof valor === 'string' && valor.trim()) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function textoOpcional(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const t = valor.trim();
  return t ? t : undefined;
}

// Normaliza la configuración extra de cada tipo (escalas, doble eje, archivos).
function limpiarConfiguracion(q: Record<string, unknown>): Partial<Pregunta> {
  const config: Partial<Pregunta> = {};

  const minimo = numeroOpcional(q.minimo);
  const maximo = numeroOpcional(q.maximo);
  if (minimo !== undefined) config.minimo = minimo;
  if (maximo !== undefined) config.maximo = maximo;

  if (typeof q.formato === 'string' && FORMATOS_NUMERO.includes(q.formato as never)) {
    config.formato = q.formato as Pregunta['formato'];
  }

  const puntos = numeroOpcional(q.puntos);
  if (puntos !== undefined) config.puntos = Math.max(2, Math.round(puntos));

  const ejeIzquierdo = textoOpcional(q.ejeIzquierdo);
  const ejeDerecho = textoOpcional(q.ejeDerecho);
  if (ejeIzquierdo) config.ejeIzquierdo = ejeIzquierdo;
  if (ejeDerecho) config.ejeDerecho = ejeDerecho;

  if (typeof q.otro === 'boolean') config.otro = q.otro;
  if (typeof q.variosArchivos === 'boolean') config.variosArchivos = q.variosArchivos;

  if (Array.isArray(q.extensiones)) {
    const extensiones = q.extensiones
      .map((e) => String(e).trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    if (extensiones.length > 0) config.extensiones = extensiones;
  }

  const tamanoMaximo = numeroOpcional(q.tamanoMaximo);
  if (tamanoMaximo !== undefined) config.tamanoMaximo = Math.max(1, tamanoMaximo);

  const placeholder = textoOpcional(q.placeholder);
  if (placeholder) config.placeholder = placeholder;

  return config;
}

// Normaliza las secciones (tramos) de la encuesta: sin título no cuentan, y
// cada una recibe un id único.
function limpiarSecciones(valor: unknown): Seccion[] {
  if (!Array.isArray(valor)) return [];

  const secciones: Seccion[] = [];
  const vistos = new Set<string>();

  for (const s of valor) {
    if (typeof s !== 'object' || s === null) continue;
    const raw = s as Record<string, unknown>;

    const titulo = typeof raw.titulo === 'string' ? raw.titulo.trim() : '';
    if (!titulo) continue;

    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
    if (vistos.has(id)) id = randomUUID();
    vistos.add(id);

    secciones.push({ id, titulo, descripcion: textoOpcional(raw.descripcion) });
  }

  return secciones;
}

// Valida y normaliza el cuerpo de una encuesta. Devuelve un mensaje de error
// o null si todo está bien.
function validarEncuesta(cuerpo: unknown): { error?: string; limpia?: EncuestaEditable } {
  if (typeof cuerpo !== 'object' || cuerpo === null) return { error: 'Cuerpo inválido' };
  const c = cuerpo as Record<string, unknown>;

  const titulo = typeof c.titulo === 'string' ? c.titulo.trim() : '';
  if (!titulo) return { error: 'El título no puede estar vacío' };

  const descripcion = textoOpcional(c.descripcion);

  if (!Array.isArray(c.preguntas) || c.preguntas.length === 0) {
    return { error: 'La encuesta necesita al menos una pregunta' };
  }

  const secciones = limpiarSecciones(c.secciones);
  const idsSeccion = new Set(secciones.map((s) => s.id));

  const preguntas: Pregunta[] = [];
  for (const [i, p] of c.preguntas.entries()) {
    if (typeof p !== 'object' || p === null) return { error: `La pregunta ${i + 1} es inválida` };
    const q = p as Record<string, unknown>;

    const texto = typeof q.texto === 'string' ? q.texto.trim() : '';
    if (!texto) return { error: `La pregunta ${i + 1} no tiene texto` };

    const tipo = q.tipo as Pregunta['tipo'];
    if (!TIPOS_VALIDOS.includes(tipo)) return { error: `La pregunta ${i + 1} tiene un tipo inválido` };

    const opciones = Array.isArray(q.opciones)
      ? q.opciones.map((o) => String(o).trim()).filter(Boolean)
      : undefined;
    const columnas = Array.isArray(q.columnas)
      ? q.columnas.map((o) => String(o).trim()).filter(Boolean)
      : undefined;

    if (usaOpciones(tipo) && (!opciones || opciones.length === 0)) {
      return { error: `La pregunta ${i + 1} (${tipo}) necesita al menos una opción` };
    }
    if (TIPOS_MATRIZ_REQUIEREN_COLUMNAS.includes(tipo) && (!columnas || columnas.length === 0)) {
      return { error: `La pregunta ${i + 1} (${tipo}) necesita al menos una columna` };
    }
    if (opciones) {
      const repetidas = opciones.filter(
        (o, j) => opciones.findIndex((x) => x.toLowerCase() === o.toLowerCase()) !== j
      );
      if (repetidas.length > 0) {
        return { error: `La pregunta ${i + 1} (${tipo}) tiene opciones repetidas: ${repetidas.join(', ')}` };
      }
    }
    if (tipo === 'escala_n' || tipo === 'matriz_escala') {
      const min = numeroOpcional(q.minimo) ?? 1;
      const max = numeroOpcional(q.maximo) ?? 10;
      if (max <= min) {
        return { error: `La pregunta ${i + 1} (${tipo}) necesita un máximo mayor que el mínimo` };
      }
    }

    preguntas.push({
      id: typeof q.id === 'string' && q.id ? q.id : `p-${randomUUID().slice(0, 8)}`,
      texto,
      tipo,
      // Una pregunta que apunta a una sección inexistente se queda sin sección.
      ...(typeof q.seccionId === 'string' && idsSeccion.has(q.seccionId)
        ? { seccionId: q.seccionId }
        : {}),
      ...(opciones && opciones.length > 0 ? { opciones } : {}),
      ...(columnas && columnas.length > 0 ? { columnas } : {}),
      ...(typeof q.obligatorio === 'boolean' ? { obligatorio: q.obligatorio } : {}),
      ...limpiarConfiguracion(q),
    });
  }

  return { limpia: { titulo, descripcion, preguntas, secciones } };
}

// GET /api/encuestas -> lista con la versión activa de cada encuesta
encuestasRouter.get('/', async (_req, res) => {
  await db.read();
  const lista = db.data!.encuestas
    .map((e) => {
      const v = versionActiva(e);
      if (!v) return null;
      const resumen = resumenDe(e.id);
      return aplanar(e.id, v, resumen.total, resumen.ultima, resumen.correos);
    })
    .filter(Boolean);
  res.json(lista);
});

// GET /api/encuestas/estadisticas -> resumen agregado del módulo de
// encuestas para el dashboard y la lista de proyectos.
// IMPORTANTE: va antes de `/:id`, porque Express matchearía "/estadisticas"
// como si fuera el id de una encuesta.
encuestasRouter.get('/estadisticas', async (_req, res) => {
  await db.read();
  res.json(calcularEstadisticas());
});

// GET /api/encuestas/:id/versiones -> historial completo
encuestasRouter.get('/:id/versiones', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

  const activas = new Set(db.data!.respuestas.map((r) => r.versionId));
  res.json(
    encuesta.versiones.map((v) => ({
      id: v.id,
      numero: v.numero,
      titulo: v.titulo,
      descripcion: v.descripcion,
      preguntas: v.preguntas,
      secciones: v.secciones ?? [],
      creadaEn: v.creadaEn,
      sellada: v.sellada || activas.has(v.id),
      totalRespuestas: db.data!.respuestas.filter((r) => r.versionId === v.id).length,
    }))
  );
});

// Aplana una versión concreta contando solo las respuestas de ESA versión.
function aplanarVersion(encuestaId: string, version: EncuestaVersion) {
  const propias = db.data!.respuestas.filter((r) => r.versionId === version.id);
  const ultima = propias.length
    ? propias.reduce((a, b) => (a.fechaRespuesta > b.fechaRespuesta ? a : b)).fechaRespuesta
    : null;
  return aplanar(encuestaId, version, propias.length, ultima, resumenDe(encuestaId).correos);
}

// GET /api/encuestas/:id/versiones/:versionId -> una versión concreta
encuestasRouter.get('/:id/versiones/:versionId', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });
  const version = encuesta.versiones.find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'Versión no encontrada' });
  res.json(aplanarVersion(encuesta.id, version));
});

// GET /api/encuestas/:id -> versión activa
encuestasRouter.get('/:id', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) {
    return res.status(404).json({ error: 'Encuesta no encontrada' });
  }
  const version = versionActiva(encuesta);
  if (!version) {
    return res.status(404).json({ error: 'La encuesta no tiene ninguna versión' });
  }
  const resumen = resumenDe(encuesta.id);
  res.json(aplanar(encuesta.id, version, resumen.total, resumen.ultima, resumen.correos));
});

// POST /api/encuestas -> crea una encuesta nueva con su versión 1
encuestasRouter.post('/', async (req, res) => {
  const { error, limpia } = validarEncuesta(req.body);
  if (error) return res.status(400).json({ error });

  await db.read();
  const ahora = new Date().toISOString();
  const id = `enc-${randomUUID().slice(0, 8)}`;

  db.data!.encuestas.push({
    id,
    creadaEn: ahora,
    versiones: [
      {
        id: randomUUID(),
        numero: 1,
        titulo: limpia!.titulo!,
        descripcion: limpia!.descripcion,
        preguntas: limpia!.preguntas!,
        secciones: limpia!.secciones,
        creadaEn: ahora,
        sellada: false,
      },
    ],
  });

  await db.write();
  res.status(201).json({ id });
});

// PUT /api/encuestas/:id/versiones/:versionId -> edita una versión NO sellada
encuestasRouter.put('/:id/versiones/:versionId', async (req, res) => {
  const { error, limpia } = validarEncuesta(req.body);
  if (error) return res.status(400).json({ error });

  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

  const version = encuesta.versiones.find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'Versión no encontrada' });

  // Ya tiene respuestas: sus datos dependen de estas preguntas exactas.
  // Editarla "en vivo" falsearía los resultados históricos.
  if (version.sellada) {
    return res.status(409).json({
      error: 'Esta versión ya tiene respuestas y no se puede editar.',
      versions: encuesta.versiones.map((v) => ({ id: v.id, numero: v.numero, sellada: v.sellada })),
    });
  }

  version.titulo = limpia!.titulo!;
  version.descripcion = limpia!.descripcion;
  version.preguntas = limpia!.preguntas!;
  version.secciones = limpia!.secciones;

  await db.write();
  res.json(aplanarVersion(encuesta.id, version));
});

// POST /api/encuestas/:id/versiones -> crea una versión nueva.
// Acepta el contenido editado; si no viene, copia la versión activa.
encuestasRouter.post('/:id/versiones', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

  const base = req.body?.desdeVersionId
    ? encuesta.versiones.find((v) => v.id === req.body.desdeVersionId)
    : versionActiva(encuesta);
  if (!base) return res.status(400).json({ error: 'No hay versión base para copiar' });

  // Si viene contenido editado lo validamos; si no, copiamos la base.
  const vieneEditable = req.body?.preguntas !== undefined || req.body?.titulo !== undefined;
  let contenido: EncuestaEditable = {
    titulo: base.titulo,
    descripcion: base.descripcion,
    preguntas: base.preguntas,
    secciones: base.secciones ?? [],
  };
  if (vieneEditable) {
    const { error, limpia } = validarEncuesta(req.body);
    if (error) return res.status(400).json({ error });
    contenido = limpia!;
  }

  const version: EncuestaVersion = {
    id: randomUUID(),
    numero: (encuesta.versiones[encuesta.versiones.length - 1]?.numero ?? 0) + 1,
    titulo: contenido.titulo!,
    descripcion: contenido.descripcion,
    preguntas: contenido.preguntas!,
    secciones: contenido.secciones,
    creadaEn: new Date().toISOString(),
    sellada: false,
  };
  encuesta.versiones.push(version);

  await db.write();
  res.status(201).json(aplanarVersion(encuesta.id, version));
});

// DELETE /api/encuestas/:id
encuestasRouter.delete('/:id', async (req, res) => {
  await db.read();
  const i = db.data!.encuestas.findIndex((e) => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Encuesta no encontrada' });
  db.data!.encuestas.splice(i, 1);
  await db.write();
  res.status(204).end();
});

// POST /api/encuestas/respuestas -> recibe una respuesta (online u offline-sincronizada)
encuestasRouter.post('/respuestas', async (req, res) => {
  const { id, encuestaId, versionId, respuestas, fechaRespuesta } = req.body ?? {};

  if (!encuestaId || !respuestas || !fechaRespuesta) {
    return res.status(400).json({ error: 'Faltan campos: encuestaId, respuestas, fechaRespuesta' });
  }

  await db.read();

  const encuesta = buscarEncuesta(encuestaId);
  if (!encuesta) {
    return res.status(404).json({ error: 'La encuesta referenciada no existe' });
  }

  // La respuesta se ata a la versión que el respondent vio. Si no la envía
  // (p. ej. un cliente viejo), cae a la activa.
  const version = versionId
    ? encuesta.versiones.find((v) => v.id === versionId)
    : versionActiva(encuesta);
  if (!version) {
    return res.status(404).json({ error: 'La versión de la encuesta no existe' });
  }

  // Idempotencia: si el front reintenta el envío (p. ej. Background Sync
  // disparó dos veces), no duplicamos la respuesta.
  const yaExiste = db.data!.respuestas.some((r) => r.id === id);
  if (yaExiste) {
    return res.status(200).json({ ok: true, duplicado: true });
  }

  db.data!.respuestas.push({
    id: id ?? randomUUID(),
    encuestaId,
    versionId: version.id,
    respuestas,
    fechaRespuesta,
    recibidoEn: new Date().toISOString(),
  });

  // Primera respuesta de esta versión: queda sellada para siempre.
  version.sellada = true;

  await db.write();
  res.status(201).json({ ok: true, versionId: version.id, versionNumero: version.numero });
});

// GET /api/encuestas/respuestas/todas -> ver todas las respuestas recibidas (uso interno/admin)
encuestasRouter.get('/respuestas/todas', async (_req, res) => {
  await db.read();
  res.json(db.data!.respuestas);
});

// POST /api/encuestas/enviar -> envía las encuestas seleccionadas por correo
encuestasRouter.post('/enviar', async (req, res) => {
  const { encuestaIds, destinatarios, mensaje } = req.body ?? {};

  if (!Array.isArray(encuestaIds) || encuestaIds.length === 0) {
    return res.status(400).json({ error: 'Selecciona al menos una encuesta' });
  }
  if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
    return res.status(400).json({ error: 'Agrega al menos un destinatario' });
  }

  const correos = [...new Set(destinatarios.map((d) => String(d).trim()).filter(Boolean))];
  if (correos.length === 0) {
    return res.status(400).json({ error: 'No se encontraron correos válidos' });
  }
  const invalidos = correos.filter((c) => !REGEX_EMAIL.test(c));
  if (invalidos.length > 0) {
    return res.status(400).json({ error: `Correos inválidos: ${invalidos.join(', ')}` });
  }

  await db.read();

  // Solo se pueden enviar encuestas que existen en el servidor: el link del
  // correo apunta a /e/:id, que se sirve desde aquí.
  const encuestas = encuestaIds
    .map((eid: string): EncuestaParaCorreo | null => {
      const enc = buscarEncuesta(eid);
      const v = versionActiva(enc);
      return v ? { id: eid, titulo: v.titulo, descripcion: v.descripcion } : null;
    })
    .filter((e): e is EncuestaParaCorreo => e !== null);
  if (encuestas.length !== encuestaIds.length) {
    return res.status(404).json({ error: 'Una o más encuestas seleccionadas no existen' });
  }

  const urlBase = urlBasePublica();
  let proveedor: string = 'simulado';
  const enviados: string[] = [];

  try {
    for (const correo of correos) {
      const contenido = construirCorreoEncuestas({ encuestas, mensaje, urlBase });
      proveedor = await enviarCorreo({
        para: correo,
        asunto: contenido.asunto,
        html: contenido.html,
        texto: contenido.texto,
      });

      db.data!.enviosCorreo.push({
        id: randomUUID(),
        destinatario: correo,
        encuestaIds: encuestas.map((e) => e.id),
        asunto: contenido.asunto,
        proveedor,
        enviadoEn: new Date().toISOString(),
      });
      enviados.push(correo);
    }
  } catch (err) {
    const mensajeError = err instanceof Error ? err.message : String(err);
    await db.write();
    return res.status(502).json({
      ok: false,
      error: `Falló el envío a uno o más correos: ${mensajeError}`,
      enviados,
    });
  }

  await db.write();
  res.status(201).json({ ok: true, enviados: enviados.length, proveedor });
});

// GET /api/encuestas/:id/respuestas -> respuestas de una encuesta
encuestasRouter.get('/:id/respuestas', async (req, res) => {
  await db.read();
  const respuestas = db.data!.respuestas.filter((r) => r.encuestaId === req.params.id);
  res.json(respuestas);
});
