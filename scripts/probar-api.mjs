/**
 * Smoke test de la API contra el backend corriendo.
 *
 *   npm run dev          (en otra terminal)
 *   npm run test:api
 *
 * Crea una encuesta de prueba, la versiona, la responde, la borra y comprueba
 * que el estado final de la base es el mismo que al empezar.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:4000';
let fallos = 0;

function log(ok, etiqueta, extra = '') {
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${etiqueta}${extra ? ' :: ' + extra : ''}`);
}

async function json(r) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

const PREGUNTAS = [
  { id: 'p1', texto: '¿Cómo te fue?', tipo: 'texto', obligatorio: true },
];

// 1. health
let r = await fetch(`${BASE}/health`);
log(r.ok, 'GET /health', JSON.stringify(await json(r)));

// Línea base: al final el estado de la base debe ser el mismo.
const base = {
  encuestas: (await (await fetch(`${BASE}/api/encuestas`)).json()).length,
  respuestas: (await (await fetch(`${BASE}/api/encuestas/respuestas/todas`)).json()).length,
};

// 2. listado
r = await fetch(`${BASE}/api/encuestas`);
const lista = await json(r);
log(r.ok && Array.isArray(lista) && lista.length > 0, 'GET /api/encuestas', `n=${Array.isArray(lista) ? lista.length : '?'}`);
const primera = lista[0];
log(!!primera?.id, '  -> forma aplanada', `id=${primera?.id} titulo="${primera?.titulo}"`);
log(typeof primera?.totalRespuestas === 'number', '  -> totalRespuestas', String(primera?.totalRespuestas));
log(typeof primera?.correosEnviados === 'number', '  -> correosEnviados', String(primera?.correosEnviados));
log(!!primera?.ultimaRespuesta, '  -> ultimaRespuesta', String(primera?.ultimaRespuesta));
log(Array.isArray(primera?.preguntas) && primera.preguntas.length > 0, '  -> preguntas', `n=${primera?.preguntas?.length}`);
log(typeof primera?.versionNumero === 'number', '  -> versionNumero', String(primera?.versionNumero));

// 3. estadisticas
r = await fetch(`${BASE}/api/encuestas/estadisticas`);
const est = await json(r);
log(r.ok && typeof est === 'object', 'GET /api/encuestas/estadisticas');
log(est?.kpis?.encuestas === base.encuestas && est?.kpis?.respuestas === base.respuestas, '  -> kpis coinciden con la base', JSON.stringify(est?.kpis));

// 4. detalle (version activa aplanada)
r = await fetch(`${BASE}/api/encuestas/${primera.id}`);
const det = await json(r);
log(r.ok && det?.id === primera.id && typeof det?.versionId === 'string', `GET /api/encuestas/${primera.id}`, `versionId=${det?.versionId}`);
log(det?.totalRespuestas === primera.totalRespuestas, '  -> totalRespuestas consistente con el listado', `${det?.totalRespuestas} vs ${primera?.totalRespuestas}`);

// 5. versiones
r = await fetch(`${BASE}/api/encuestas/${primera.id}/versiones`);
const vers = await json(r);
log(r.ok && Array.isArray(vers) && vers.length > 0, 'GET /:id/versiones', `n=${vers?.length}`);
const vid = vers[0]?.id;
log(typeof vers[0]?.totalRespuestas === 'number', '  -> totalRespuestas por version', String(vers[0]?.totalRespuestas));

// 6. version concreta
r = await fetch(`${BASE}/api/encuestas/${primera.id}/versiones/${vid}`);
const ver = await json(r);
log(r.ok && ver?.id === primera.id && ver?.versionId === vid, 'GET /:id/versiones/:versionId', `versionNumero=${ver?.versionNumero} sellada=${ver?.sellada}`);

// 7. respuestas
r = await fetch(`${BASE}/api/encuestas/${primera.id}/respuestas`);
const resp = await json(r);
log(r.ok && Array.isArray(resp) && resp.length > 0, 'GET /:id/respuestas', `n=${resp?.length}`);
log(!!resp[0]?.respuestas && !!resp[0]?.fechaRespuesta, '  -> forma de respuesta', JSON.stringify(resp[0]).slice(0, 120));

r = await fetch(`${BASE}/api/encuestas/respuestas/todas`);
const todas = await json(r);
log(r.ok && todas.length === base.respuestas, 'GET /respuestas/todas', `n=${todas?.length}`);

// 8. formulario publico
r = await fetch(`${BASE}/e/${primera.id}`);
const html = await r.text();
log(r.ok && html.includes('<form'), 'GET /e/:id (formulario publico)', `len=${html.length}`);
log(html.includes('__versionId'), '  -> hidden __versionId');

r = await fetch(`${BASE}/e/enc-inexistente`);
log(r.status === 404, 'GET /e/:id inexistente -> 404', `status=${r.status}`);

// 9. crear encuesta
r = await fetch(`${BASE}/api/encuestas`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    titulo: 'Prueba automatica Supabase',
    descripcion: 'Creada por el script de verificacion',
    preguntas: PREGUNTAS,
    secciones: [{ id: 's1', titulo: 'General', descripcion: '', preguntas: ['p1'] }],
  }),
});
const creada = await json(r);
log(r.status === 201 && !!creada?.id, 'POST /api/encuestas', `id=${creada?.id} status=${r.status}`);

// 10. la nueva encuesta existe y tiene version activa
r = await fetch(`${BASE}/api/encuestas/${creada.id}`);
const nueva = await json(r);
log(r.ok && nueva?.preguntas?.length === 1, '  -> creada y con version activa', `versionId=${nueva?.versionId} numero=${nueva?.versionNumero}`);
log(nueva?.totalRespuestas === 0, '  -> 0 respuestas', String(nueva?.totalRespuestas));

// 11. crear version 2
r = await fetch(`${BASE}/api/encuestas/${creada.id}/versiones`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    titulo: 'Prueba automatica Supabase v2',
    descripcion: 'Segunda version',
    preguntas: [{ id: 'p1', texto: '¿Qué tal?', tipo: 'texto', obligatorio: true }],
  }),
});
const v2 = await json(r);
log(r.status === 201 && v2?.versionNumero === 2, 'POST /:id/versiones', `versionId=${v2?.versionId} numero=${v2?.versionNumero}`);

// 12. editar version 2
r = await fetch(`${BASE}/api/encuestas/${creada.id}/versiones/${v2?.versionId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    titulo: 'Prueba automatica Supabase v2 editada',
    descripcion: 'Editada',
    preguntas: [{ id: 'p1', texto: '¿Qué tal? (editado)', tipo: 'texto', obligatorio: true }],
  }),
});
const put = await json(r);
log(r.ok && put?.preguntas?.[0]?.texto === '¿Qué tal? (editado)', 'PUT /:id/versiones/:versionId', `titulo="${put?.titulo}"`);

// 13. responder via formulario publico
r = await fetch(`${BASE}/e/${creada.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ p1: 'Muy bien', __versionId: v2?.versionId ?? '' }),
  redirect: 'manual',
});
log(r.status === 303, 'POST /e/:id (responder)', `status=${r.status} location=${r.headers.get('location')}`);

// 14. la respuesta quedo guardada contra la version 2
r = await fetch(`${BASE}/api/encuestas/${creada.id}/respuestas`);
const rs = await json(r);
log(r.ok && rs.length === 1, '  -> respuesta guardada', `n=${rs.length}`);
log(rs[0]?.respuestas?.p1 === 'Muy bien', '  -> valor de la respuesta', JSON.stringify(rs[0]?.respuestas));
log(rs[0]?.versionId === v2?.versionId, '  -> atada a la version 2', String(rs[0]?.versionId));

// 15. la version quedo sellada
r = await fetch(`${BASE}/api/encuestas/${creada.id}/versiones/${v2?.versionId}`);
const v2b = await json(r);
log(v2b?.sellada === true, '  -> version sellada tras 1a respuesta', String(v2b?.sellada));

// 16. editar una version sellada -> 409
r = await fetch(`${BASE}/api/encuestas/${creada.id}/versiones/${v2?.versionId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ titulo: 'No deberia', preguntas: PREGUNTAS }),
});
log(r.status === 409, '  -> PUT en version sellada -> 409', `status=${r.status} ${JSON.stringify(await json(r)).slice(0, 90)}`);

// 17. envio de correo. Es opt-in porque manda un correo de verdad y deja una
// fila en envios_correo: pon API_TEST_CORREO=1 para correrlo.
if (process.env.API_TEST_CORREO === '1') {
  r = await fetch(`${BASE}/api/encuestas/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encuestaIds: [creada.id], destinatarios: ['onboarding@resend.dev'], mensaje: 'Hola' }),
  });
  const env = await json(r);
  log(r.status === 201, 'POST /api/encuestas/enviar', `status=${r.status} ${JSON.stringify(env).slice(0, 160)}`);

  // 18. el envio quedo registrado y se refleja en correosEnviados
  r = await fetch(`${BASE}/api/encuestas/${creada.id}`);
  const trasEnvio = await json(r);
  log(trasEnvio?.correosEnviados === 1, '  -> correosEnviados = 1', String(trasEnvio?.correosEnviados));
} else {
  console.log('SKIP POST /api/encuestas/enviar (pon API_TEST_CORREO=1 para probarlo)');
}

// 19. idempotencia del POST de respuestas
const idFalso = crypto.randomUUID();
const cuerpo = { id: idFalso, encuestaId: creada.id, versionId: v2?.versionId, respuestas: { p1: 'otra' }, fechaRespuesta: new Date().toISOString() };
r = await fetch(`${BASE}/api/encuestas/respuestas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
log(r.status === 201, 'POST /api/encuestas/respuestas', `status=${r.status} ${JSON.stringify(await json(r)).slice(0, 100)}`);
r = await fetch(`${BASE}/api/encuestas/respuestas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
const dup = await json(r);
log(dup?.duplicado === true, '  -> reintento no duplica', JSON.stringify(dup));

// 19b. id con formato invalido (no uuid) -> no debe tumbar el servidor
const cuerpoMalo = { id: 'no-es-un-uuid', encuestaId: creada.id, versionId: v2?.versionId, respuestas: { p1: 'x' }, fechaRespuesta: new Date().toISOString() };
r = await fetch(`${BASE}/api/encuestas/respuestas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpoMalo) });
log(r.status === 201, 'POST /respuestas con id no-uuid -> 201', `status=${r.status} ${JSON.stringify(await json(r)).slice(0, 90)}`);
r = await fetch(`${BASE}/health`);
log(r.ok, '  -> el servidor sigue vivo tras el id invalido', `status=${r.status}`);

// 20. borrar
r = await fetch(`${BASE}/api/encuestas/${creada.id}`, { method: 'DELETE' });
log(r.status === 204, 'DELETE /api/encuestas/:id', `status=${r.status}`);
r = await fetch(`${BASE}/api/encuestas/${creada.id}`);
log(r.status === 404, '  -> borrada (404)', `status=${r.status}`);
r = await fetch(`${BASE}/api/encuestas`);
const listaFinal = await json(r);
log(listaFinal.length === base.encuestas, '  -> el listado vuelve al mismo numero de encuestas', `n=${listaFinal.length}`);
const respFinal = await (await fetch(`${BASE}/api/encuestas/respuestas/todas`)).json();
log(respFinal.length === base.respuestas, '  -> y el de respuestas', `n=${respFinal.length}`);

console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : fallos + ' PRUEBAS FALLARON'}`);
process.exit(fallos === 0 ? 0 : 1);
