import { ContactRecord, ConversationRecord, MessageRecord } from '../types/states.js';
import { BusinessPack } from '../core/types.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { logger } from '../utils/logger.js';

export interface LlmContentTurn {
  role: 'user' | 'assistant';
  parts: Array<{ text: string }>;
}

export interface PreparedContext {
  systemInstruction: string;
  contents: LlmContentTurn[];
  summaryUpdated: boolean;
}

export const MASTER_SYSTEM_PROMPT = `<role>
Eres el Asistente Digital Corporativo y Ejecutivo de Ventas en el canal de mensajería de nuestra empresa.
Tu objetivo es responder de forma inmediata, amable, altamente profesional y humana a clientes y prospectos en Latinoamérica.
Conduces la conversación con naturalidad y precisión técnica para resolver dudas, brindar cotizaciones y cerrar oportunidades de venta.
</role>

<rules>
1. LEY DEL MICRO-MENSAJE: Respuestas cortas, concisas y directas (máximo 1 a 3 párrafos breves, menos de 90 palabras). El usuario lee desde la pantalla pequeña de un teléfono móvil, sin importar el canal.
2. GROUNDING ESTRICTO (CERO ALUCINACIÓN DE PRECIOS): Tienes PROHIBIDO inventar precios, planes, descuentos o inventario. Si el cliente pregunta por costos o productos, debes invocar siempre la herramienta de catálogo antes de responder cifras.
3. CALIFICACIÓN DE CLIENTES (LEADS): Cuando el prospecto exprese una necesidad concreta o intención comercial de contratar o comprar, solicita amablemente su correo electrónico y ciudad, e invoca inmediatamente la herramienta de registro de lead.
4. ESCALAMIENTO HUMANO: Si el cliente solicita hablar con una persona ("asesor", "humano", "agente"), presenta una queja o inconformidad grave, o su consulta no puede resolverse con el catálogo, invoca inmediatamente la herramienta de handoff y despídete amablemente confirmando que un especialista tomará la conversación.
5. TONO CÁLIDO Y PROFESIONAL: Habla en español latinoamericano neutro, educado y cercano. PROHIBIDO usar frases trilladas o robóticas de IA como "¡Excelente pregunta!", "¡Por supuesto!", "¡Qué maravilla!".
6. FORMATO DE MENSAJERÍA: Utiliza negritas con asteriscos (*ejemplo*) para resaltar palabras clave y saltos de línea claros. No utilices encabezados markdown como '#' o '##'.
7. REGLA ANTI-ALUCINACIÓN DE IDENTIDAD: Si {{CUSTOMER_NAME}} es "desconocido", NUNCA inventes un nombre ni utilices su número telefónico para dirigirte a él. Salúdalo cordialmente de manera abierta (ej: "¡Hola! Con mucho gusto...") o pregúntale cómo se llama si es pertinente.
8. CRÉDITO: PROHIBIDO afirmar que un crédito está aprobado, preaprobado o garantizado. Solo un asesor puede confirmarlo con documentación.
9. TEST DRIVE: una solicitud no es una cita confirmada. Di que queda sujeta a validación de disponibilidad y licencia.
10. DESCUENTOS Y URGENCIA: no inventes descuentos, promociones, "última unidad" ni fechas límite. Solo comunica lo que esté en el catálogo o autorice un asesor.
11. ALCANCE: solo atiendes temas del negocio (productos, precios, disponibilidad, citas, compras y atención). Si el usuario pide un tema ajeno, redirige amablemente en una frase y ofrece ayuda con el negocio; no debatas ni respondas ese tema.
</rules>

<context>
- Estado Actual de la Conversación (FSM): {{CURRENT_STATE}}
- Nombre Registrado del Cliente: {{CUSTOMER_NAME}}
- Resumen de Interacciones Previas: {{CONTEXT_SUMMARY}}
</context>`;

