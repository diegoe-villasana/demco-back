import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  db,
  buscarEncuesta,
  versionActiva,
  type FormatoNumero,
  type Pregunta,
  type Seccion,
  type ValorRespuesta,
} from '../db.js';
import { escapeHtml } from '../mailer.js';
import {
  FILAS_MATRIZ_DEFAULT,
  asignar,
  claveComentario,
  claveFila,
  esInformativa,
  rangoEscala,
  textos,
  usaColumnas,
  valoresNumericos,
} from '../tipos.js';

export const publicoRouter = Router();

const BORDES = 'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;font-family:inherit;font-size:14px;';
const ETIQUETA =
  '<span style="display:flex;align-items:center;gap:8px;margin:4px 0;color:#334155;font-size:14px;">';

function paso(formato: FormatoNumero | undefined): number | 'any' {
  return formato === 'entero' || !formato ? 1 : 'any';
}

function columnasDe(pregunta: Pregunta): string[] {
  if (!usaColumnas(pregunta.tipo)) return [];
  const columnas = (pregunta.columnas ?? []).filter(Boolean);
  return columnas.length > 0 ? columnas : FILAS_MATRIZ_DEFAULT;
}

function encabezado(indice: number, pregunta: Pregunta): string {
  const texto = escapeHtml(pregunta.texto);
  const obligatorio = pregunta.obligatorio ? ' <span style="color:#dc2626;">*</span>' : '';
  return `<p style="margin:0 0 10px;font-weight:600;color:#1f2421;font-size:15px;">${indice + 1}. ${texto}${obligatorio}</p>`;
}

