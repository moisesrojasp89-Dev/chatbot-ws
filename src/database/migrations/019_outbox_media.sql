-- 019_outbox_media.sql
-- Media saliente: URL pública de la imagen/documento a enviar por el canal.
-- El contenido textual sigue en `content` (caption o texto de respaldo).

ALTER TABLE public.outbox_messages
  ADD COLUMN IF NOT EXISTS media_url TEXT;

COMMENT ON COLUMN public.outbox_messages.media_url IS
  'URL pública del media saliente (image/document/video/audio); NULL para texto.';
