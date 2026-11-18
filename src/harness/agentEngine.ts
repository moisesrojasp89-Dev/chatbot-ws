import { ContactRecord, ConversationRecord } from '../types/states.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { geminiClient } from '../providers/llm/geminiClient.js';
import { GeminiContentMessage } from '../providers/llm/geminiTypes.js';
import { contextManager } from './contextManager.js';
import { guardrails } from './guardrails.js';
import { searchProductCatalog } from './tools/catalogTools.js';
import { createQualifiedLead } from './tools/leadTools.js';
import { requestHumanHandoff } from './tools/handoffTools.js';
import { logger } from '../utils/logger.js';

import { CreateQualifiedLeadArgs } from './tools/leadTools.js';
import { RequestHumanHandoffArgs } from './tools/handoffTools.js';

export interface AgentProcessOptions {
  deferSideEffects?: boolean;
  deadlineMs?: number;
  abortSignal?: AbortSignal;
}

export interface AgentProcessResult {
  replyText: string;
  catalogToolExecuted: boolean;
  leadToolExecuted: boolean;
  handoffToolExecuted: boolean;
  pendingLead?: CreateQualifiedLeadArgs;
  pendingHandoff?: RequestHumanHandoffArgs;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
}

export class AgentEngine {
  private readonly maxToolIterations = 3;

