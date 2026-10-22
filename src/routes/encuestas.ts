import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { routerSeguro } from '../async-handler.js';
import {
  versionActiva,
  type EncuestaVersion,
  type Pregunta,
  type RespuestaEncuesta,
  type Seccion,
} from '../db.js';
import { repo } from '../repositorio.js';
import { calcularEstadisticas } from '../estadisticas.js';
import { enviarCorreo, construirCorreoEncuestas, type EncuestaParaCorreo } from '../mailer.js';
import {
  FORMATOS_NUMERO,
  TIPOS_MATRIZ_REQUIEREN_COLUMNAS,
  TIPOS_VALIDOS,
  usaOpciones,
} from '../tipos.js';

export const encuestasRouter = routerSeguro(Router());

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
function resumenDe(
  resumen: Map<string, { total: number; ultima: string | null; correos: number }>,
  encuestaId: string
): { total: number; ultima: string | null; correos: number } {
  return resumen.get(encuestaId) ?? { total: 0, ultima: null, correos: 0 };
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
  const [encuestas, resumen] = await Promise.all([
    repo.listarEncuestas(),
    repo.resumenPorEncuesta(),
  ]);

  const lista = encuestas
    .map((e) => {
      const v = versionActiva(e);
      if (!v) return null;
      const r = resumenDe(resumen, e.id);
      return aplanar(e.id, v, r.total, r.ultima, r.correos);
    })
    .filter(Boolean);
  res.json(lista);
});

// GET /api/encuestas/estadisticas -> resumen agregado del módulo de
// encuestas para el dashboard y la lista de proyectos.
// IMPORTANTE: va antes de `/:id`, porque Express matchearía "/estadisticas"
// como si fuera el id de una encuesta.
encuestasRouter.get('/estadisticas', async (_req, res) => {
  const [encuestas, respuestas, envios] = await Promise.all([
    repo.listarEncuestas(),
    repo.listarRespuestas(),
    repo.listarEnvios(),
  ]);
  res.json(calcularEstadisticas({ encuestas, respuestas, envios }));
});

// GET /api/encuestas/:id/versiones -> historial completo
encuestasRouter.get('/:id/versiones', async (req, res) => {
  const [encuesta, conteo] = await Promise.all([
    repo.obtenerEncuesta(req.params.id),
    repo.conteoRespuestasPorVersion(),
  ]);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

  res.json(
    encuesta.versiones.map((v) => ({
      id: v.id,
      numero: v.numero,
      titulo: v.titulo,
      descripcion: v.descripcion,
      preguntas: v.preguntas,
      secciones: v.secciones ?? [],
      creadaEn: v.creadaEn,
      sellada: v.sellada || (conteo.get(v.id) ?? 0) > 0,
      totalRespuestas: conteo.get(v.id) ?? 0,
    }))
  );
});

// Aplana una versión concreta contando solo las respuestas de ESA versión.
function aplanarVersion(
  encuestaId: string,
  version: EncuestaVersion,
  propias: RespuestaEncuesta[],
  correos: number
) {
  const ultima = propias.length
    ? propias.reduce((a, b) => (a.fechaRespuesta > b.fechaRespuesta ? a : b)).fechaRespuesta
    : null;
  return aplanar(encuestaId, version, propias.length, ultima, correos);
}

// GET /api/encuestas/:id/versiones/:versionId -> una versión concreta
encuestasRouter.get('/:id/versiones/:versionId', async (req, res) => {
  const [encuesta, respuestas, resumen] = await Promise.all([
    repo.obtenerEncuesta(req.params.id),
    repo.listarRespuestas(req.params.id),
    repo.resumenPorEncuesta(),
  ]);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });
  const version = encuesta.versiones.find((v) => v.id === req.params.versionId);
  if (!version) return res.status(404).json({ error: 'Versión no encontrada' });

  const propias = respuestas.filter((r) => r.versionId === version.id);
  res.json(aplanarVersion(encuesta.id, version, propias, resumenDe(resumen, encuesta.id).correos));
});

// GET /api/encuestas/:id -> versión activa
encuestasRouter.get('/:id', async (req, res) => {
  const [encuesta, resumen] = await Promise.all([
    repo.obtenerEncuesta(req.params.id),
    repo.resumenPorEncuesta(),
  ]);
  if (!encuesta) {
    return res.status(404).json({ error: 'Encuesta no encontrada' });
  }
  const version = versionActiva(encuesta);
  if (!version) {
    return res.status(404).json({ error: 'La encuesta no tiene ninguna versión' });
  }
  const r = resumenDe(resumen, encuesta.id);
  res.json(aplanar(encuesta.id, version, r.total, r.ultima, r.correos));
});

