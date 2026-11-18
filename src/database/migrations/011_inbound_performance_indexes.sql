-- Migración 011: Índices de alto rendimiento para Inbound Claim, Reaper, Purga y Auditoría (B8)
-- Diseñados para que el optimizador de consultas evite escaneos secuenciales en tablas con >10,000 registros.

-- 1. Reemplazar índice parcial restrictivo por uno que incluya tanto PENDING como PROCESSING (B8)
DROP INDEX IF EXISTS public.idx_inbound_events_head;
CREATE INDEX idx_inbound_events_head ON public.inbound_events (phone_number_id, sender_phone, created_at)
  WHERE status IN ('PENDING','PROCESSING');

-- 2. Índice para acelerar el reaper sobre eventos colgados en PROCESSING
CREATE INDEX IF NOT EXISTS idx_inbound_events_processing_locked ON public.inbound_events (locked_at) 
  WHERE status = 'PROCESSING';

-- 3. Índice para acelerar la purga periódica LGPD de eventos completados
CREATE INDEX IF NOT EXISTS idx_inbound_events_done_processed ON public.inbound_events (processed_at) 
  WHERE status = 'DONE';

-- 4. Índice para acelerar la purga de outbox_messages completados
CREATE INDEX IF NOT EXISTS idx_outbox_messages_sent_created ON public.outbox_messages (created_at) 
  WHERE status = 'SENT';

-- 5. Índices para retención y ordenamiento temporal de mensajes y eventos de estado
CREATE INDEX IF NOT EXISTS idx_messages_created ON public.messages (created_at);
CREATE INDEX IF NOT EXISTS idx_message_status_events_created ON public.message_status_events (created_at);
