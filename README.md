# DEMCO Backend (encuestas)

API mínima para servir encuestas y recibir respuestas (incluidas las que
el front sincroniza después de haber estado offline).

## Instalar y correr

```bash
npm install
npm run dev
```

Levanta en `http://localhost:4000`.

Los datos viven en **Supabase (Postgres)**. Para correrlo necesitas tener el
esquema aplicado y las credenciales en `.env`:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

La `SUPABASE_URL` es la URL del proyecto, **sin** `/rest/v1` (el backend la
normaliza si se la pones con el path).

## Endpoints

- `GET /api/encuestas` — lista de encuestas disponibles.
- `GET /api/encuestas/estadisticas` — resumen agregado del módulo de
  encuestas: KPIs, serie mensual de respuestas, estado y avance de cada
  encuesta, y las alertas (encuestas enviadas que llevan más de 30 días sin
  respuesta, o creadas y nunca enviadas). Es lo que pintan el dashboard y la
  lista de proyectos.
- `GET /api/encuestas/:id` — una encuesta específica.
- `POST /api/encuestas/respuestas` — guarda una respuesta.
  Body esperado:
  ```json
  {
    "id": "uuid-generado-en-el-front",
    "encuestaId": "enc-1",
    "respuestas": { "p1": 5, "p2": "Sí", "p3": "Todo bien" },
    "fechaRespuesta": "2026-08-09T20:00:00.000Z"
  }
  ```
- `GET /api/encuestas/:id/respuestas` — respuestas de una encuesta.
- `GET /api/encuestas/respuestas/todas` — todas las respuestas recibidas.

## Producción

El backend ya usa una base de datos real (Supabase/Postgres). Para publicar
necesitas:

- El **frontend** es estático (Vite): sirve en Netlify, Vercel o cualquier
  hosting de estáticos.
- El **backend** es Node: necesita un servicio que lo deje corriendo 24/7
  (Railway, Render, Fly.io). Define `PORT`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` y `PUBLIC_URL` (la URL pública del backend, sin
  barra final) en las variables de entorno del servicio.
- `PUBLIC_URL` es la que se usa para armar los links `/e/:id` de los correos;
  si no la defines, los correos apuntan a `http://localhost:4000`.

## Arquitectura

```
src/
  db.ts                    tipos de dominio + interfaz Repositorio
  repositorio.ts           punto de acceso: export const repo
  repositorio-supabase.ts  implementación de Repositorio contra Supabase
  estadisticas.ts          cálculo de KPIs y serie mensual
  routes/encuestas.ts      API /api/encuestas
  routes/publicas.ts       formulario público /e/:id
  async-handler.ts         evita que un error async tumbe el proceso
```

Las rutas no saben nada de Supabase: hablan con `repo`. Si algún día hay que
cambiar de base de datos, se implementa `Repositorio` y ya está.

`data/db.json` quedó solo como origen histórico de la migración; el backend
ya no lo lee ni lo escribe.

## Supabase (Postgres)

Ya está listo el esquema y el script de migración:

- `supabase/schema.sql` — el DDL (tablas, índices, triggers, vistas, RLS).
- `scripts/migrar-a-supabase.mjs` — copia `data/db.json` a Supabase.
- `scripts/supabase-mapeo.mjs` — el mapeo lowdb → Postgres (funciones puras).
- `scripts/verificar-supabase.mjs` — comprueba los conteos y las vistas.

Pasos:

1. Crea el proyecto en [supabase.com](https://supabase.com).
2. Abre el **SQL Editor**, pega `supabase/schema.sql` y dale *Run*. Es
   idempotente, lo puedes correr las veces que quieras.
3. En *Project Settings → API* copia la **secret key** (`sb_secret_...`, o el
   `service_role` clásico) y ponla en tu `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
   ```
4. Migra los datos:
   ```bash
   npm run migrate:supabase
   ```
5. Comprueba que quedó bien:
   ```bash
   npm run supabase:verificar
   ```

6. Smoke test de la API (con el server corriendo en otra terminal):
   ```bash
   npm run test:api
   ```
   Crea una encuesta de prueba, la versiona, la responde, la borra y comprueba
   que la base queda igual que al empezar. Con `API_TEST_CORREO=1` también
   prueba el envío de correo (manda un correo real a la dirección de pruebas
   de Resend).

> **Las secret keys solo funcionan desde el servidor.** Supabase las rechaza
> si detecta un User-Agent de navegador ("Forbidden use of secret API key in
> browser"). Para el backend (Node) está perfecto; nunca pongas esa key en el
> front.

> **Ojo — respuestas huérfanas.** Tu `data/db.json` tiene 3 respuestas que
> apuntan a encuestas que ya no existen (`enc-6d8e81eb`, `enc-c51f8236`,
> `enc-2a1beeca`; son de la encuesta de prueba de todos los tipos de
> pregunta). lowdb las guardaba sin problema porque no tiene foreign keys;
> Postgres las rechaza. Por defecto el script las **omite** y te avisa. Si
> quieres conservarlas, usa `npm run migrate:supabase:huerfanas`, que crea
> una encuesta "recuperada" por cada id huérfano. Los valores de las
> respuestas se conservan intactos, pero no los textos de las preguntas (esa
> información ya no existe en ningún lado).
