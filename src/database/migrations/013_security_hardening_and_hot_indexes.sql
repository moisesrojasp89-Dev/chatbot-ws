-- Migración 013: Endurecimiento de Seguridad, Prevención de Fugas en Rol PUBLIC y Optimización HOT (Auditoría Argon)
-- 
-- Resuelve las observaciones técnicas de la auditoría de ciberseguridad:
-- 1. Cierre total de privilegios y herencia del pseudo-rol PUBLIC en el esquema public.
-- 2. Poda de índices redundantes que degradan actualizaciones Heap-Only Tuple (HOT Updates).
-- 3. Creación de índice sobre foreign key outbox_messages.conversation_id para evitar Seq Scans en cascada.
-- 4. Reemplazo del índice de outbox por idx_outbox_pending_fifo alineado a ORDER BY created_at ASC.
-- 5. Creación de índice de fencing token en inbound_events.
-- 6. Índices para retención y purga eficiente de filas FAILED y COALESCE(processed_at, created_at).
-- 7. Trigger de inmutabilidad estricta en audit_log (prohíbe UPDATE, DELETE y TRUNCATE) con search_path explícito.
-- 8. Trigger de actualización automática para contacts.updated_at con search_path explícito.
-- 9. Ajuste de Storage Parameters (fillfactor = 75) para maximizar HOT updates en colas de paso rápido.

-- ============================================================================
-- 1. REVOCACIÓN TOTAL DE PRIVILEGIOS AL PSEUDO-ROL PUBLIC (Ciberseguridad RLS)
-- ============================================================================
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ROUTINES FROM PUBLIC';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Privilegios insuficientes para alterar default privileges de PUBLIC para el rol postgres, omitiendo';
    END;
  END IF;
END $$;

-- ============================================================================
-- 2. PODA DE ÍNDICES REDUNDANTES (Optimización de Rendimiento & HOT Updates)
-- ============================================================================
-- Duplica el índice B-Tree implícito de la restricción UNIQUE(phone_number) en contacts
DROP INDEX IF EXISTS public.idx_contacts_phone;

-- Duplica el índice B-Tree implícito de la restricción UNIQUE(wamid) en messages
DROP INDEX IF EXISTS public.idx_messages_wamid;

-- Duplica a idx_outbox_reaper_locked_at (locked_at WHERE status = 'PROCESSING')
DROP INDEX IF EXISTS public.idx_outbox_processing_locked;

-- Cubierto íntegramente por la columna líder de la restricción UNIQUE uq_status_events_wamid_status_ts
DROP INDEX IF EXISTS public.idx_status_events_wamid;

-- Reemplazado por idx_inbound_events_done_coalesce_processed en esta misma migración
DROP INDEX IF EXISTS public.idx_inbound_events_done_processed;

-- ============================================================================
-- 3. ÍNDICES DE ALTO RENDIMIENTO FALTANTES (Prevención de Seq Scans)
-- ============================================================================
-- Clave foránea de outbox hacia conversations para eliminar Seq Scans en ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_outbox_conversation_id
ON public.outbox_messages (conversation_id)
WHERE conversation_id IS NOT NULL;

-- Reemplazo de idx_outbox_pending por índice alineado estrictamente a la consulta de reclamo FIFO
DROP INDEX IF EXISTS public.idx_outbox_pending;
CREATE INDEX IF NOT EXISTS idx_outbox_pending_fifo
ON public.outbox_messages (created_at ASC, next_retry_at)
WHERE status = 'PENDING';

-- Fencing token index en inbound_events para validación instantánea de lease
CREATE INDEX IF NOT EXISTS idx_inbound_events_processing_token
ON public.inbound_events (id, lock_token)
WHERE status = 'PROCESSING';

-- Índices para acelerar la purga de registros FAILED (> 90 días) en retentionService
CREATE INDEX IF NOT EXISTS idx_inbound_events_failed_created
ON public.inbound_events (created_at)
WHERE status = 'FAILED';

CREATE INDEX IF NOT EXISTS idx_outbox_messages_failed_created
ON public.outbox_messages (created_at)
WHERE status = 'FAILED';

-- Índice funcional alineado a la cláusula COALESCE(processed_at, created_at) de retentionService
CREATE INDEX IF NOT EXISTS idx_inbound_events_done_coalesce_processed
ON public.inbound_events (COALESCE(processed_at, created_at))
WHERE status = 'DONE';

-- ============================================================================
-- 4. TRIGGERS DE INTEGRIDAD Y REGLAS DE DOMINIO (Con search_path estricto)
-- ============================================================================
-- Garantía real de inmutabilidad en audit_log (prohibir UPDATE, DELETE y TRUNCATE)
CREATE OR REPLACE FUNCTION public.fn_prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Operación % prohibida: public.audit_log es estrictamente append-only.', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON public.audit_log;
CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
BEFORE TRUNCATE ON public.audit_log
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prevent_audit_log_mutation();

-- Actualización automática de timestamp en contacts.updated_at
CREATE OR REPLACE FUNCTION public.fn_touch_contacts_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON public.contacts;
CREATE TRIGGER trg_contacts_updated_at
BEFORE UPDATE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.fn_touch_contacts_updated_at();

-- ============================================================================
-- 5. STORAGE PARAMETERS (Ajuste de fillfactor para HOT Updates en PostgreSQL)
-- ============================================================================
-- Reserva de 25% de espacio en página para actualizaciones in-place sin escribir en índices
ALTER TABLE public.inbound_events SET (fillfactor = 75);
ALTER TABLE public.outbox_messages SET (fillfactor = 75);
ALTER TABLE public.conversations SET (fillfactor = 85);
ALTER TABLE public.contacts SET (fillfactor = 85);