  /**
   * Orquesta el ciclo conversacional completo:
   * Guardrail N1 -> Context Assembly (F3-C4) -> ReAct Loop Gemini (máx 3) -> Guardrail N3/N4 -> Respuesta lista.
   * Si options.deferSideEffects es true, no escribe en BD durante la llamada LLM y retorna las acciones diferidas.
   * Si options.deadlineMs está presente, distribuye el presupuesto de tiempo garantizando no exceder el lease de inbound.
   */
  public async processMessage(
    contact: ContactRecord,
    conversation: ConversationRecord,
    incomingText: string,
    options?: AgentProcessOptions
  ): Promise<AgentProcessResult> {
    const startEngineTime = Date.now();

    // B6: Cancelación inmediata si el servidor solicitó apagado
    if (options?.abortSignal?.aborted) {
      const err = new Error('AbortError: Service shutdown requested');
      err.name = 'AbortError';
      throw err;
    }

    // 1. Guardrail Nivel 1: Filtro Pre-Inferencia Anti-Jailbreak (< 1ms)
    const preCheck = guardrails.checkPreInference(incomingText);
    if (!preCheck.passed && preCheck.sanitizedResponse) {
      logger.info({ contactId: contact.id }, 'Filtro Pre-Inferencia interceptó el mensaje del usuario');
      return {
        replyText: preCheck.sanitizedResponse,
        catalogToolExecuted: false,
        leadToolExecuted: false,
        handoffToolExecuted: false,
        promptTokens: 0,
        completionTokens: 0,
        totalLatencyMs: Date.now() - startEngineTime,
      };
    }

    // 2. Obtención de historial reciente (I11: ventana deslizante óptima de 6 mensajes) y ensamblaje de contexto
    const historyMessages = await messageRepository.getSlidingContextWindow(conversation.id, 6);
    const preparedContext = await contextManager.prepareContext(
      contact,
      conversation,
      historyMessages,
      incomingText
    );

    // Mensajes activos para el turno conversacional
    const activeMessages: GeminiContentMessage[] = preparedContext.contents.map((c) => ({
      role: c.role,
      parts: c.parts.map((p) => ({ text: p.text })),
    }));

    let catalogToolExecuted = false;
    let leadToolExecuted = false;
    let handoffToolExecuted = false;
    let pendingLead: CreateQualifiedLeadArgs | undefined;
    let pendingHandoff: RequestHumanHandoffArgs | undefined;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let finalBotText = '';

    // 3. ReAct Loop Acotado (Techo determinista: máximo 3 iteraciones de herramientas)
    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      let turnTimeout = 20000;
      if (options?.deadlineMs) {
        const remainingBudget = options.deadlineMs - Date.now();
        if (remainingBudget <= 5000) {
          logger.warn(
            { iteration, remainingBudget },
            '⏱️ Presupuesto de turno ReAct insuficiente (<=5000ms): cortando iteraciones para proteger lease'
          );
          break;
        }
        turnTimeout = Math.min(20000, remainingBudget);
      }

      if (options?.abortSignal?.aborted) {
        const err = new Error('AbortError: Service shutdown requested');
        err.name = 'AbortError';
        throw err;
      }

      const turnResult = await geminiClient.generateTurn(
        preparedContext.systemInstruction,
        activeMessages,
        turnTimeout,
        options?.abortSignal
      );

      totalPromptTokens += turnResult.promptTokens;
      totalCompletionTokens += turnResult.completionTokens;

      // Si el modelo decide invocar herramientas
      if (turnResult.functionCalls && turnResult.functionCalls.length > 0) {
        for (const call of turnResult.functionCalls) {
          logger.info({ toolName: call.name, iteration }, '🛠️ Modelo solicitó ejecución de Tool');

          if (call.name === 'searchProductCatalog') {
            const toolOutput = searchProductCatalog(call.args as any);
            catalogToolExecuted = true;

            activeMessages.push({
              role: 'model',
              parts: [{ functionCall: call }],
            });
            activeMessages.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'searchProductCatalog',
                    response: { result: toolOutput },
                  },
                },
              ],
            });
          } else if (call.name === 'createQualifiedLead') {
            const leadArgs: CreateQualifiedLeadArgs = {
              contactId: contact.id,
              conversationId: conversation.id,
              ...(call.args as any),
            };
            const toolOutput = await createQualifiedLead(leadArgs, { defer: options?.deferSideEffects });
            leadToolExecuted = true;
            if (options?.deferSideEffects) {
              pendingLead = leadArgs;
            }

            activeMessages.push({
              role: 'model',
              parts: [{ functionCall: call }],
            });
            activeMessages.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'createQualifiedLead',
                    response: { result: toolOutput },
                  },
                },
              ],
            });
          } else if (call.name === 'requestHumanHandoff') {
            const handoffArgs: RequestHumanHandoffArgs = {
              contactId: contact.id,
              conversationId: conversation.id,
              ...(call.args as any),
            };
            const toolOutput = await requestHumanHandoff(handoffArgs, { defer: options?.deferSideEffects });
            handoffToolExecuted = true;
            if (options?.deferSideEffects) {
              pendingHandoff = handoffArgs;
            }

            activeMessages.push({
              role: 'model',
              parts: [{ functionCall: call }],
            });
            activeMessages.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'requestHumanHandoff',
                    response: { result: toolOutput },
                  },
                },
              ],
            });
          }
        }
        // Continuar el bucle para que el modelo redacte el texto final fundamentado
        continue;
      }

      // Si el modelo respondió con texto directo sin tools
      finalBotText = turnResult.text;
      break;
    }

    // Si después de 3 iteraciones de herramientas aún no hay texto final, establecer fallback cortés
    if (!finalBotText && (catalogToolExecuted || leadToolExecuted || handoffToolExecuted)) {
      finalBotText =
        'He verificado la información en nuestro sistema. ¿En qué más puedo orientarte o deseas que un asesor te asista directamente?';
    }

    // 4. Guardrail Nivel 3: Grounding Lock (F3-C3)
    const groundingCheck = guardrails.checkGroundingLock(finalBotText, catalogToolExecuted);
    if (!groundingCheck.passed && groundingCheck.sanitizedResponse) {
      finalBotText = groundingCheck.sanitizedResponse;
    }

    // 5. Guardrail Nivel 4: Denylist Post-Inferencia
    const denylistCheck = guardrails.checkPostInferenceDenylist(finalBotText);
    if (!denylistCheck.passed && denylistCheck.sanitizedResponse) {
      finalBotText = denylistCheck.sanitizedResponse;
    }

    const totalLatencyMs = Date.now() - startEngineTime;

    return {
      replyText: finalBotText,
      catalogToolExecuted,
      leadToolExecuted,
      handoffToolExecuted,
      pendingLead,
      pendingHandoff,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalLatencyMs,
    };
  }
}

export const agentEngine = new AgentEngine();
