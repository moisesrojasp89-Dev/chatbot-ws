-- Migración 002: Outbox Pattern, Telemetría y Estados de Entrega (Fase 4)
-- Incorpora correcciones de auditoría F4-C4 (prompt_tokens, completion_tokens, latency_ms)

CREATE TABLE IF NOT EXISTS public.outbox_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    phone_number_id VARCHAR(50) NOT NULL,
    recipient_phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ DEFAULT NOW(),
    wamid VARCHAR(120),
    sent_at TIMESTAMPTZ,
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    latency_ms INT DEFAULT 0,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice parcial para polling eficiente con SKIP LOCKED
CREATE INDEX IF NOT EXISTS idx_outbox_pending
ON public.outbox_messages (status, next_retry_at)
WHERE status = 'PENDING';

-- Columnas de trazabilidad de entrega en la tabla de mensajes
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'queued',
ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
ON public.messages (delivery_status);
