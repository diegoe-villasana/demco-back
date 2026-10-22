// ============================================================================
//  DEMCO — Migración de data/db.json (lowdb) a Supabase (Postgres)
//
//  Copia encuestas, versiones, respuestas y envíos de correo. Es
//  idempotente: usa upsert por `id`, así que puedes correrlo las veces que
//  quieras sin duplicar nada.
//
//  Uso:
//      npm run migrate:supabase
//
//  Requiere en el .env del backend:
//      SUPABASE_URL=https://xxxx.supabase.co
//      SUPABASE_SERVICE_ROLE_KEY=eyJ...
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  mapearEncuestas,
  mapearRespuestas,
  mapearEnvios,
  mapearHuerfanas,
} from './supabase-mapeo.mjs';

// --con-huerfanas: en vez de omitir las respuestas cuya encuesta ya no
// existe, crea una encuesta "recuperada" para conservarlas.
const CON_HUERFANAS = process.argv.includes('--con-huerfanas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const ENV_FILE = path.join(ROOT, '.env');

// ---------------------------------------------------------------------------
// .env — loader nativo de Node (v20.12+). Si no está disponible, se usa un
// parser manual como respaldo.
// ---------------------------------------------------------------------------
function cargarEnv() {
  if (!existsSync(ENV_FILE)) return;

  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(ENV_FILE);
      return;
    } catch {
      // Si el .env está mal formado, caemos al parser manual.
    }
  }

  for (const linea of readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const idx = limpia.indexOf('=');
    if (idx === -1) continue;
    const clave = limpia.slice(0, idx).trim();
    const valor = limpia
      .slice(idx + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (!(clave in process.env)) process.env[clave] = valor;
  }
}
cargarEnv();

