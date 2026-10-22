import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

// Carga el .env si existe, sin sobrescribir variables ya definidas en el shell.
export function cargarEnv(): void {
  if (!existsSync(ENV_FILE)) return;

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

    if (!(clave in process.env)) {
      process.env[clave] = valor;
    }
  }
}