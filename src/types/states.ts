import { CONSTANTS } from '../config/constants.js';

export type FSMState = typeof CONSTANTS.FSM_STATES[keyof typeof CONSTANTS.FSM_STATES];
export type ContactStatus = typeof CONSTANTS.CONTACT_STATUS[keyof typeof CONSTANTS.CONTACT_STATUS];

/**
 * I13: Matriz de transiciones legales de la máquina de estados finitos (FSM).
 * HUMAN_ESCALATION y CLOSED son alcanzables globalmente por seguridad y cierre de sesión.
 */
export const VALID_FSM_TRANSITIONS: Record<FSMState, readonly FSMState[]> = {
  IDLE: ['QUALIFYING', 'CATALOG_QUERY', 'BOOKING', 'CLOSING', 'CLOSED', 'HUMAN_ESCALATION'],
  QUALIFYING: ['CATALOG_QUERY', 'BOOKING', 'CLOSING', 'CLOSED', 'HUMAN_ESCALATION', 'IDLE'],
  CATALOG_QUERY: ['QUALIFYING', 'BOOKING', 'CLOSING', 'CLOSED', 'HUMAN_ESCALATION', 'IDLE'],
  BOOKING: ['CLOSING', 'CLOSED', 'HUMAN_ESCALATION', 'QUALIFYING', 'IDLE'],
  CLOSING: ['CLOSED', 'HUMAN_ESCALATION', 'QUALIFYING', 'IDLE'],
  CLOSED: ['IDLE'],
  HUMAN_ESCALATION: ['CLOSED', 'IDLE', 'QUALIFYING'],
} as const;

export function isValidFSMTransition(from: FSMState, to: FSMState): boolean {
  const allowed = VALID_FSM_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface ContactRecord {
  id: string;
  phone_number: string;
  profile_name: string | null;
  full_name: string | null;
  status: ContactStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationRecord {
  id: string;
  contact_id: string;
  current_state: FSMState;
  context_summary: string;
  total_messages_count: number;
  last_interaction_at: Date;
  closed_at: Date | null;
}

export interface MessageRecord {
  id: string;
  wamid: string;
  conversation_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  message_type: string;
  content: string;
  raw_payload: Record<string, unknown>;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  delivery_status?: string;
  delivered_at?: Date | null;
  read_at?: Date | null;
  created_at: Date;
}

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface OutboxRecord {
  id: string;
  channel?: string;
  conversation_id: string | null;
  phone_number_id: string;
  recipient_phone: string;
  message_type: string;
  content: string;
  status: OutboxStatus;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  next_retry_at: Date;
  wamid: string | null;
  sent_at: Date | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  locked_at: Date | null;
  lock_token?: string | null;
  created_at: Date;
}

export interface LeadRecord {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  product_interest: string;
  estimated_budget: number | null;
  qualification_stage: 'COLD' | 'WARM' | 'HOT';
  extracted_data: Record<string, unknown>;
  captured_at: Date;
}

export interface HandoffRecord {
  id: string;
  conversation_id: string;
  trigger_reason: 'USER_REQUEST' | 'FRUSTRATION' | 'TOOL_FAILURE' | 'OUT_OF_SCOPE';
  ai_briefing_for_agent: string;
  status: 'PENDING' | 'ASSIGNED' | 'RESOLVED' | 'TIMEOUT';
  assigned_agent_email: string | null;
  triggered_at: Date;
  resolved_at: Date | null;
}

export interface AuditRecord {
  id: string;
  conversation_id: string | null;
  event_type: string;
  actor: 'USER' | 'BOT' | 'AGENT' | 'SYSTEM';
  payload: Record<string, unknown>;
  created_at: Date;
}
