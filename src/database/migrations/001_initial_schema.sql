-- Migración 001: Esquema Inicial de Chatbot WS
-- Definición formal según TDD V2.1 con correcciones de auditoría (F2-C1, F2-C2, M1)

-- 1. Habilitar extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabla de Contactos
CREATE TABLE IF NOT EXISTS public.contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(20) NOT NULL UNIQUE,
    profile_name VARCHAR(100),
    full_name VARCHAR(150),
    status VARCHAR(20) NOT NULL DEFAULT 'BOT_ACTIVE' 
        CHECK (status IN ('BOT_ACTIVE', 'HUMAN_HANDOFF', 'OPTED_OUT')),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts(phone_number);

-- 3. Tabla de Conversaciones (Sesiones FSM)
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    current_state VARCHAR(30) NOT NULL DEFAULT 'IDLE'
        CHECK (current_state IN (
            'IDLE', 'QUALIFYING', 'CATALOG_QUERY', 'BOOKING',
            'CLOSING', 'CLOSED', 'HUMAN_ESCALATION'
        )),
    context_summary TEXT DEFAULT '',
    total_messages_count INT NOT NULL DEFAULT 0,
    last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_active ON public.conversations(contact_id, last_interaction_at DESC);

-- 4. Tabla de Mensajes (Idempotencia por wamid)
-- F2-C1: conversation_id es NULLABLE para permitir deduplicación atómica en Gateway antes de crear sesión
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wamid VARCHAR(120) NOT NULL UNIQUE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    message_type VARCHAR(20) NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    raw_payload JSONB DEFAULT '{}'::jsonb,
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    latency_ms INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_wamid ON public.messages(wamid);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id, created_at ASC);

-- 5. Tabla de Leads Comerciales Capturados
CREATE TABLE IF NOT EXISTS public.leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    product_interest VARCHAR(120),
    estimated_budget NUMERIC(12, 2),
    qualification_stage VARCHAR(20) NOT NULL DEFAULT 'COLD'
        CHECK (qualification_stage IN ('COLD', 'WARM', 'HOT')),
    extracted_data JSONB DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_contact ON public.leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_conversation ON public.leads(conversation_id);

-- 6. Tabla de Sesiones de Human Handoff (Escalamiento a Asesores)
CREATE TABLE IF NOT EXISTS public.handoff_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    trigger_reason VARCHAR(30) NOT NULL 
        CHECK (trigger_reason IN ('USER_REQUEST', 'FRUSTRATION', 'TOOL_FAILURE', 'OUT_OF_SCOPE')),
    ai_briefing_for_agent TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ASSIGNED', 'RESOLVED', 'TIMEOUT')),
    assigned_agent_email VARCHAR(120),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_handoff_pending ON public.handoff_sessions(status) WHERE status = 'PENDING';

-- 7. Tabla de Registro de Auditoría (Append-Only M1)
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,
    actor VARCHAR(20) NOT NULL CHECK (actor IN ('USER', 'BOT', 'AGENT', 'SYSTEM')),
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_conversation ON public.audit_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log(created_at DESC);
