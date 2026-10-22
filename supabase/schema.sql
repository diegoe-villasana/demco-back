-- ============================================================================
--  DEMCO — Esquema para Supabase (Postgres)
--  Traducción 1:1 del modelo lowdb que vive en demco-backend/data/db.json
--  (interfaces en src/db.ts)
--
--  Ejecutar en el SQL Editor de Supabase Studio (o `supabase db push`).
--  Es idempotente: se puede correr las veces que quieras.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Extensiones
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. Tipos enumerados
--    Reflejan los `union` de src/db.ts. Si agregas un tipo de pregunta
--    nuevo en el front, tienes que agregar el valor aquí.
-- ---------------------------------------------------------------------------
do $$ begin
  create type tipo_pregunta as enum (
    'genero','si_no','idioma','ranking',
    'opcion_unica','opcion_unica_comentario','desplegable','escala','escala_n',
    'opcion_multiple','opcion_multiple_comentario',
    'texto','texto_linea','texto_parrafos','textos_multiples',
    'numero','numero_multiple','fecha',
    'matriz','matriz_escala','matriz_aumentar','matriz_sino','matriz_texto',
    'matriz_numero','matriz_doble_eje','matriz_columnas',
    'archivo','mostrar_texto'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type formato_numero as enum ('entero','decimal','porcentaje','moneda');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Tablas
-- ---------------------------------------------------------------------------

-- Encuesta = contenedor. El contenido vive en sus versiones.
create table if not exists encuestas (
  id                text primary key,
  creada_en         timestamptz not null default now(),
  -- Puntero a la versión vigente (la de mayor `numero`).
  -- La FK se agrega al final: hay dependencia circular con encuesta_versiones.
  version_activa_id uuid
);

-- Versión = foto inmutable de la encuesta. Al llegar la primera respuesta
-- se `sellada = true` y ya no se edita (mismo comportamiento que el backend).
--
-- `preguntas` y `secciones` se guardan como jsonb porque una versión se lee
-- y se escribe COMPLETA: nunca se actualiza una pregunta suelta. Así el
-- snapshot es inmutable de verdad y `seccionId` nunca puede quedar colgando.
create table if not exists encuesta_versiones (
  id          uuid primary key,
  encuesta_id text not null references encuestas(id) on delete cascade,
  numero      integer not null,
  titulo      text not null,
  descripcion text,
  preguntas   jsonb not null default '[]'::jsonb,
  secciones   jsonb not null default '[]'::jsonb,
  creada_en   timestamptz not null default now(),
  sellada     boolean not null default false,
  constraint encuesta_versiones_numero_unico unique (encuesta_id, numero)
);

-- Respuesta de un respondent.
-- `version_id` es la versión que vio el respondent (campo `__versionId` del
-- formulario público). Va nullable porque las respuestas migradas de la era
-- pre-versionado no lo traían.
create table if not exists respuestas (
  id              uuid primary key,
  encuesta_id     text not null references encuestas(id) on delete cascade,
  version_id      uuid references encuesta_versiones(id) on delete set null,
  respuestas      jsonb not null default '{}'::jsonb,
  fecha_respuesta timestamptz not null,
  recibido_en     timestamptz not null default now()
);

-- Envío de invitación por correo (1 correo -> N encuestas).
create table if not exists envios_correo (
  id           uuid primary key,
  destinatario text not null,
  asunto       text not null,
  proveedor    text not null default 'simulado',
  enviado_en   timestamptz not null default now()
);

-- Tabla puente del `encuestaIds: string[]` del lowdb.
-- Permite contar invitaciones por encuesta (lo que usa el KPI "Invitaciones").
create table if not exists envio_correo_encuestas (
  envio_id    uuid not null references envios_correo(id) on delete cascade,
  encuesta_id text not null references encuestas(id) on delete cascade,
  primary key (envio_id, encuesta_id)
);

-- ---------------------------------------------------------------------------
-- 3. Llave foránea de version_activa_id
-- ---------------------------------------------------------------------------
alter table encuestas
  drop constraint if exists encuestas_version_activa_fk;
alter table encuestas
  add constraint encuestas_version_activa_fk
  foreign key (version_activa_id)
  references encuesta_versiones(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4. Índices
-- ---------------------------------------------------------------------------
create index if not exists idx_versiones_encuesta
  on encuesta_versiones (encuesta_id, numero desc);
create index if not exists idx_respuestas_encuesta
  on respuestas (encuesta_id);
create index if not exists idx_respuestas_version
  on respuestas (version_id);
create index if not exists idx_respuestas_fecha
  on respuestas (fecha_respuesta desc);
create index if not exists idx_respuestas_jsonb
  on respuestas using gin (respuestas jsonb_path_ops);
create index if not exists idx_envios_fecha
  on envios_correo (enviado_en desc);
create index if not exists idx_envio_encuestas_encuesta
  on envio_correo_encuestas (encuesta_id);

-- ---------------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------------

-- 5.1 Mantiene `encuestas.version_activa_id` apuntando a la versión de mayor
--     `numero` (equivalente a `versionActiva()` en db.ts, que tomaba la
--     última del array).
--
--     Es una función aparte para poder llamarla por RPC:
--       supabase.rpc('sincronizar_version_activa', { p_encuesta_id: 'enc-1' })
--     Útil cuando se corrige el puntero a mano.
create or replace function sincronizar_version_activa(p_encuesta_id text)
returns void language plpgsql as $$
begin
  update encuestas e
     set version_activa_id = v.id
  from (
    select id
    from encuesta_versiones
    where encuesta_id = p_encuesta_id
    order by numero desc, creada_en desc
    limit 1
  ) v
  where e.id = p_encuesta_id
    and e.version_activa_id is distinct from v.id;
end $$;

create or replace function trg_sync_version_activa()
returns trigger language plpgsql as $$
begin
  perform sincronizar_version_activa(new.encuesta_id);
  return new;
end $$;

drop trigger if exists trg_sync_version_activa on encuesta_versiones;
create trigger trg_sync_version_activa
after insert or update of numero on encuesta_versiones
for each row execute function trg_sync_version_activa();

-- 5.2 Al llegar una respuesta, la versión queda sellada: a partir de ahí es
--     inmutable porque sus respuestas dependen de sus preguntas exactas.
--     (Equivale a `versionSolicitada.sellada = true` en routes/publicas.ts)
create or replace function marcar_version_sellada()
returns trigger language plpgsql as $$
begin
  if new.version_id is not null then
    update encuesta_versiones
       set sellada = true
     where id = new.version_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_sellar_version on respuestas;
create trigger trg_sellar_version
after insert on respuestas
for each row execute function marcar_version_sellada();

-- ---------------------------------------------------------------------------
-- 6. Vistas de apoyo para el dashboard
--    (mismo cálculo que src/estadisticas.ts, pero en SQL)
-- ---------------------------------------------------------------------------

-- 6.1 Una fila por encuesta con su resumen. Reemplaza el `aplanar()`.
create or replace view v_encuesta_resumen as
select
  e.id                    as encuesta_id,
  e.creada_en,
  v.id                    as version_activa_id,
  v.numero                as version_numero,
  v.titulo,
  v.sellada,
  v.creada_en             as version_creada_en,
  coalesce(resp.total, 0) as total_respuestas,
  resp.ultima_respuesta,
  coalesce(inv.total, 0) as invitaciones,
  inv.ultimo_envio
from encuestas e
left join encuesta_versiones v
  on v.id = e.version_activa_id
left join lateral (
  select count(*)::int as total, max(fecha_respuesta) as ultima_respuesta
  from respuestas r
  where r.encuesta_id = e.id
) resp on true
left join lateral (
  select count(*)::int as total, max(ec.enviado_en) as ultimo_envio
  from envio_correo_encuestas ece
  join envios_correo ec on ec.id = ece.envio_id
  where ece.encuesta_id = e.id
) inv on true;

-- 6.2 KPIs globales (los mismos del bloque `kpis` del endpoint de stats).
--     Los `::int` evitan que PostgREST devuelva los conteos como string.
create or replace view v_kpis_encuestas as
select
  (select count(*)::int from encuestas)               as encuestas,
  (select count(*)::int from respuestas)             as respuestas,
  (select count(*)::int from envio_correo_encuestas) as invitaciones,
  (select count(*)::int from envios_correo)           as correos,
  (select count(*)::int from encuesta_versiones
     where sellada)                                  as versiones_selladas;

-- 6.3 Aplana el jsonb de respuestas a una fila por pregunta.
--     Permite preguntar "¿cuánta gente respondió la pregunta p2?" sin
--     pelearte con el jsonb a mano.
create or replace view v_respuestas_por_pregunta as
select
  r.id              as respuesta_id,
  r.encuesta_id,
  r.version_id,
  r.fecha_respuesta,
  par.key           as pregunta_id,
  par.value         as valor
from respuestas r
cross join lateral jsonb_each(r.respuestas) as par(key, value);

-- 6.4 Conteo de respuestas por versión (lo usa el historial de versiones).
create or replace view v_respuestas_por_version as
select
  version_id,
  count(*)::int as total
from respuestas
where version_id is not null
group by version_id;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security
--
--    Activado en todas las tablas SIN policies para anon/authenticated:
--    si se filtra la anon key, PostgREST no devuelve ni una fila.
--
--    El backend debe usar la SERVICE ROLE key (solo servidor). Nunca la
--    pongas en el bundle del front.
-- ---------------------------------------------------------------------------
alter table encuestas              enable row level security;
alter table encuesta_versiones     enable row level security;
alter table respuestas             enable row level security;
alter table envios_correo          enable row level security;
alter table envio_correo_encuestas enable row level security;

-- Si en el futuro quieres que el navegador escriba directo a Supabase
-- (en vez de pasar por el backend), descomenta esto. OJO: permite spam
-- en la tabla de respuestas.
--
-- create policy "anon inserta respuestas" on respuestas
--   for insert to anon
--   with check (true);

commit;

-- ============================================================================
--  Verificación rápida (espera 15 encuestas, 11 respuestas, 14 invitaciones):
--
--    select * from v_kpis_encuestas;
--    select id, titulo, total_respuestas, invitaciones from v_encuesta_resumen;
-- ============================================================================
