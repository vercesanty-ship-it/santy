-- Reelizate — migración: agrega el plan (standard/pro) al perfil.
-- Correr en el SQL Editor de Supabase (además de schema.sql, que ya corriste).

alter table profiles add column if not exists plan text;
