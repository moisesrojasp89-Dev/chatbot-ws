-- 018: Conversaciones aisladas por chat
--
-- Un mismo contacto puede hablar en varios grupos de Telegram. La conversación
-- (FSM, contexto, handoff, mensajes) debe aislarse por chat, no solo por contacto.
--
-- Compatibilidad: las conversaciones existentes se backfillean con el teléfono
-- del contacto, que es el chat de WhatsApp/privados. No requiere ventana
-- especial; el guard exige 018.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS chat_id VARCHAR(120);

-- Preferir el recipient_id real del último inbound de esa conversación (grupos
-- de Telegram de la Ola 3B) y caer al teléfono del contacto (WhatsApp/privados).
UPDATE public.conversations c
SET chat_id = COALESCE(
  (
    SELECT ie.recipient_id
    FROM public.inbound_events ie
    JOIN public.messages m ON m.wamid = ie.wamid
    WHERE m.conversation_id = c.id
      AND ie.recipient_id IS NOT NULL
    ORDER BY ie.created_at DESC
    LIMIT 1
  ),
  (
    SELECT ie.recipient_id
    FROM public.inbound_events ie
    WHERE ie.sender_phone = ct.phone_number
      AND ie.recipient_id IS NOT NULL
    ORDER BY ie.created_at DESC
    LIMIT 1
  ),
  ct.phone_number
)
FROM public.contacts ct
WHERE c.contact_id = ct.id
  AND c.chat_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_contact_chat
  ON public.conversations(contact_id, chat_id, last_interaction_at DESC);

-- Cierre defensivo de duplicados activos históricos antes del índice único.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY contact_id, chat_id
           ORDER BY last_interaction_at DESC, id DESC
         ) AS rn
  FROM public.conversations
  WHERE chat_id IS NOT NULL
    AND current_state <> 'CLOSED'
)
UPDATE public.conversations c
SET current_state = 'CLOSED', closed_at = NOW()
FROM ranked
WHERE c.id = ranked.id
  AND ranked.rn > 1;

-- Una sola conversación no cerrada por contacto+chat (evita carreras multi-worker).
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_contact_chat_active
  ON public.conversations(contact_id, chat_id)
  WHERE current_state <> 'CLOSED';
