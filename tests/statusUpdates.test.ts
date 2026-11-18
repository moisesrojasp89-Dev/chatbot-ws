import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/providers/database/dbClient.js';
import { messageRepository } from '../src/repositories/messageRepository.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';

describe('Fase 4: Ingesta de Webhook Status Updates de Meta', { timeout: 30000 }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const testPhone = '5511888880002';
  const testWamid = `wamid.HBgL_STATUS_TEST_${Date.now()}`;
  let contactId: string;
  let conversationId: string;

  function generateValidSignature(payloadString: string): string {
    const hmac = crypto.createHmac('sha256', env.META_APP_SECRET);
    return `sha256=${hmac.update(payloadString).digest('hex')}`;
  }

  beforeEach(async () => {
    app = await buildApp();

    // Crear contacto, conversación y mensaje base para probar actualizaciones
    const contact = await contactRepository.findOrCreate(testPhone, 'Status Test User');
    contactId = contact.id;
    const conversation = await conversationRepository.getOrCreateActiveSession(contactId);
    conversationId = conversation.id;

    // Crear mensaje OUTBOUND en estado queued
    await db.query(
      `
      INSERT INTO public.messages (
        wamid, conversation_id, direction, message_type, content, delivery_status
      )
      VALUES ($1, $2, 'OUTBOUND', 'text', 'Mensaje de prueba para status updates', 'queued');
    `,
      [testWamid, conversationId]
    );
  });

  afterEach(async () => {
    try {
      await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [testWamid]);
      await db.query(`DELETE FROM public.conversations WHERE id = $1;`, [conversationId]);
      await db.query(`DELETE FROM public.contacts WHERE id = $1;`, [contactId]);
    } catch {
      // Ignorar errores si se eliminaron en cascada
    }
  });

  describe('MessageRepository.updateDeliveryStatus', () => {
    it('debe actualizar el estado a sent', async () => {
      const updated = await messageRepository.updateDeliveryStatus(testWamid, 'sent');

      expect(updated).not.toBeNull();
      expect(updated?.delivery_status).toBe('sent');
      expect(updated?.delivered_at).toBeNull();
      expect(updated?.read_at).toBeNull();
    });

    it('debe actualizar el estado a delivered y registrar timestamp delivered_at', async () => {
      const now = new Date();
      const updated = await messageRepository.updateDeliveryStatus(testWamid, 'delivered', now);

      expect(updated).not.toBeNull();
      expect(updated?.delivery_status).toBe('delivered');
      expect(updated?.delivered_at).toBeDefined();
      expect(updated?.read_at).toBeNull();
    });

    it('debe actualizar el estado a read y garantizar delivered_at si estaba ausente', async () => {
      const now = new Date();
      const updated = await messageRepository.updateDeliveryStatus(testWamid, 'read', now);

      expect(updated).not.toBeNull();
      expect(updated?.delivery_status).toBe('read');
      expect(updated?.read_at).toBeDefined();
      expect(updated?.delivered_at).toBeDefined(); // Coherencia lógica: Si fue leído, fue entregado
    });

    it('debe actualizar el estado a failed', async () => {
      const updated = await messageRepository.updateDeliveryStatus(testWamid, 'failed');

      expect(updated).not.toBeNull();
      expect(updated?.delivery_status).toBe('failed');
    });

    it('Auditor 5A & I16: guard por rango monótono: sent no debe degradar delivered ni read', async () => {
      // 1. Mensaje pasa a delivered
      await messageRepository.updateDeliveryStatus(testWamid, 'delivered');
      let current = await messageRepository.findByWamid(testWamid);
      expect(current?.delivery_status).toBe('delivered');

      // 2. Worker tardío o webhook desordenado intenta actualizar a 'sent'
      const degraded = await messageRepository.updateDeliveryStatus(testWamid, 'sent');
      expect(degraded).toBeNull(); // Rechazado por guard monótono

      // 3. El estado en BD sigue siendo delivered
      current = await messageRepository.findByWamid(testWamid);
      expect(current?.delivery_status).toBe('delivered');

      // 4. Actualizar a 'read' sí es permitido (read > delivered)
      const upgraded = await messageRepository.updateDeliveryStatus(testWamid, 'read');
      expect(upgraded?.delivery_status).toBe('read');

      // 5. Intentar degradar de 'read' a 'delivered' es rechazado
      const degradeDelivered = await messageRepository.updateDeliveryStatus(testWamid, 'delivered');
      expect(degradeDelivered).toBeNull();
      current = await messageRepository.findByWamid(testWamid);
      expect(current?.delivery_status).toBe('read');
    });

    it('Auditor 5A & I16: carrera inversa: webhook delivered recibido antes de guardar outbound es absorbido', async () => {
      const earlyWamid = `wamid.HBgL_EARLY_${Date.now()}`;

      // 1. Meta entrega webhook 'delivered' ANTES de que el bot guarde el outbound en BD
      const earlyUpdate = await messageRepository.updateDeliveryStatus(earlyWamid, 'delivered');
      expect(earlyUpdate).toBeNull(); // La fila no existe aún en messages

      // 2. El evento quedó registrado en message_status_events
      const { rows } = await db.query(
        `SELECT * FROM public.message_status_events WHERE wamid = $1;`,
        [earlyWamid]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('delivered');

      // 3. Ahora el worker inserta el mensaje mediante saveOutboundMessage
      const inserted = await messageRepository.saveOutboundMessage({
        wamid: earlyWamid,
        conversationId,
        content: 'Mensaje con entrega anticipada por Meta',
      });

      // 4. Invariante: La fila nace directamente con delivery_status = 'delivered' y delivered_at poblado
      expect(inserted.delivery_status).toBe('delivered');
      expect(inserted.delivered_at).not.toBeNull();

      // Limpieza
      await db.query(`DELETE FROM public.message_status_events WHERE wamid = $1;`, [earlyWamid]);
      await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [earlyWamid]);
    });

    it('Auditor 5A & I16: guard de failed: solo permitido desde queued o sent, no desde delivered o read', async () => {
      // 1. Mensaje en queued recibe failed con errorDetails
      const failed = await messageRepository.updateDeliveryStatus(testWamid, 'failed', new Date(), {
        code: 131026,
        message: 'Message undeliverable',
      });
      expect(failed?.delivery_status).toBe('failed');
      expect(failed?.error_details).toEqual({ code: 131026, message: 'Message undeliverable' });

      // 2. Nuevo mensaje que ya fue delivered
      const deliveredWamid = `wamid.HBgL_DELIVERED_${Date.now()}`;
      await db.query(
        `INSERT INTO public.messages (wamid, conversation_id, direction, message_type, content, delivery_status)
         VALUES ($1, $2, 'OUTBOUND', 'text', 'Mensaje entregado', 'delivered');`,
        [deliveredWamid, conversationId]
      );

      // 3. Intentar marcar como failed un mensaje ya delivered
      const tryFailed = await messageRepository.updateDeliveryStatus(deliveredWamid, 'failed');
      expect(tryFailed).toBeNull(); // Rechazado: no puede fallar tras delivered

      const check = await messageRepository.findByWamid(deliveredWamid);
      expect(check?.delivery_status).toBe('delivered');

      // Limpieza
      await db.query(`DELETE FROM public.messages WHERE wamid = $1;`, [deliveredWamid]);
    });
  });

  describe('POST /webhook Status Updates Ingestion (End-to-End)', () => {
    it('debe procesar un evento delivered vía webhook y actualizar la base de datos', async () => {
      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_TEST_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '123456789',
                    phone_number_id: 'PHONE_NUMBER_ID',
                  },
                  statuses: [
                    {
                      id: testWamid,
                      status: 'delivered',
                      timestamp: Math.floor(Date.now() / 1000).toString(),
                      recipient_id: testPhone,
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const payloadString = JSON.stringify(statusPayload);
      const signature = generateValidSignature(payloadString);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadString,
      });

      // SLA acuse de recibo inmediato
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: 'ok' });

      // Esperar brevemente a que el background task impacte la DB en São Paulo
      await new Promise((r) => setTimeout(r, 1500));

      const recordInDb = await messageRepository.findByWamid(testWamid);
      expect(recordInDb?.delivery_status).toBe('delivered');
      expect(recordInDb?.delivered_at).not.toBeNull();
    });

    it('debe procesar un evento read vía webhook y actualizar la base de datos', async () => {
      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_TEST_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '123456789',
                    phone_number_id: 'PHONE_NUMBER_ID',
                  },
                  statuses: [
                    {
                      id: testWamid,
                      status: 'read',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: testPhone,
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const payloadString = JSON.stringify(statusPayload);
      const signature = generateValidSignature(payloadString);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: payloadString,
      });

      expect(response.statusCode).toBe(200);

      // Esperar brevemente a que el background task impacte la DB en São Paulo
      await new Promise((r) => setTimeout(r, 1500));

      const recordInDb = await messageRepository.findByWamid(testWamid);
      expect(recordInDb?.delivery_status).toBe('read');
      expect(recordInDb?.read_at).not.toBeNull();
      expect(recordInDb?.delivered_at).not.toBeNull();
    });
  });
});
