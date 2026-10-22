import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { repo } from './repositorio.js';
import { cargarEnv } from './env.js';
import { encuestasRouter } from './routes/encuestas.js';
import { publicoRouter } from './routes/publicas.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

async function main() {
  cargarEnv();
  await repo.init();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/encuestas', encuestasRouter);
  // Formularios públicos para responder encuestas desde el correo.
  app.use('/e', publicoRouter);

  // Red de seguridad: cualquier error que se escape de un handler (por
  // ejemplo, un fallo puntual de Supabase) se responde como 500 en vez de
  // dejar la petición colgada.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Error no controlado en la API:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  app.listen(PORT, () => {
    console.log(`Backend de DEMCO escuchando en http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(`\n  No se pudo arrancar el backend: ${err.message}\n`);
  process.exit(1);
});