// Una celda de matriz: una sola respuesta por fila entre las columnas.
function renderMatriz(pregunta: Pregunta, columnas: string[]): string {
  const celdas = (pregunta.opciones ?? [])
    .map((fila) => {
      const nombre = escapeHtml(claveFila(pregunta.id, fila));
      const radios = columnas
        .map(
          (columna) => `
            <td style="text-align:center;padding:6px 8px;border-bottom:1px solid #eef2f7;">
              <input type="radio" name="${nombre}" value="${escapeHtml(columna)}"${pregunta.obligatorio ? ' required' : ''}>
            </td>`
        )
        .join('');
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;color:#334155;font-size:13px;width:40%;">${escapeHtml(fila)}</td>
          ${radios}
        </tr>`;
    })
    .join('');

  return `
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;min-width:480px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:600;font-size:12px;"></th>
            ${columnas.map((columna) => `<th style="padding:6px 8px;color:#64748b;font-weight:600;font-size:12px;text-align:center;">${escapeHtml(columna)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${celdas}</tbody>
      </table>
    </div>`;
}

function renderPregunta(pregunta: Pregunta, indice: number): string {
  const texto = encabezado(indice, pregunta);
  const nombre = escapeHtml(pregunta.id);
  const opciones = (pregunta.opciones ?? []).filter(Boolean);
  const columnas = columnasDe(pregunta);
  const { min, max } = rangoEscala(pregunta);
  const req = pregunta.obligatorio ? ' required' : '';

  if (esInformativa(pregunta.tipo)) {
    return `<p style="margin:0;color:#475569;font-size:14px;">${escapeHtml(pregunta.texto)}</p>`;
  }

  switch (pregunta.tipo) {
    case 'texto':
    case 'texto_linea':
    case 'texto_parrafos': {
      const placeholder = pregunta.placeholder ? ` placeholder="${escapeHtml(pregunta.placeholder)}"` : '';
      if (pregunta.tipo === 'texto_linea') {
        return `${texto}<input type="text" name="${nombre}" style="${BORDES}"${placeholder}${req}>`;
      }
      const filas = pregunta.tipo === 'texto_parrafos' ? 8 : 3;
      return `${texto}<textarea name="${nombre}" rows="${filas}" style="${BORDES}"${placeholder}${req}></textarea>`;
    }

    case 'textos_multiples':
      return `${texto}${opciones
        .map(
          (fila) => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span style="color:#334155;font-size:13px;width:38%;">${escapeHtml(fila)}</span>
          <input type="text" name="${escapeHtml(claveFila(pregunta.id, fila))}" style="${BORDES}"${req}>
        </div>`
        )
        .join('')}`;

    case 'numero':
      return `${texto}<input type="number" name="${nombre}" step="${paso(pregunta.formato)}"${pregunta.minimo !== undefined ? ` min="${pregunta.minimo}"` : ''}${pregunta.maximo !== undefined ? ` max="${pregunta.maximo}"` : ''} style="${BORDES}max-width:280px;"${req}>`;

    case 'numero_multiple':
      return `${texto}${opciones
        .map(
          (fila) => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span style="color:#334155;font-size:13px;width:38%;">${escapeHtml(fila)}</span>
          <input type="number" name="${escapeHtml(claveFila(pregunta.id, fila))}" step="${paso(pregunta.formato)}" style="${BORDES}max-width:220px;"${req}>
        </div>`
        )
        .join('')}`;

    case 'fecha':
      return `${texto}<input type="datetime-local" name="${nombre}" style="${BORDES}max-width:280px;"${req}>`;

    case 'desplegable':
      return `${texto}
        <select name="${nombre}" style="${BORDES}"${req}>
          <option value="">Elige una opción…</option>
          ${opciones.map((opcion) => `<option value="${escapeHtml(opcion)}">${escapeHtml(opcion)}</option>`).join('')}
        </select>`;

    case 'opcion_unica':
    case 'opcion_unica_comentario':
    case 'genero':
    case 'si_no':
    case 'idioma': {
      const radios = opciones
        .map(
          (opcion) => `${ETIQUETA}
          <input type="radio" name="${nombre}" value="${escapeHtml(opcion)}"${req}>
          <span>${escapeHtml(opcion)}</span>
        </label>`
        )
        .join('');

      if (pregunta.tipo !== 'opcion_unica_comentario') return `${texto}${radios}`;

      const comentario = pregunta.placeholder ?? 'Escribe tu comentario';
      return `${texto}${radios}
        <input type="text" name="${escapeHtml(claveComentario(pregunta.id))}" placeholder="${escapeHtml(comentario)}" style="${BORDES}margin-top:8px;">`;
    }

    case 'escala':
    case 'escala_n': {
      const valores: number[] = [];
      for (let v = min; v <= max; v++) valores.push(v);
      return `${texto}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${valores
            .map(
              (valor) => `
            <label style="display:flex;flex-direction:column;align-items:center;gap:4px;color:#475569;font-size:13px;">
              <input type="radio" name="${nombre}" value="${valor}"${req}>
              <span>${valor}</span>
            </label>`
            )
            .join('')}
        </div>`;
    }

    case 'opcion_multiple':
    case 'opcion_multiple_comentario': {
      const conComentario = pregunta.tipo === 'opcion_multiple_comentario';
      const casillas = opciones
        .map((opcion) => {
          const comentario = conComentario
            ? `<input type="text" name="${escapeHtml(claveComentario(pregunta.id, opcion))}" placeholder="${escapeHtml(pregunta.placeholder ?? 'Comentario')}" style="${BORDES}margin:4px 0 4px 24px;max-width:420px;">`
            : '';
          return `${ETIQUETA}
          <input type="checkbox" name="${nombre}" value="${escapeHtml(opcion)}">
          <span>${escapeHtml(opcion)}</span>
        </label>${comentario}`;
        })
        .join('');

      if (!pregunta.otro) return `${texto}${casillas}`;

      // El "Otro" se captura como texto libre; el backend lo junta a la lista.
      return `${texto}${casillas}
        <input type="text" name="${escapeHtml(claveComentario(pregunta.id, 'Otro'))}" placeholder="Otro" style="${BORDES}margin-top:8px;max-width:420px;">`;
    }

    case 'ranking': {
      // Sin JS: cada elemento declara en qué posición quedó, y el backend
      // reordena la lista a partir de esas posiciones.
      return `${texto}
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${opciones
            .map((opcion, i) => {
              const posiciones: number[] = [];
              for (let p = 1; p <= opciones.length; p++) posiciones.push(p);
              return `
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="color:#334155;font-size:14px;flex:1;">${escapeHtml(opcion)}</span>
              <select name="${escapeHtml(`${pregunta.id}-pos-${i}`)}" style="${BORDES}max-width:120px;">
                ${posiciones.map((p) => `<option value="${p}">${p}</option>`).join('')}
              </select>
            </div>`;
            })
            .join('')}
        </div>`;
    }

    case 'archivo': {
      // El formulario público es urlencoded: no se puede subir el binario sin
      // almacenamiento. Se captura el nombre del archivo o una liga.
      return `${texto}
        <input type="text" name="${nombre}" placeholder="Nombre del archivo o liga" style="${BORDES}max-width:420px;"${req}>
        ${pregunta.extensiones?.length ? `<p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">Formatos: ${escapeHtml(pregunta.extensiones.join(', '))} · máx. ${pregunta.tamanoMaximo ?? 10} MB</p>` : ''}`;
    }

    case 'matriz':
    case 'matriz_aumentar':
    case 'matriz_sino':
      return `${texto}${renderMatriz(pregunta, columnas.length > 0 ? columnas : FILAS_MATRIZ_DEFAULT)}`;

    case 'matriz_escala': {
      const valores: string[] = [];
      for (let v = min; v <= max; v++) valores.push(String(v));
      return `${texto}${renderMatriz(pregunta, valores)}`;
    }

    case 'matriz_texto':
      return `${texto}${opciones
        .map(
          (fila) => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span style="color:#334155;font-size:13px;width:38%;">${escapeHtml(fila)}</span>
          <input type="text" name="${escapeHtml(claveFila(pregunta.id, fila))}" style="${BORDES}"${req}>
        </div>`
        )
        .join('')}`;

    case 'matriz_numero':
      return `${texto}${opciones
        .map(
          (fila) => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span style="color:#334155;font-size:13px;width:38%;">${escapeHtml(fila)}</span>
          <input type="number" name="${escapeHtml(claveFila(pregunta.id, fila))}" step="${paso(pregunta.formato)}" style="${BORDES}max-width:220px;"${req}>
        </div>`
        )
        .join('')}`;

    case 'matriz_columnas':
      return `${texto}
        <p style="margin:0 0 8px;color:#64748b;font-size:13px;">Opciones: ${escapeHtml(opciones.join(' · '))}</p>
        ${(pregunta.columnas ?? []).map((columna) => {
          const nombreColumna = escapeHtml(claveFila(pregunta.id, columna));
          return `
          <div style="margin:6px 0;">
            <p style="margin:0 0 4px;color:#334155;font-size:14px;">${escapeHtml(columna)}</p>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
              ${opciones
                .map(
                  (opcion) => `${ETIQUETA}
                <input type="radio" name="${nombreColumna}" value="${escapeHtml(opcion)}"${req}>
                <span>${escapeHtml(opcion)}</span>
              </label>`
                )
                .join('')}
            </div>
          </div>`;
        }).join('')}`;

    case 'matriz_doble_eje': {
      const puntos = Math.max(2, pregunta.puntos ?? 5);
      const izq = pregunta.ejeIzquierdo ?? 'Izquierda';
      const der = pregunta.ejeDerecho ?? 'Derecha';
      return `${texto}
        <div style="display:flex;flex-direction:column;gap:14px;">
          ${opciones
            .map((fila) => {
              const escalas = (['izq', 'der'] as const)
                .map((lado) => {
                  const nombreLado = escapeHtml(`${claveFila(pregunta.id, fila)}-${lado}`);
                  const etiqueta = lado === 'izq' ? izq : der;
                  const puntosHtml: number[] = [];
                  for (let p = 1; p <= puntos; p++) puntosHtml.push(p);
                  return `
                  <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                    <span style="color:#94a3b8;font-size:12px;width:96px;text-align:right;">${escapeHtml(etiqueta)}</span>
                    ${puntosHtml
                      .map(
                        (p) => `<label style="display:flex;flex-direction:column;align-items:center;gap:2px;color:#475569;font-size:12px;">
                        <input type="radio" name="${nombreLado}" value="${p}"${req}>
                        <span>${p}</span>
                      </label>`
                      )
                      .join('')}
                  </div>`;
                })
                .join('');
              return `
              <div>
                <p style="margin:0;color:#334155;font-size:14px;">${escapeHtml(fila)}</p>
                ${escalas}
              </div>`;
            })
            .join('')}
        </div>`;
    }

    default:
      return texto;
  }
}

// Agrupa las preguntas por sección: el orden de las secciones manda y, dentro
// de cada una, se respeta el orden original de las preguntas. Las que no
// pertenecen a ninguna sección quedan al final, sin encabezado.
function agruparPorSeccion(
  preguntas: Pregunta[],
  secciones: Seccion[] = []
): Array<{ seccion: Seccion | null; preguntas: Pregunta[] }> {
  const grupos: Array<{ seccion: Seccion | null; preguntas: Pregunta[] }> = secciones.map(
    (seccion) => ({ seccion, preguntas: [] })
  );
  const porId = new Map(grupos.map((g) => [g.seccion!.id, g]));

  const sueltas: Pregunta[] = [];
  for (const pregunta of preguntas) {
    const grupo = pregunta.seccionId ? porId.get(pregunta.seccionId) : undefined;
    if (grupo) {
      grupo.preguntas.push(pregunta);
    } else {
      sueltas.push(pregunta);
    }
  }

  if (sueltas.length > 0) grupos.push({ seccion: null, preguntas: sueltas });
  return grupos;
}

function encabezadoSeccion(seccion: Seccion): string {
  const descripcion = seccion.descripcion
    ? `<p style="margin:4px 0 0;color:#475569;font-size:13px;">${escapeHtml(seccion.descripcion)}</p>`
    : '';
  return `
    <div style="margin:0 0 14px;padding:12px 16px;border-left:4px solid #008751;background:#f0fdf6;border-radius:0 6px 6px 0;">
      <p style="margin:0;color:#1f2421;font-size:17px;font-weight:700;">${escapeHtml(seccion.titulo)}</p>
      ${descripcion}
    </div>`;
}

function renderPagina(contenido: string): string {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Encuesta DEMCO</title>
      <style>
        body { margin:0; font-family:Arial, Helvetica, sans-serif; background:#f1f5f9; color:#1f2421; }
        .bar { background:#008751; padding:18px 24px; color:#fff; }
        .bar h1 { margin:0; font-size:20px; }
        .contenedor { max-width:640px; margin:24px auto; padding:0 16px; }
        .tarjeta { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:24px; }
        .pregunta { padding:16px; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:14px; background:#fff; }
        button { background:#008751; color:#fff; border:0; border-radius:8px; padding:12px 24px; font-size:15px; font-weight:600; cursor:pointer; width:100%; }
        button:hover { background:#046a3e; }
        .pie { text-align:center; color:#94a3b8; font-size:12px; margin:16px 0 32px; }
      </style>
    </head>
    <body>
      <div class="bar"><h1>DEMCO</h1></div>
      <div class="contenedor">${contenido}</div>
      <p class="pie">DEMCO — Encuesta de satisfacción</p>
    </body>
    </html>`;
}

function paginaGracias(): string {
  return renderPagina(`<div class="tarjeta" style="text-align:center;padding:40px;">
    <div style="width:64px;height:64px;margin:0 auto 16px;background:#008751;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;">&#10003;</div>
    <h2 style="margin:0 0 8px;">¡Gracias por participar!</h2>
    <p style="color:#475569;margin:0;">Tu respuesta se guardó correctamente.</p>
  </div>`);
}

// GET /e/:id -> formulario público para responder la encuesta
// (/e/:id?ok=1 -> página de gracias tras enviar)
publicoRouter.get('/:id', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  const version = versionActiva(encuesta);

  if (!encuesta || !version) {
    res.status(404).send(
      renderPagina(`<div class="tarjeta" style="text-align:center;padding:40px;">
        <h2 style="margin:0 0 8px;">Encuesta no encontrada</h2>
        <p style="color:#475569;margin:0;">El enlace es inválido o la encuesta fue removida.</p>
      </div>`)
    );
    return;
  }

  if (req.query.ok === '1') {
    res.send(paginaGracias());
    return;
  }

  // Los bloques de texto no son preguntas: no llevan la tarjeta numerada.
  // La numeración es global (como en la app) y sigue el orden en que se
  // muestran las preguntas, aunque el contenido se agrupe por secciones.
  const grupos = agruparPorSeccion(version.preguntas, version.secciones)
    // Las secciones vacías no se muestran: al respondent no le aportan nada.
    .filter((grupo) => grupo.preguntas.length > 0);

  let indice = 0;
  const preguntas = grupos
    .map((grupo) => {
      const html = grupo.preguntas
        .map((pregunta) => {
          if (esInformativa(pregunta.tipo)) {
            return `<div class="pregunta">${renderPregunta(pregunta, 0)}</div>`;
          }
          const numero = indice;
          indice++;
          return `<div class="pregunta">${renderPregunta(pregunta, numero)}</div>`;
        })
        .join('');

      const titulo = grupo.seccion ? encabezadoSeccion(grupo.seccion) : '';
      return `${titulo}${html}`;
    })
    .join('');

  const respondibles = version.preguntas.filter((p) => !esInformativa(p.tipo));

  const contenido = `
    <div class="tarjeta" style="margin-bottom:14px;">
      <h2 style="margin:0 0 6px;">${escapeHtml(version.titulo)}</h2>
      ${version.descripcion ? `<p style="color:#475569;margin:0;">${escapeHtml(version.descripcion)}</p>` : ''}
    </div>
    <form method="post" action="/e/${encodeURIComponent(encuesta.id)}">
      <input type="hidden" name="__versionId" value="${escapeHtml(version.id)}">
      ${preguntas}
      ${
        respondibles.length > 0
          ? '<div class="tarjeta" style="margin-top:4px;"><button type="submit">Enviar respuestas</button></div>'
          : ''
      }
    </form>`;

  res.send(renderPagina(contenido));
});

// Lee el cuerpo urlencoded de una pregunta y devuelve las claves que se
// guardan. Se usan exactamente los mismos nombres que la app (valor simple en
// `id`, una clave por fila en `id-fila`, listas en `id`), para que los mismos
// resultados se puedan leer igual desde el correo o desde el navegador.
function leerRespuestas(
  pregunta: Pregunta,
  body: Record<string, unknown>
): Record<string, ValorRespuesta> {
  const out: Record<string, ValorRespuesta> = {};
  const { id, tipo } = pregunta;
  const opciones = (pregunta.opciones ?? []).filter(Boolean);
  const bruto = (clave: string) => body[clave];

  const putTexto = (clave: string) => {
    const v = bruto(clave);
    asignar(out, clave, typeof v === 'string' && v.trim() ? v : undefined);
  };

  const putNumero = (clave: string) => {
    asignar(out, clave, valoresNumericos(bruto(clave))[0]);
  };

  switch (tipo) {
    case 'mostrar_texto':
      break;

    case 'texto':
    case 'texto_linea':
    case 'texto_parrafos':
    case 'fecha':
    case 'desplegable':
    case 'opcion_unica':
    case 'genero':
    case 'si_no':
    case 'idioma':
      putTexto(id);
      break;

    case 'numero':
    case 'escala':
    case 'escala_n':
      putNumero(id);
      break;

    case 'opcion_unica_comentario':
      putTexto(id);
      putTexto(claveComentario(id));
      break;

    case 'opcion_multiple':
    case 'opcion_multiple_comentario': {
      const marcados = textos(bruto(id));
      if (pregunta.otro) {
        const otro = bruto(claveComentario(id, 'Otro'));
        if (typeof otro === 'string' && otro.trim()) marcados.push(`Otro: ${otro.trim()}`);
      }
      asignar(out, id, marcados);

      if (tipo === 'opcion_multiple_comentario') {
        for (const opcion of opciones) putTexto(claveComentario(id, opcion));
      }
      break;
    }

    case 'ranking': {
      // Cada elemento declara en qué posición quedó; se reordena la lista.
      const conPosicion = opciones
        .map((opcion, i) => ({ opcion, pos: valoresNumericos(bruto(`${id}-pos-${i}`))[0] ?? i + 1 }))
        .sort((a, b) => a.pos - b.pos);
      const algunoRespondido = conPosicion.some((_, i) => bruto(`${id}-pos-${i}`) !== undefined);
      asignar(out, id, algunoRespondido ? conPosicion.map((c) => c.opcion) : undefined);
      break;
    }

    case 'archivo': {
      const nombres = textos(bruto(id));
      asignar(out, id, nombres);
      break;
    }

    case 'textos_multiples':
    case 'matriz_texto':
      for (const fila of opciones) putTexto(claveFila(id, fila));
      break;

    case 'numero_multiple':
    case 'matriz_numero':
    case 'matriz_escala':
      for (const fila of opciones) putNumero(claveFila(id, fila));
      break;

    case 'matriz':
    case 'matriz_aumentar':
    case 'matriz_sino':
      for (const fila of opciones) putTexto(claveFila(id, fila));
      break;

    case 'matriz_columnas':
      for (const columna of (pregunta.columnas ?? []).filter(Boolean)) putTexto(claveFila(id, columna));
      break;

    case 'matriz_doble_eje':
      for (const fila of opciones) {
        putNumero(`${claveFila(id, fila)}-izq`);
        putNumero(`${claveFila(id, fila)}-der`);
      }
      break;

    default:
      putTexto(id);
  }

  return out;
}

publicoRouter.post('/:id', async (req, res) => {
  await db.read();
  const encuesta = buscarEncuesta(req.params.id);
  if (!encuesta) {
    res.status(404).send(renderPagina('<p>Encuesta no encontrada.</p>'));
    return;
  }

  // La respuesta se ata a la versión que se rindió al mostrar el formulario.
  // Si se publica una versión nueva entre que el respondent abre y envía, su
  // respuesta igual queda contra las preguntas que realmente vio.
  const versionSolicitada =
    encuesta.versiones.find((v) => v.id === req.body?.__versionId) ?? versionActiva(encuesta);
  if (!versionSolicitada) {
    res.status(404).send(renderPagina('<p>La encuesta no tiene versiones.</p>'));
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const respuestas: Record<string, ValorRespuesta> = {};

  for (const pregunta of versionSolicitada.preguntas) {
    Object.assign(respuestas, leerRespuestas(pregunta, body));
  }

  db.data!.respuestas.push({
    id: randomUUID(),
    encuestaId: encuesta.id,
    versionId: versionSolicitada.id,
    respuestas,
    fechaRespuesta: new Date().toISOString(),
    recibidoEn: new Date().toISOString(),
  });

  // Primera respuesta de esta versión: queda sellada y ya no se puede editar.
  versionSolicitada.sellada = true;

  await db.write();

  res.redirect(303, `/e/${encodeURIComponent(encuesta.id)}?ok=1`);
});
