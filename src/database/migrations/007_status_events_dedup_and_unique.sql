-- Migración 007: Restricción UNIQUE en message_status_events (wamid, status, event_timestamp)
-- Permite ON CONFLICT DO NOTHING ante reenvíos de webhooks por Meta

DELETE FROM public.message_status_events a
USING public.message_status_events b
WHERE a.id > b.id
  AND a.wamid = b.wamid
  AND a.status = b.status
  AND a.event_timestamp = b.event_timestamp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_status_events_wamid_status_ts'
  ) THEN
    ALTER TABLE public.message_status_events
    ADD CONSTRAINT uq_status_events_wamid_status_ts UNIQUE (wamid, status, event_timestamp);
  END IF;
END $$;
