# DEMCO Backend (encuestas)

API mínima para servir encuestas y recibir respuestas (incluidas las que
el front sincroniza después de haber estado offline).

## Instalar y correr

```bash
npm install
npm run dev
```

Levanta en `http://localhost:4000`. Los datos se guardan en `data/db.json`
(se crea solo con datos de ejemplo la primera vez que corres el server).

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

`data/db.json` es solo para desarrollo rápido (no usa una base de datos real,
es un archivo plano). Antes de producción, cambia `src/db.ts` por Postgres,
MySQL o Mongo — las funciones `db.read()` / `db.write()` son las únicas que
tendrías que reemplazar; las rutas no cambian.
