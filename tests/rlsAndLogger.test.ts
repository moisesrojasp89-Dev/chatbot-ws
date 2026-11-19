import { describe, it, expect } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import pino from 'pino';
import { getLoggerOptions } from '../src/utils/logger.js';
import { Writable } from 'node:stream';

describe('Fase 5B: Seguridad RLS (I20) y Sanitización de PII en Logs (I20 / B7 / T6 / T8)', () => {
  describe('Criterio 5 (I20 / T6): Row Level Security y Privilegios en Tablas de Backend', () => {
    it('debe tener Row Level Security (RLS) habilitado en todas las tablas sensibles de public', async () => {
      const res = await db.query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'contacts', 'conversations', 'messages', 'message_status_events',
            'outbox_messages', 'inbound_events', 'leads', 'handoff_sessions', 'audit_log'
          );
      `);

      expect(res.rows.length).toBe(9);
      for (const row of res.rows) {
        expect(row.rowsecurity).toBe(true);
      }
    });

    it('Auditor 5B: no debe existir ninguna tabla en schema public con rowsecurity = false', async () => {
      const res = await db.query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND rowsecurity = false;
      `);

      expect(res.rows).toEqual([]);
    });

    it('T6: has_table_privilege(anon, tablename, SELECT) debe ser false para todas las tablas de public (REVOKE explícito)', async () => {
      const tables = [
        'contacts',
        'conversations',
        'messages',
        'message_status_events',
        'outbox_messages',
        'inbound_events',
        'leads',
        'handoff_sessions',
        'audit_log',
      ];
      for (const table of tables) {
        const res = await db.query(
          `SELECT has_table_privilege('anon', 'public.' || $1, 'SELECT') as priv;`,
          [table]
        );
        expect(res.rows[0].priv).toBe(false);
      }
    });

    it('T6: RLS aislada (otorgando SELECT a anon dentro de tx): SELECT devuelve [] demostrando que RLS filtra sola', async () => {
      const testWamid = `wamid.RLS_ISOLATED_${Date.now()}`;
      await db.query(
        `INSERT INTO public.messages (wamid, direction, message_type, content) VALUES ($1, 'INBOUND', 'text', 'Confidencial') ON CONFLICT DO NOTHING;`,
        [testWamid]
      );

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        // Quitar temporalmente la barrera del REVOKE dentro de tx para que la consulta llegue directamente a la política RLS
        await client.query(`GRANT SELECT ON public.messages TO anon;`);
        await client.query(`SET LOCAL ROLE anon;`);

        // La consulta se ejecuta sin error de permiso pero RLS filtra todas las filas devolviendo []
        const res = await client.query(`SELECT * FROM public.messages WHERE wamid = $1;`, [testWamid]);
        expect(res.rows).toEqual([]);
      } finally {
        // C6: Garantizar que el GRANT de la transacción se revierta siempre mediante ROLLBACK en finally
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [testWamid]);
      }
    });

    it('T6: Privilegios por defecto: una nueva tabla creada en public no otorga acceso a anon por default', async () => {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query('CREATE TABLE public.tmp_default_priv_test (id serial primary key, secret text);');
        const res = await client.query(
          `SELECT has_table_privilege('anon', 'public.tmp_default_priv_test', 'SELECT') as priv;`
        );
        expect(res.rows[0].priv).toBe(false);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('T6: las consultas directas ejecutadas bajo el rol anon deben fallar estrictamente con permission denied', async () => {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE anon;');

        await expect(client.query('SELECT * FROM public.messages LIMIT 1;')).rejects.toThrow(
          /permission denied/
        );
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('el rol de conexión del backend (postgres) debe seguir operando con normalidad (BYPASSRLS)', async () => {
      const wamid = `wamid.BACKEND_OP_${Date.now()}`;
      await db.query(`
        INSERT INTO public.messages (wamid, direction, message_type, content)
        VALUES ($1, 'INBOUND', 'text', 'Operación normal backend');
      `, [wamid]);

      const res = await db.query(`SELECT * FROM public.messages WHERE wamid = $1;`, [wamid]);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].content).toBe('Operación normal backend');

      await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [wamid]);
    });

    it('C6: PostgREST /rest/v1/messages con anon key debe ser rechazado (401 o 403) tras REVOKE de anon', async () => {
      const supabaseUrl = process.env.SUPABASE_URL;
      if (!supabaseUrl) return;
      const anonKey = process.env.SUPABASE_ANON_KEY;
      if (anonKey) {
        const response = await fetch(`${supabaseUrl}/rest/v1/messages`, {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
        });
        expect([401, 403]).toContain(response.status);
      } else {
        const response = await fetch(`${supabaseUrl}/rest/v1/messages`, {
          headers: { apikey: 'invalid_anon_key' },
        });
        expect([401, 403]).toContain(response.status);
      }
    });
  });

  describe('Criterio 6 (B7 / T8): Sanitización de PII y Stack en Logs', () => {
    it('T8: Loguear un Error con teléfono, token y payload sanitiza el stack trace y detalle de pg sin fugas', async () => {
      const logs: string[] = [];
      const capturingStream = new Writable({
        write(chunk, _encoding, callback) {
          logs.push(chunk.toString());
          callback();
        },
      });

      const testLogger = pino(getLoggerOptions(), capturingStream);

      // 1. Error con teléfono, token y contenido confidencial en mensaje y stack
      const leakPhone = '+5511988884321';
      const leakToken = 'lock_token=b9e59d9c-1111-2222-3333-444455556666';
      const leakContent = 'Texto confidencial del cliente tarjeta de credito';
      const sensitiveError = new Error(
        `Fallo al procesar mensaje de ${leakPhone} con ${leakToken} y cuerpo "${leakContent}"`
      );

      testLogger.error({ err: sensitiveError }, 'Error durante el despacho');
      testLogger.error(sensitiveError, 'Error directo de llamada');

      // 2. Error de Postgres con detail y where
      const pgError = new Error('duplicate key value violates unique constraint');
      Object.assign(pgError, {
        code: '23505',
        detail: 'Key (phone)=(+5511988884321) already exists.',
        where: 'PL/pgSQL function trigger_inbound_insert line 5',
        query: 'INSERT INTO contacts (phone) VALUES (+5511988884321)',
      });
      testLogger.error({ err: pgError }, 'Error Postgres en trigger');

      const fullLogOutput = logs.join('\n');

      // B7 & T8: Verificación estricta: NINGÚN teléfono completo debe existir en el log
      expect(fullLogOutput).not.toContain('+5511988884321');
      expect(fullLogOutput).not.toContain('5511988884321');

      // B7 & T8: NINGÚN token completo debe existir en el log
      expect(fullLogOutput).not.toContain('b9e59d9c-1111-2222-3333-444455556666');

      // B7 & T8: NINGÚN contenido sensible debe existir en el log
      expect(fullLogOutput).not.toContain(leakContent);

      // B7 & T8: Postgres detail, where y query censurados
      expect(fullLogOutput).not.toContain('Key (phone)');
      expect(fullLogOutput).not.toContain('PL/pgSQL');
      expect(fullLogOutput).not.toContain('INSERT INTO contacts');
    });

    it('B7: maskPhoneNumber conserva únicamente los últimos 4 dígitos visibles', async () => {
      const logs: string[] = [];
      const capturingStream = new Writable({
        write(chunk, _encoding, callback) {
          logs.push(chunk.toString());
          callback();
        },
      });

      const testLogger = pino(getLoggerOptions(), capturingStream);
      testLogger.info({ senderPhone: '5511987654321', recipient: '+573001234567' }, 'Prueba de teléfonos');

      const fullLogOutput = logs.join('\n');
      expect(fullLogOutput).toContain('****4321');
      expect(fullLogOutput).toContain('****4567');
      expect(fullLogOutput).not.toContain('55119');
      expect(fullLogOutput).not.toContain('57300');
    });

    it('C6 / I20: debe enmascarar tokens (Bearer, apiKey, headers.authorization), claves de contenido y errores de Meta API', async () => {
      const logs: string[] = [];
      const capturingStream = new Writable({
        write(chunk, _encoding, callback) {
          logs.push(chunk.toString());
          callback();
        },
      });

      const testLogger = pino(getLoggerOptions(), capturingStream);

      // 1. Log con tokens y secretos
      testLogger.info(
        {
          token: 'EAAB_SECRET_META_TOKEN_123456789',
          lockToken: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
          apiKey: 'sk-SECRET_LLM_KEY_9999',
          headers: { authorization: 'Bearer secret_auth_jwt_token' },
        },
        'Tokens de autenticación'
      );

      // 2. Log con claves de contenido
      testLogger.info(
        {
          content: 'Quiero comprar el Plan Pro inmediatamente con mi tarjeta',
          preview: 'Quiero comprar el Plan',
          userMessagePreview: 'Texto confidencial del usuario',
          rawBody: '{"text":"Cuerpo completo con datos sensibles"}',
        },
        'Mensajes capturados'
      );

      // 3. Log con objeto de error de Meta API (Axios style)
      const metaError = new Error('Request failed with status code 401');
      Object.assign(metaError, {
        config: {
          url: 'https://graph.facebook.com/v20.0/messages',
          headers: { Authorization: 'Bearer EAAB_META_PRIVATE_ACCESS_TOKEN' },
        },
        response: {
          status: 401,
          data: { error: { message: 'Invalid OAuth access token' } },
        },
      });
      testLogger.error({ err: metaError }, 'Fallo de llamada a Meta API');

      const fullLogOutput = logs.join('\n');

      // Tokens censurados
      expect(fullLogOutput).not.toContain('EAAB_SECRET_META_TOKEN_123456789');
      expect(fullLogOutput).not.toContain('sk-SECRET_LLM_KEY_9999');
      expect(fullLogOutput).not.toContain('EAAB_META_PRIVATE_ACCESS_TOKEN');
      expect(fullLogOutput).not.toContain('secret_auth_jwt_token');

      // Claves de contenido censuradas
      expect(fullLogOutput).not.toContain('Quiero comprar el Plan Pro inmediatamente con mi tarjeta');
      expect(fullLogOutput).not.toContain('Texto confidencial del usuario');
      expect(fullLogOutput).not.toContain('Cuerpo completo con datos sensibles');
    });
  });
});
