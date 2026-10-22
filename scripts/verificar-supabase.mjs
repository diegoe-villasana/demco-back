// ============================================================================
//  DEMCO — Verificación del estado de Supabase
//
//  Consulta las tablas y las vistas para confirmar que la migración quedó
//  bien. Solo lee.
//
//  Uso:
//      npm run supabase:verificar
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

if (existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(ENV_FILE);
    } catch {
      // .env mal formado: se sigue con lo que haya en process.env
    }
  }
}

const url = (process.env.SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/i, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('\n  Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el .env\n');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log('\n  Conteo por tabla');
for (const t of [
  'encuestas',
  'encuesta_versiones',
  'respuestas',
  'envios_correo',
  'envio_correo_encuestas',
]) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
  console.log(`    ${t.padEnd(24)} ${error ? 'ERROR: ' + error.message : count}`);
}

const { data: punteros } = await sb.from('encuestas').select('id,version_activa_id');
const conP = punteros.filter((p) => p.version_activa_id).length;
console.log(`\n  version_activa_id: ${conP} / ${punteros.length} encuestas apuntando a su versión`);

const { data: versiones } = await sb
  .from('encuesta_versiones')
  .select('encuesta_id,numero,titulo,preguntas')
  .eq('encuesta_id', 'enc-1')
  .order('numero');
console.log('\n  Versiones de enc-1');
for (const v of versiones) {
  console.log(`    v${v.numero}  ${v.titulo}  (${v.preguntas.length} preguntas)`);
}

const { data: res } = await sb
  .from('respuestas')
  .select('*')
  .eq('encuesta_id', 'enc-1')
  .limit(2);
console.log('\n  Muestra de respuestas de enc-1');
for (const r of res) {
  console.log(`    ${r.id}  version=${r.version_id ? 'sí' : 'null'}  ${r.fecha_respuesta}`);
  console.log(`      ${JSON.stringify(r.respuestas)}`);
}

const { data: kpis } = await sb.from('v_kpis_encuestas').select('*').single();
console.log('\n  v_kpis_encuestas');
console.log(`    ${JSON.stringify(kpis)}`);

const { data: resumen } = await sb
  .from('v_encuesta_resumen')
  .select('encuesta_id,titulo,total_respuestas,invitaciones,ultima_respuesta')
  .order('encuesta_id')
  .limit(6);
console.log('\n  v_encuesta_resumen (primeras 6)');
for (const r of resumen) {
  console.log(
    `    ${r.encuesta_id.padEnd(14)} resp=${String(r.total_respuestas).padStart(3)}  invit=${String(r.invitaciones).padStart(3)}  ult=${r.ultima_respuesta ?? '-'}`
  );
}

const { data: porPregunta } = await sb
  .from('v_respuestas_por_pregunta')
  .select('pregunta_id,valor')
  .limit(5);
console.log('\n  v_respuestas_por_pregunta (muestra)');
for (const p of porPregunta) console.log(`    ${p.pregunta_id} = ${JSON.stringify(p.valor)}`);

console.log('');
