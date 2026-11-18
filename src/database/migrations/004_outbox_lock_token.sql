-- Migración 004: Fencing Token estricto con UUID para Outbox
-- Elimina tolerancias temporales y previene sobrescrituras y envíos duplicados

ALTER TABLE public.outbox_messages
ADD COLUMN IF NOT EXISTS lock_token UUID;

CREATE INDEX IF NOT EXISTS idx_outbox_processing_token
ON public.outbox_messages (id, lock_token)
WHERE status = 'PROCESSING';
