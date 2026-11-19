-- DESPLIEGUE: aplicar en ventana de mantenimiento (systemd single-VPS).
-- El código anterior usa ON CONFLICT (wamid); tras eliminar esa constraint,
-- una instancia vieja fallaría con 42P10. No hacer rolling deploy de esta migración.

-- Migración 015: identidad inbound multicanal.
--
-- Antes: inbound_events.wamid era único globalmente (vocabulario/identidad de WhatsApp).
-- Ahora: la idempotencia se define por la pareja (channel, wamid), donde `wamid`
-- actúa como identificador externo genérico del canal (wamid de Meta, update_id
-- de Telegram, mid de Instagram, etc.). El nombre de columna se conserva por
-- compatibilidad y se renombrará en una migración posterior.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inbound_events_wamid_key'
      AND conrelid = 'public.inbound_events'::regclass
  ) THEN
    ALTER TABLE public.inbound_events DROP CONSTRAINT inbound_events_wamid_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inbound_events_channel_wamid'
      AND conrelid = 'public.inbound_events'::regclass
  ) THEN
    ALTER TABLE public.inbound_events
      ADD CONSTRAINT uq_inbound_events_channel_wamid UNIQUE (channel, wamid);
  END IF;
END $$;

COMMENT ON COLUMN public.inbound_events.wamid IS
  'Identificador externo del mensaje dentro del canal (wamid Meta, update_id Telegram, mid Instagram...).';
