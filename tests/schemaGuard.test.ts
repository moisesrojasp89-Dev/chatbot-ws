import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { assertSchemaReady, SchemaValidationError } from '../src/database/schemaGuard.js';

const MIGRATIONS = [
  '014_multichannel_channel_columns.sql',
  '015_inbound_channel_identity.sql',
  '016_backfill_normalized_inbound_payload.sql',
  '017_inbound_recipient_id.sql',
  '018_conversations_chat_scope.sql',
];

const COLUMNS = [
  { table_name: 'inbound_events', column_name: 'channel' },
  { table_name: 'inbound_events', column_name: 'recipient_id' },
  { table_name: 'outbox_messages', column_name: 'channel' },
  { table_name: 'conversations', column_name: 'chat_id' },
];

const VALID_CONSTRAINT = [
  { conname: 'uq_inbound_events_channel_wamid', definition: 'UNIQUE (channel, wamid)' },
];

function mockQueries(migrations: unknown[], columns: unknown[], constraints: unknown[]): void {
  vi.spyOn(db, 'isHealthy').mockResolvedValue(true);
  vi.spyOn(db, 'query')
    .mockResolvedValueOnce({ rows: migrations } as never)
    .mockResolvedValueOnce({ rows: columns } as never)
    .mockResolvedValueOnce({ rows: constraints } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Guard de esquema al arranque', () => {
  it('pasa contra la base de pruebas migrada (014-018)', async () => {
    await expect(assertSchemaReady()).resolves.toBeUndefined();
  });

  it('falla con exactamente las dos migraciones faltantes si el historial está vacío', async () => {
    mockQueries([], COLUMNS, VALID_CONSTRAINT);

    const error = await assertSchemaReady().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    const issues = (error as SchemaValidationError).issues;
    expect(issues).toHaveLength(5);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('014_multichannel_channel_columns.sql'),
        expect.stringContaining('015_inbound_channel_identity.sql'),
        expect.stringContaining('016_backfill_normalized_inbound_payload.sql'),
        expect.stringContaining('017_inbound_recipient_id.sql'),
        expect.stringContaining('018_conversations_chat_scope.sql'),
      ])
    );
  });

  it('falla si falta la columna channel en outbox_messages', async () => {
    mockQueries(
      MIGRATIONS.map((filename) => ({ filename })),
      [
        { table_name: 'inbound_events', column_name: 'channel' },
        { table_name: 'inbound_events', column_name: 'recipient_id' },
        { table_name: 'conversations', column_name: 'chat_id' },
      ],
      VALID_CONSTRAINT
    );

    const error = await assertSchemaReady().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    const issues = (error as SchemaValidationError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('outbox_messages');
  });

  it('falla si sigue activa la unicidad legada UNIQUE(wamid)', async () => {
    mockQueries(
      MIGRATIONS.map((filename) => ({ filename })),
      COLUMNS,
      [
        ...VALID_CONSTRAINT,
        { conname: 'inbound_events_wamid_key', definition: 'UNIQUE (wamid)' },
      ]
    );

    const error = await assertSchemaReady().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    const issues = (error as SchemaValidationError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('UNIQUE(wamid)');
  });

  it('falla con mensaje de conexión si la base no responde', async () => {
    vi.spyOn(db, 'isHealthy').mockResolvedValueOnce(false);

    const error = await assertSchemaReady().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    expect((error as SchemaValidationError).issues).toHaveLength(1);
    expect((error as SchemaValidationError).issues[0]).toContain('conectar a PostgreSQL');
  });
  it('incluye la causa real si falla la lectura del historial', async () => {
    vi.spyOn(db, 'isHealthy').mockResolvedValue(true);
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('permission denied for table migrations_history'));

    const error = await assertSchemaReady().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SchemaValidationError);
    expect((error as SchemaValidationError).issues.some((issue) => issue.includes('permission denied'))).toBe(true);
  });
});
