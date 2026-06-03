-- ============================================================================
-- IZAS CHATBOT — CONFIGURACIÓN DE SUPABASE
-- Ejecuta este script en: Supabase -> SQL Editor -> New query -> Run
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TABLA DEL ÍNDICE DE PRODUCTOS (embeddings persistentes)
--    Evita que el backend re-vectorice todo el catálogo con OpenAI en cada
--    arranque en frío de Render. El backend la usa automáticamente.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_index (
  id          text primary key,        -- id del producto de Shopify
  payload     jsonb not null,          -- producto completo + embedding
  updated_at  timestamptz default now()
);

-- ----------------------------------------------------------------------------
-- 2) SEGURIDAD (RLS) — MUY IMPORTANTE
--    Las tablas chat_sessions y ai_index NO deben ser legibles públicamente
--    con la anon key, porque chat_sessions contiene datos personales
--    (emails, pedidos). El backend usa la SERVICE ROLE key, que se salta el
--    RLS, así que seguirá funcionando. El visualizador, en cambio, usa la
--    anon key: para que pueda leer, más abajo tienes DOS opciones.
-- ----------------------------------------------------------------------------

-- Activamos RLS (por defecto, sin políticas, NADIE puede leer con anon key)
alter table public.chat_sessions enable row level security;
alter table public.ai_index      enable row level security;

-- ============================================================================
-- OPCIÓN A (RECOMENDADA): el visualizador solo accesible tras iniciar sesión.
-- Requiere que actives Supabase Auth y entres en el visualizador con un
-- usuario. Con esto, solo usuarios autenticados leen las conversaciones.
-- ============================================================================
-- create policy "lectura_chats_autenticados"
--   on public.chat_sessions for select
--   to authenticated
--   using (true);

-- ============================================================================
-- OPCIÓN B (RÁPIDA, MENOS SEGURA): permitir lectura con la anon key.
-- Úsala solo si el visualizador es de uso interno y la URL no es pública.
-- Cualquiera con la anon key podría leer los chats, así que NO la dejes
-- en una web pública.
-- ============================================================================
-- create policy "lectura_chats_anon"
--   on public.chat_sessions for select
--   to anon
--   using (true);

-- Nota: el backend (service role) NO necesita políticas; se salta el RLS.
-- El visualizador NO necesita leer ai_index, así que no creamos política
-- de lectura anon para esa tabla.

-- ----------------------------------------------------------------------------
-- 3) (OPCIONAL) LIMPIEZA / RETENCIÓN
--    Si quieres borrar conversaciones antiguas (p.ej. > 90 días) para minimizar
--    datos personales almacenados, puedes ejecutar algo así de vez en cuando:
-- ----------------------------------------------------------------------------
-- delete from public.chat_sessions where updated_at < now() - interval '90 days';
