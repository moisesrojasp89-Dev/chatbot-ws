-- Migración 003: Resiliencia de Outbox, Reaper de Filas Huérfanas (B2)
-- Incorpora locked_at e índice parcial para recuperación de mensajes en PROCESSING

ALTER TABLE public.outbox_messages
ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_processing_locked
ON public.outbox_messages (status, locked_at)
WHERE status = 'PROCESSING';
