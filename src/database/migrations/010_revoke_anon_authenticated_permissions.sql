-- Migración 010: Segunda Capa Defensiva para Tablas Sensibles del Backend
-- Revocación total de permisos a los roles de Supabase ('anon', 'authenticated')
-- para garantizar que incluso un error humano posterior con una política RLS permisiva no filtre datos.

-- 1. Asegurar que TODAS las tablas en public tengan RLS habilitado (incluida migrations_history)
ALTER TABLE IF EXISTS public.migrations_history ENABLE ROW LEVEL SECURITY;

-- 2. Revocar todos los permisos a anon y authenticated en todas las tablas
REVOKE ALL ON TABLE public.contacts FROM anon, authenticated;
REVOKE ALL ON TABLE public.conversations FROM anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.message_status_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.outbox_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbound_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.leads FROM anon, authenticated;
REVOKE ALL ON TABLE public.handoff_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.audit_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.migrations_history FROM anon, authenticated;

-- 3. Revocación de privilegios por defecto en el esquema public para futuros objetos
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

