-- Migración 005: Índice optimizado para el Reaper de Outbox
-- Agrega índice en locked_at filtrado por status = 'PROCESSING' para optimizar la consulta de expiración de lease

CREATE INDEX IF NOT EXISTS idx_outbox_reaper_locked_at
ON public.outbox_messages (locked_at)
WHERE status = 'PROCESSING';
