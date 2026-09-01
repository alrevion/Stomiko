-- Stomiko 005: линтер Supabase не любит расширения в public.
create schema if not exists extensions;
alter extension btree_gist set schema extensions;
