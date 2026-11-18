import { db } from '../providers/database/dbClient.js';
import { ContactRecord, ContactStatus } from '../types/states.js';
import { logger } from '../utils/logger.js';

export class ContactRepository {
  /**
   * F2-C4: Busca un contacto por número o lo crea de forma atómica.
   * Utiliza COALESCE para no sobrescribir nombres existentes con valores nulos.
   */
  public async findOrCreate(phoneNumber: string, profileName?: string): Promise<ContactRecord> {
    const query = `
      INSERT INTO public.contacts (phone_number, profile_name)
      VALUES ($1, $2)
      ON CONFLICT (phone_number) DO UPDATE SET
        profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
        updated_at = NOW()
      RETURNING *;
    `;
    const result = await db.query(query, [phoneNumber, profileName || null]);
    return result.rows[0] as ContactRecord;
  }

  /**
   * Busca un contacto por su número E.164.
   */
  public async findByPhone(phoneNumber: string): Promise<ContactRecord | null> {
    const query = `SELECT * FROM public.contacts WHERE phone_number = $1 LIMIT 1;`;
    const result = await db.query(query, [phoneNumber]);
    return (result.rows[0] as ContactRecord) || null;
  }

  /**
   * Busca un contacto por UUID.
   */
  public async findById(id: string): Promise<ContactRecord | null> {
    const query = `SELECT * FROM public.contacts WHERE id = $1 LIMIT 1;`;
    const result = await db.query(query, [id]);
    return (result.rows[0] as ContactRecord) || null;
  }

  /**
   * Actualiza el estado del contacto (BOT_ACTIVE, HUMAN_HANDOFF, OPTED_OUT).
   */
  public async updateStatus(id: string, status: ContactStatus): Promise<ContactRecord | null> {
    const query = `
      UPDATE public.contacts
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const result = await db.query(query, [status, id]);
    logger.info({ contactId: id, status }, 'Estado del contacto actualizado');
    return (result.rows[0] as ContactRecord) || null;
  }

  /**
   * Actualiza metadatos comerciales del contacto (etiquetas, presupuesto, CRM ID).
   */
  public async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<ContactRecord | null> {
    const query = `
      UPDATE public.contacts
      SET metadata = metadata || $1::jsonb, updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const result = await db.query(query, [JSON.stringify(metadata), id]);
    return (result.rows[0] as ContactRecord) || null;
  }
}

export const contactRepository = new ContactRepository();
