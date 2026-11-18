-- Migración 009: Habilitación de Row Level Security (RLS) en tablas de backend (I20)
-- Impide exposición de datos de clientes a roles públicos o anónimos vía PostgREST / Supabase API

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- No se declaran políticas permisivas para anon ni authenticated en estas tablas internas.
-- El backend Node.js se conecta directamente como superusuario o rol de servicio (postgres/service_role),
-- el cual opera normalmente con BYPASSRLS.
