-- 017: Destinatario separado del remitente (grupos de Telegram)
--
-- Hasta ahora sender_phone se usaba tanto para identidad del contacto como
-- para el destinatario de la respuesta. En grupos, el remitente es from.id y
-- el destinatario es chat.id. Esta columna conserva ambos.
--
-- Compatibilidad: las filas existentes se backfillean con sender_phone.
-- No requiere ventana especial más allá de la 015/016, pero el guard exige 017.

ALTER TABLE public.inbound_events
  ADD COLUMN IF NOT EXISTS recipient_id VARCHAR(120);

UPDATE public.inbound_events
SET recipient_id = sender_phone
WHERE recipient_id IS NULL;
