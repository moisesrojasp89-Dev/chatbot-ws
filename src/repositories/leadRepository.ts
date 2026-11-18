import { db } from '../providers/database/dbClient.js';
import { LeadRecord } from '../types/states.js';
import { logger } from '../utils/logger.js';

import { PoolClient } from 'pg';

export interface CreateLeadParams {
  contactId: string;
  conversationId?: string;
  productInterest: string;
  estimatedBudget?: number;
  qualificationStage?: 'COLD' | 'WARM' | 'HOT';
  extractedData?: Record<string, unknown>;
}

export class LeadRepository {
  /**
   * C1: Registra un lead comercial vinculado opcionalmente a la conversación donde se generó.
   */
  public async createLead(params: CreateLeadParams, client?: PoolClient): Promise<LeadRecord> {
    const query = `
      INSERT INTO public.leads (
        contact_id, conversation_id, product_interest,
        estimated_budget, qualification_stage, extracted_data
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [
      params.contactId,
      params.conversationId || null,
      params.productInterest,
      params.estimatedBudget || null,
      params.qualificationStage || 'COLD',
      params.extractedData ? JSON.stringify(params.extractedData) : '{}',
    ];
    const result = client ? await client.query(query, values) : await db.query(query, values);

    logger.info(
      { leadId: result.rows[0].id, contactId: params.contactId, product: params.productInterest },
      '🎯 Lead comercial calificado y guardado con trazabilidad'
    );
    return result.rows[0] as LeadRecord;
  }

  /**
   * Obtiene todos los leads de un contacto.
   */
  public async findByContactId(contactId: string): Promise<LeadRecord[]> {
    const query = `
      SELECT * FROM public.leads
      WHERE contact_id = $1
      ORDER BY captured_at DESC;
    `;
    const result = await db.query(query, [contactId]);
    return result.rows as LeadRecord[];
  }

  /**
   * Obtiene los leads generados en una conversación específica (C1).
   */
  public async findByConversationId(conversationId: string): Promise<LeadRecord[]> {
    const query = `
      SELECT * FROM public.leads
      WHERE conversation_id = $1
      ORDER BY captured_at DESC;
    `;
    const result = await db.query(query, [conversationId]);
    return result.rows as LeadRecord[];
  }
}

export const leadRepository = new LeadRepository();
