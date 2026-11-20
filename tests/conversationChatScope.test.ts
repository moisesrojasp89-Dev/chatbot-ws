import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../src/providers/database/dbClient.js';
import { contactRepository } from '../src/repositories/contactRepository.js';
import { conversationRepository } from '../src/repositories/conversationRepository.js';

const phone = `5511888${Math.floor(1000 + Math.random() * 9000)}`;

afterEach(async () => {
  try {
    await db.query(
      `DELETE FROM public.conversations WHERE contact_id IN (SELECT id FROM public.contacts WHERE phone_number = $1);`,
      [phone]
    );
    await db.query(`DELETE FROM public.contacts WHERE phone_number = $1;`, [phone]);
  } catch {
    // limpieza best-effort
  }
});

describe('Aislamiento conversacional por chat', () => {
  it('crea sesiones distintas para el mismo contacto en dos grupos', async () => {
    const contact = await contactRepository.findOrCreate(phone, 'Grupo Test');

    const groupA = await conversationRepository.getOrCreateActiveSession(contact.id, '-100A');
    const groupB = await conversationRepository.getOrCreateActiveSession(contact.id, '-100B');
    const groupAAgain = await conversationRepository.getOrCreateActiveSession(contact.id, '-100A');

    expect(groupA.id).not.toBe(groupB.id);
    expect(groupAAgain.id).toBe(groupA.id);
    expect(groupA.chat_id).toBe('-100A');
    expect(groupB.chat_id).toBe('-100B');
  });
});
