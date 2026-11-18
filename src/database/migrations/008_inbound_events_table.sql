-- Migración 008: Tabla inbound_events para Inbound Durable (I18)
-- Permite persistencia estricta antes del ACK HTTP 200 a Meta WhatsApp API

CREATE TABLE IF NOT EXISTS public.inbound_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wamid TEXT UNIQUE NOT NULL,
    phone_number_id TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
    locked_at TIMESTAMPTZ NULL,
    lock_token UUID NULL,
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL
);

-- Índice parcial para reclamo de cabeza por remitente (Head-of-Line por usuario)
CREATE INDEX IF NOT EXISTS idx_inbound_events_head
ON public.inbound_events (phone_number_id, sender_phone, created_at)
WHERE status = 'PENDING';

-- Índice parcial para sondeo rápido de candidatos elegibles
CREATE INDEX IF NOT EXISTS idx_inbound_events_status
ON public.inbound_events (status, next_retry_at)
WHERE status = 'PENDING';
