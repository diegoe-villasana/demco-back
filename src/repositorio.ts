// ============================================================================
//  DEMCO — Punto único de acceso a la persistencia
//
//  Todo el backend habla con `repo`. Si algún día se cambia de Supabase a
//  otra base de datos, se toca aquí y en `repositorio-supabase.ts`; las
//  rutas no se enteran.
// ============================================================================

import type { Repositorio } from './db.js';
import { repositorioSupabase } from './repositorio-supabase.js';

export const repo: Repositorio = repositorioSupabase;
