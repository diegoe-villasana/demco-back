import express from 'express';
import cors from 'cors';
import { initDB } from './db.js';
import { cargarEnv } from './env.js';
import { encuestasRouter } from './routes/encuestas.js';
import { publicoRouter } from './routes/publicas.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

async function main() {
  cargarEnv();
  await initDB();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/encuestas', encuestasRouter);
  // Formularios públicos para responder encuestas desde el correo.
  app.use('/e', publicoRouter);

  app.listen(PORT, () => {
    console.log(`Backend de DEMCO escuchando en http://localhost:${PORT}`);
  });
}

main();