export class ContextManager {
  /**
   * Genera el System Prompt oficial reemplazando las variables contextuales.
   */
  public buildSystemInstruction(
    contact: ContactRecord,
    conversation: ConversationRecord,
    pack?: BusinessPack | null,
    channel?: string
  ): string {
    const isNameUnknown =
      !contact.profile_name ||
      contact.profile_name.trim().toLowerCase() === 'cliente' ||
      contact.profile_name.trim().toLowerCase() === 'desconocido';

    const customerName =
      isNameUnknown || !contact.profile_name ? 'desconocido' : contact.profile_name.trim();
    const contextSummary = conversation.context_summary?.trim() || 'Sin interacciones previas registradas.';

    let prompt = MASTER_SYSTEM_PROMPT;

    if (pack) {
      const rules = pack.prompt?.rules?.length
        ? `\n- ${pack.prompt.rules.join('\n- ')}`
        : '';
      prompt += `
<business_pack>
Empresa: ${pack.profile.name}
Rubro: ${pack.profile.vertical}
Idioma: ${pack.profile.language}
Tono: ${pack.profile.tone}
Zona horaria: ${pack.profile.timezone}
Reglas del negocio:${rules || ' ninguna adicional'}
</business_pack>`;
    }

    if (channel) {
      prompt += `\n<channel>${channel}</channel>`;
    }

    return prompt
      .replaceAll('{{CURRENT_STATE}}', conversation.current_state)
      .replaceAll('{{CUSTOMER_NAME}}', customerName)
      .replaceAll('{{CONTEXT_SUMMARY}}', contextSummary);
  }

  /**
   * F3-C4: Prepara la ventana deslizante de contexto de 6 mensajes.
   * Si la sesión contiene más de 6 mensajes, comprime los mensajes antiguos en un resumen
   * y lo persiste en `conversations.context_summary` (Opción A).
   */
  public async prepareContext(
    contact: ContactRecord,
    conversation: ConversationRecord,
    historyMessages: MessageRecord[],
    currentIncomingText: string,
    pack?: BusinessPack | null,
    channel?: string
  ): Promise<PreparedContext> {
    const systemInstruction = this.buildSystemInstruction(contact, conversation, pack, channel);
    let summaryUpdated = false;

    // Cronológico ascendente
    const sortedMessages = [...historyMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    let activeWindowMessages = sortedMessages;

    // F3-C4: Si hay más de 6 mensajes en el historial acumulado
    if (sortedMessages.length > 6) {
      const discarded = sortedMessages.slice(0, sortedMessages.length - 6);
      activeWindowMessages = sortedMessages.slice(-6);

      // Extraer datos clave de mensajes descartados (Opción A: extracción estructurada rápida)
      const discardedSummaries = discarded
        .map((m) => {
          const role = m.direction === 'INBOUND' ? 'Cliente' : 'Bot';
          const snippet = m.content.replace(/\n+/g, ' ').trim().slice(0, 60);
          return `${role}: ${snippet}`;
        })
        .join('; ');

      const existingSummary = conversation.context_summary?.trim() || '';
      const newSummaryFragment = `Historial previo (${discarded.length} msgs): ${discardedSummaries}`;
      
      const combinedSummary = existingSummary
        ? `${existingSummary} | ${newSummaryFragment}`.slice(-400)
        : newSummaryFragment.slice(-400);

      // Persistir el resumen en base de datos
      try {
        await conversationRepository.updateContextSummary(conversation.id, combinedSummary);
        conversation.context_summary = combinedSummary;
        summaryUpdated = true;
        logger.info(
          { conversationId: conversation.id, discardedCount: discarded.length },
          '📝 context_summary auto-generado y persistido por exceso de ventana (>6)'
        );
      } catch (err) {
        logger.warn({ err, conversationId: conversation.id }, 'No se pudo actualizar context_summary en DB');
      }
    }

    // Convertir mensajes al formato neutro de contenido LLM
    const contents: LlmContentTurn[] = activeWindowMessages.map((msg) => ({
      role: msg.direction === 'INBOUND' ? 'user' : 'assistant',
      parts: [{ text: msg.content }],
    }));

    // Agregar el mensaje actual del usuario al final si no estaba ya en la ventana
    const isCurrentAlreadyInHistory =
      contents.length > 0 &&
      contents[contents.length - 1].role === 'user' &&
      contents[contents.length - 1].parts[0]?.text === currentIncomingText;

    if (!isCurrentAlreadyInHistory && currentIncomingText) {
      contents.push({
        role: 'user',
        parts: [{ text: currentIncomingText }],
      });
    }

    return {
      systemInstruction,
      contents,
      summaryUpdated,
    };
  }
}

export const contextManager = new ContextManager();
