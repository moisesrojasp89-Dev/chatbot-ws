-- Migración 006: Head-of-Line Claim Index y Tabla Append-Only de Eventos de Estado (Fase 5A)
-- 1. Índice parcial para reclamo ordenado estricto por destinatario (1 por lote)
CREATE INDEX IF NOT EXISTS idx_outbox_recipient_head
ON public.outbox_messages (phone_number_id, recipient_phone, created_at)
WHERE status IN ('PENDING', 'PROCESSING');

-- 2. Tabla append-only para eventos de estado de entrega de Meta (I16)
-- Resuelve la carrera inversa donde 'delivered' llega antes de que el worker inserte el outbound
CREATE TABLE IF NOT EXISTS public.message_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wamid TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  raw_payload JSONB,
  event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_events_wamid ON public.message_status_events (wamid);

-- 3. Columna de error_details en messages si no existe
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS error_details JSONB;
