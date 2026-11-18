-- Migración 012: Privilegios por defecto endurecidos y soporte de SYSTEM_DELAY en handoff (C4 / B5)

-- 1. Revocar permisos sobre todas las secuencias y rutinas existentes en public
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

-- 2. Revocación de privilegios por defecto en el esquema public (rol actual y rol postgres de Supabase)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Privilegios insuficientes para alterar default privileges del rol postgres, omitiendo';
    END;
  END IF;
END $$;

-- 3. Permitir SYSTEM_DELAY en handoff_sessions para mensajes obsoletos tras caídas del sistema (B5)
ALTER TABLE public.handoff_sessions DROP CONSTRAINT IF EXISTS handoff_sessions_trigger_reason_check;
ALTER TABLE public.handoff_sessions ADD CONSTRAINT handoff_sessions_trigger_reason_check 
  CHECK (trigger_reason IN ('USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE', 'SYSTEM_DELAY'));
