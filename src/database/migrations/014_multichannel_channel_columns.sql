-- Migración 014: columna channel para desacoplar el esquema del adaptador de canal.
--
-- El núcleo deja de asumir WhatsApp en las colas: cada evento y mensaje saliente
-- declara su canal. El default 'whatsapp' mantiene compatibilidad con registros
-- existentes y con despliegues que aún solo usan Meta.

ALTER TABLE public.outbox_messages
  ADD COLUMN IF NOT EXISTS channel VARCHAR(32) NOT NULL DEFAULT 'whatsapp';

ALTER TABLE public.inbound_events
  ADD COLUMN IF NOT EXISTS channel VARCHAR(32) NOT NULL DEFAULT 'whatsapp';

COMMENT ON COLUMN public.outbox_messages.channel IS
  'Canal de salida (whatsapp, telegram, instagram, tiktok, webchat...).';
COMMENT ON COLUMN public.inbound_events.channel IS
  'Canal de origen del evento entrante.';

CREATE INDEX IF NOT EXISTS idx_outbox_channel_pending
  ON public.outbox_messages (channel, status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_inbound_channel_pending
  ON public.inbound_events (channel, status, created_at);