const URL_SUPABASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// La URL de proyecto es `https://xxxx.supabase.co`. Si alguien pega la URL
// del panel de API (`.../rest/v1`) o le deja una barra al final, supabase-js
// arma una ruta doble y Supabase responde "Invalid path specified in request
// URL". Normalizamos aquí para que funcione como la pongas.
function normalizarUrl(url) {
  return url.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

if (!URL_SUPABASE || !KEY) {
  console.error(
    '\n  Faltan credenciales. Agrega esto a demco-backend/.env:\n' +
      '    SUPABASE_URL=https://xxxx.supabase.co\n' +
      '    SUPABASE_SERVICE_ROLE_KEY=sb_secret_...  (o la key service_role)\n'
  );
  process.exit(1);
}

const urlLimpia = normalizarUrl(URL_SUPABASE);
if (urlLimpia !== URL_SUPABASE.trim()) {
  console.log(`  · URL normalizada: ${urlLimpia}`);
}

const supabase = createClient(urlLimpia, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let sincronizadas = 0;

async function upsert(tabla, filas, onConflict) {
  if (filas.length === 0) {
    console.log(`  · ${tabla}: sin datos`);
    return;
  }
  const { error } = await supabase.from(tabla).upsert(filas, { onConflict });
  if (error) {
    console.error(`\n  ERROR en ${tabla}: ${error.message}\n`);
    process.exit(1);
  }
  sincronizadas += filas.length;
  console.log(`  · ${tabla}: ${filas.length} registro(s)`);
}

// ---------------------------------------------------------------------------
// Carga del lowdb
// ---------------------------------------------------------------------------
if (!existsSync(DB_FILE)) {
  console.error(`\n  No encontré ${DB_FILE}\n`);
  process.exit(1);
}

const db = JSON.parse(readFileSync(DB_FILE, 'utf-8'));
const encuestas = db.encuestas ?? [];
const respuestas = db.respuestas ?? [];
const enviosCorreo = db.enviosCorreo ?? [];

console.log(`\n  Origen: ${DB_FILE}`);
console.log(
  `  ${encuestas.length} encuestas · ${respuestas.length} respuestas · ${enviosCorreo.length} envíos\n`
);

// ---------------------------------------------------------------------------
// 1. Encuestas + versiones
//    Los ids de versión (uuid) y de encuesta (text) se conservan tal cual,
//    para que los links /e/:id que ya se mandaron por correo sigan sirviendo.
//
//    ORDEN IMPORTANTE: primero las encuestas (sin puntero de versión activa),
//    después las versiones. El trigger `trg_sync_version_activa` rellena
//    `encuestas.version_activa_id` al entrar cada versión.
console.log('  Cargando...');
const { filasEncuestas, filasVersiones } = mapearEncuestas(encuestas);
await upsert('encuestas', filasEncuestas, 'id');
await upsert('encuesta_versiones', filasVersiones, 'id');

// ---------------------------------------------------------------------------
// 2. Encuestas huérfanas (opcional)
//
//    Hay respuestas cuyo `encuestaId` no existe en `db.encuestas`: la
//    encuesta se borró del backend pero su respuesta quedó, porque lowdb no
//    tiene foreign keys. Postgres sí las rechaza.
//
//    Sin --con-huerfanas  -> se omiten (la BD queda consistente, se pierden
//                            esas respuestas)
//    Con --con-huerfanas  -> se crea una encuesta "recuperada" por cada id
//                            huérfano y las respuestas se conservan con sus
//                            valores intactos (pero sin versión ni textos
//                            de pregunta: esa info ya no existe en ningún lado)
// ---------------------------------------------------------------------------
const idsEncuesta = new Set(encuestas.map((e) => e.id));

if (CON_HUERFANAS) {
  const { filas: filasHuerfanas, huerfanos } = mapearHuerfanas(respuestas, idsEncuesta);
  if (huerfanos.length > 0) {
    console.log(
      `  · ${huerfanos.length} encuesta(s) recuperada(s): ${huerfanos.join(', ')}`
    );
    await upsert('encuestas', filasHuerfanas, 'id');
    for (const id of huerfanos) idsEncuesta.add(id);
  }
}

// ---------------------------------------------------------------------------
// 3. Respuestas
// ---------------------------------------------------------------------------
const idsVersion = new Set(filasVersiones.map((v) => v.id));

const { filas: filasRespuestas, avisos: avisosRespuestas } = mapearRespuestas(
  respuestas,
  idsVersion,
  idsEncuesta
);
for (const a of avisosRespuestas) console.warn(`  ! ${a}`);
await upsert('respuestas', filasRespuestas, 'id');

// ---------------------------------------------------------------------------
// 4. Envíos de correo + invitaciones por encuesta
// ---------------------------------------------------------------------------
const { filasEnvios, filasInvitaciones, avisos: avisosEnvios } = mapearEnvios(
  enviosCorreo,
  idsEncuesta
);
for (const a of avisosEnvios) console.warn(`  ! ${a}`);
await upsert('envios_correo', filasEnvios, 'id');
await upsert('envio_correo_encuestas', filasInvitaciones, 'envio_id,encuesta_id');

// ---------------------------------------------------------------------------
// 5. Re-sincroniza el puntero de versión activa por si quedó desfasado
//    (el trigger ya lo hizo, pero esto lo deja garantizado incluso si una
//    encuesta ya existía con versiones cargadas).
// ---------------------------------------------------------------------------
for (const enc of encuestas) {
  const { error } = await supabase.rpc('sincronizar_version_activa', {
    p_encuesta_id: enc.id,
  });
  if (error) {
    console.warn(`  ! no se pudo sincronizar ${enc.id}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Verificación
// ---------------------------------------------------------------------------
const { data: kpis } = await supabase.from('v_kpis_encuestas').select('*').single();

console.log('\n  Migración completa.');
console.log(`  Filas sincronizadas: ${sincronizadas}`);
console.log('  Verificación en Supabase:');
console.log(`    ${JSON.stringify(kpis)}\n`);
console.log('  Nota: el backend sigue usando lowdb. Para que el backend lea de');
console.log('  Supabase hay que cambiar la capa src/db.ts (siguiente paso).\n');
