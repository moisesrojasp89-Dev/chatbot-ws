import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fase 2: Verificación de Esquema SQL & Migraciones', () => {
  it('001_initial_schema.sql debe existir y contener los constraints del TDD v2.1', async () => {
    const migrationPath = path.join(__dirname, '../src/database/migrations/001_initial_schema.sql');
    const sql = await fs.readFile(migrationPath, 'utf-8');

    // 1. Debe incluir las 6 tablas
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.contacts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.conversations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.messages');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.leads');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.handoff_sessions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.audit_log');

    // 2. F2-C1: conversation_id en messages debe ser NULLABLE (sin NOT NULL)
    expect(sql).toContain('conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL');

    // 3. F2-C2: Los 7 estados de la FSM deben estar en el CHECK constraint
    expect(sql).toContain("'IDLE', 'QUALIFYING', 'CATALOG_QUERY', 'BOOKING'");
    expect(sql).toContain("'CLOSING', 'CLOSED', 'HUMAN_ESCALATION'");

    // 4. C1: conversation_id debe estar en la tabla leads
    expect(sql).toContain('conversation_id UUID REFERENCES public.conversations(id)');

    // 5. Todos los índices deben ser idempotentes (IF NOT EXISTS)
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_contacts_phone');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_messages_wamid');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_leads_conversation');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_audit_log_conversation');
  });
});