// POST /api/encuestas -> crea una encuesta nueva con su versión 1
encuestasRouter.post('/', async (req, res) => {
  const { error, limpia } = validarEncuesta(req.body);
  if (error) return res.status(400).json({ error });

  const ahora = new Date().toISOString();
  const id = `enc-${randomUUID().slice(0, 8)}`;

  await repo.crearEncuesta({
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

  res.status(201).json({ id });
});

// PUT /api/encuestas/:id/versiones/:versionId -> edita una versión NO sellada
encuestasRouter.put('/:id/versiones/:versionId', async (req, res) => {
  const { error, limpia } = validarEncuesta(req.body);
  if (error) return res.status(400).json({ error });

  const encuesta = await repo.obtenerEncuesta(req.params.id);
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

  await repo.actualizarVersion(encuesta.id, version);

  const [propias, resumen] = await Promise.all([
    repo.listarRespuestas(encuesta.id),
    repo.resumenPorEncuesta(),
  ]);
  res.json(
    aplanarVersion(
      encuesta.id,
      version,
      propias.filter((r) => r.versionId === version.id),
      resumenDe(resumen, encuesta.id).correos
    )
  );
});

// POST /api/encuestas/:id/versiones -> crea una versión nueva.
// Acepta el contenido editado; si no viene, copia la versión activa.
encuestasRouter.post('/:id/versiones', async (req, res) => {
  const encuesta = await repo.obtenerEncuesta(req.params.id);
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

  await repo.crearVersion(encuesta.id, version);

  const [propias, resumen] = await Promise.all([
    repo.listarRespuestas(encuesta.id),
    repo.resumenPorEncuesta(),
  ]);
  res.status(201).json(
    aplanarVersion(
      encuesta.id,
      version,
      propias.filter((r) => r.versionId === version.id),
      resumenDe(resumen, encuesta.id).correos
    )
  );
});

// DELETE /api/encuestas/:id
encuestasRouter.delete('/:id', async (req, res) => {
  const encuesta = await repo.obtenerEncuesta(req.params.id);
  if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

  await repo.borrarEncuesta(encuesta.id);
  res.status(204).end();
});

// POST /api/encuestas/respuestas -> recibe una respuesta (online u offline-sincronizada)
encuestasRouter.post('/respuestas', async (req, res) => {
  const { id, encuestaId, versionId, respuestas, fechaRespuesta } = req.body ?? {};

  if (!encuestaId || !respuestas || !fechaRespuesta) {
    return res.status(400).json({ error: 'Faltan campos: encuestaId, respuestas, fechaRespuesta' });
  }

  const encuesta = await repo.obtenerEncuesta(encuestaId);
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
  // El id lo genera el cliente, pero la columna es uuid: si llega con otro
  // formato se genera uno del servidor en vez de fallar la escritura.
  const idRespuesta = typeof id === 'string' && REGEX_UUID.test(id) ? id : randomUUID();
  const existentes = await repo.listarRespuestas(encuestaId);
  if (existentes.some((r) => r.id === idRespuesta)) {
    return res.status(200).json({ ok: true, duplicado: true });
  }

  await repo.guardarRespuesta({
    id: idRespuesta,
    encuestaId,
    versionId: version.id,
    respuestas,
    fechaRespuesta,
    recibidoEn: new Date().toISOString(),
  });

  // Primera respuesta de esta versión: queda sellada para siempre.
  await repo.sellarVersion(version.id);

  res.status(201).json({ ok: true, versionId: version.id, versionNumero: version.numero });
});

// GET /api/encuestas/respuestas/todas -> ver todas las respuestas recibidas (uso interno/admin)
encuestasRouter.get('/respuestas/todas', async (_req, res) => {
  res.json(await repo.listarRespuestas());
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

  // Solo se pueden enviar encuestas que existen en el servidor: el link del
  // correo apunta a /e/:id, que se sirve desde aquí.
  const surveys = await repo.listarEncuestas();
  const porId = new Map(surveys.map((e) => [e.id, e]));
  const encuestas = encuestaIds
    .map((eid: string): EncuestaParaCorreo | null => {
      const enc = porId.get(eid);
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

      await repo.registrarEnvio({
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
    return res.status(502).json({
      ok: false,
      error: `Falló el envío a uno o más correos: ${mensajeError}`,
      enviados,
    });
  }

  res.status(201).json({ ok: true, enviados: enviados.length, proveedor });
});

// GET /api/encuestas/:id/respuestas -> respuestas de una encuesta
encuestasRouter.get('/:id/respuestas', async (req, res) => {
  res.json(await repo.listarRespuestas(req.params.id));
});
