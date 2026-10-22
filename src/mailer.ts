import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// Vista mínima que necesita el correo. A propósito NO depende de `Encuesta`:
// el backend ahora guarda versiones, y la versión activa se aplana antes de
// llegar aquí, así que atamos el contrato a lo que realmente usamos.
export interface EncuestaParaCorreo {
  id: string;
  titulo: string;
  descripcion?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ProveedorCorreo = 'resend' | 'brevo' | 'simulado';

interface EnviarCorreoInput {
  para: string;
  asunto: string;
  html: string;
  texto: string;
}

export interface EnviosCorreoConfig {
  proveedor: ProveedorCorreo;
  remiteEmail: string;
  remiteNombre: string;
}

export function leerConfiguracionCorreo(): EnviosCorreoConfig {
  const resendKey = process.env.RESEND_API_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  const forzado = process.env.MAIL_PROVIDER;

  const proveedor: ProveedorCorreo =
    forzado === 'resend' || forzado === 'brevo' || forzado === 'simulado'
      ? forzado
      : resendKey
        ? 'resend'
        : brevoKey
          ? 'brevo'
          : 'simulado';

  return {
    proveedor,
    remiteEmail: process.env.REMITE_EMAIL ?? 'encuestas@demco.mx',
    remiteNombre: process.env.REMITE_NOMBRE ?? 'DEMCO',
  };
}

const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => HTML_ESC[c] ?? c);
}

// Construye el cuerpo del correo que se manda a un destinatario con las
// encuestas seleccionadas y su link público para responder.
export function construirCorreoEncuestas(input: {
  encuestas: EncuestaParaCorreo[];
  mensaje?: string;
  urlBase: string;
}): { asunto: string; html: string; texto: string } {
  const { encuestas, mensaje, urlBase } = input;

  const asunto = encuestas.length === 1
    ? `DEMCO te invita a responder: ${encuestas[0].titulo}`
    : `DEMCO te invita a responder ${encuestas.length} encuestas`;

  const items = encuestas
    .map((e) => {
      const url = `${urlBase.replace(/\/$/, '')}/e/${encodeURIComponent(e.id)}`;
      const descripcion = e.descripcion ? `<p style="margin:4px 0 12px;color:#475569;">${escapeHtml(e.descripcion)}</p>` : '';
      return `
        <tr>
          <td style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;background:#ffffff;">
            <h3 style="margin:0 0 4px;color:#1f2421;font-size:16px;">${escapeHtml(e.titulo)}</h3>
            ${descripcion}
            <a href="${url}" style="display:inline-block;background:#008751;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;font-size:14px;">
              Responder encuesta
            </a>
          </td>
        </tr>`;
    })
    .join('');

  const mensajeHtml = mensaje
    ? `<p style="margin:0 0 16px;color:#1f2421;">${escapeHtml(mensaje).replace(/\n/g, '<br/>')}</p>`
    : '';

  const texto = [
    `${asunto}`,
    '',
    mensaje ? `${mensaje}\n\n` : '',
    ...encuestas.map((e) => `${e.titulo}\n  ${urlBase.replace(/\/$/, '')}/e/${encodeURIComponent(e.id)}\n`),
    'Atentamente,\nDEMCO',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
              <tr>
                <td style="background:#008751;padding:18px 24px;">
                  <h2 style="margin:0;color:#ffffff;font-size:20px;">DEMCO</h2>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;">
                  <h1 style="margin:0 0 8px;color:#1f2421;font-size:18px;">Respondernos es fácil</h1>
                  ${mensajeHtml}
                  <p style="margin:0 0 16px;color:#475569;">Te compartimos las encuestas disponibles. Pulsa el botón para abrir cada una y responderla:</p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="6">${items}</table>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
                  Este correo fue enviado por ${escapeHtml(leerConfiguracionCorreo().remiteNombre)} (DEMCO).
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>`;

  return { asunto, html, texto };
}

async function enviarPorResend(cfg: EnviosCorreoConfig, msg: EnviarCorreoInput): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${cfg.remiteNombre} <${cfg.remiteEmail}>`,
      to: [msg.para],
      subject: msg.asunto,
      html: msg.html,
      text: msg.texto,
    }),
  });

  if (!res.ok) {
    const cuerpo = await res.text();
    throw new Error(`Resend respondió ${res.status}: ${cuerpo}`);
  }
}

async function enviarPorBrevo(cfg: EnviosCorreoConfig, msg: EnviarCorreoInput): Promise<void> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: cfg.remiteEmail, name: cfg.remiteNombre },
      to: [{ email: msg.para }],
      subject: msg.asunto,
      htmlContent: msg.html,
      textContent: msg.texto,
    }),
  });

  if (!res.ok) {
    const cuerpo = await res.text();
    throw new Error(`Brevo respondió ${res.status}: ${cuerpo}`);
  }
}

function guardarEmailSimulado(cfg: EnviosCorreoConfig, msg: EnviarCorreoInput): void {
  const carpeta = path.join(__dirname, '..', 'data', 'emails');
  if (!existsSync(carpeta)) mkdirSync(carpeta, { recursive: true });

  const archivo = path.join(carpeta, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.eml`);
  const eml = [
    `From: ${cfg.remiteNombre} <${cfg.remiteEmail}>`,
    `To: ${msg.para}`,
    `Subject: ${msg.asunto}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    msg.html,
  ].join('\n');

  writeFileSync(archivo, eml, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`[MAIL simulada] Para: ${msg.para} | Asunto: ${msg.asunto}`);
  // eslint-disable-next-line no-console
  console.log(`[MAIL simulada] Guardada en ${archivo}`);
}

// Envía un correo usando el proveedor configurado. Si no hay API key,
// cae en modo simulado (guarda .eml y registra en consola).
export async function enviarCorreo(msg: EnviarCorreoInput): Promise<ProveedorCorreo> {
  const cfg = leerConfiguracionCorreo();

  switch (cfg.proveedor) {
    case 'resend':
      await enviarPorResend(cfg, msg);
      return 'resend';
    case 'brevo':
      await enviarPorBrevo(cfg, msg);
      return 'brevo';
    case 'simulado':
      guardarEmailSimulado(cfg, msg);
      return 'simulado';
  }
}