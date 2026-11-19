-- 016: Backfill de inbound_events al sobre normalizado
--
-- Los eventos persistidos antes de la Ola 2 guardaban el payload crudo de Meta
-- (`payload.message.*`). El dispatcher ahora consume el sobre normalizado
-- (`type`, `text`, `senderName`, `raw`). Esta migración es idempotente: solo
-- toca filas con shape legado y conserva el mensaje original en `raw`.
--
-- No cambia el esquema, pero SÍ requiere la misma ventana que la 015:
-- stop -> migrate (015 y 016) -> start. Ejecutarla con escritores viejos activos
-- dejaría filas posteriores al backfill con shape legado y el dispatcher nuevo
-- las leería sin texto. El guard de arranque exige 014, 015 y 016.
--
-- Rollback:
--   UPDATE inbound_events SET payload = payload -> 'raw'
--   WHERE payload ? 'raw' AND NOT (payload ? 'message');

UPDATE public.inbound_events
SET payload = jsonb_build_object(
  'channel', channel,
  'externalMessageId', wamid,
  'externalAccountId', phone_number_id,
  'senderId', sender_phone,
  'senderName', COALESCE(payload -> 'contact' -> 'profile' ->> 'name', 'Cliente'),
  'occurredAt', CASE
    WHEN payload -> 'message' ->> 'timestamp' ~ '^[0-9]+$'
      THEN to_char(
        (to_timestamp((payload -> 'message' ->> 'timestamp')::double precision) AT TIME ZONE 'UTC'),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ELSE to_char(
      created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  END,
  'type', COALESCE(payload -> 'message' ->> 'type', 'text'),
  'text', COALESCE(
    payload -> 'message' -> 'text' ->> 'body',
    payload -> 'message' -> 'interactive' -> 'button_reply' ->> 'title',
    payload -> 'message' -> 'interactive' -> 'list_reply' ->> 'title',
    ''
  ),
  'raw', COALESCE(payload -> 'message', payload)
)
WHERE payload ? 'message'
  AND NOT (payload ? 'type');
