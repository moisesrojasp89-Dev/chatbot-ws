import { ContactRecord, ConversationRecord } from '../types/states.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { llmClient } from '../providers/llm/llmClient.js';
import { LlmContentMessage } from '../providers/llm/llmTypes.js';
import { contextManager } from './contextManager.js';
import { guardrails } from './guardrails.js';
import { getActiveBusinessPack } from '../core/activePack.js';
import { buildSalesToolRegistry } from './salesToolRegistry.js';
import { checkSalesPolicy } from './salesGuardrails.js';
import { OFFICIAL_CATALOG } from './tools/catalogTools.js';
import { logger } from '../utils/logger.js';

import { CreateQualifiedLeadArgs } from './tools/leadTools.js';
import { RequestHumanHandoffArgs } from './tools/handoffTools.js';

export interface AgentProcessOptions {
  deferSideEffects?: boolean;
  deadlineMs?: number;
  abortSignal?: AbortSignal;
  channel?: string;
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
   * Guardrail N1 -> Context Assembly (F3-C4) -> ReAct Loop LLM (máx 3) -> Guardrail N3/N4 -> Respuesta lista.
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

    // 2. Perfil/catálogo activos y registro de tools
    const pack = await getActiveBusinessPack();
    const registry = buildSalesToolRegistry(pack);

    // 2.1 Guardrail de alcance: no responder temas ajenos al negocio
    const scopeCheck = guardrails.checkScope(
      incomingText,
      pack?.profile.name ?? 'Chatbot WS',
      pack?.profile.vertical
    );
    if (!scopeCheck.passed && scopeCheck.sanitizedResponse) {
      return {
        replyText: scopeCheck.sanitizedResponse,
        catalogToolExecuted: false,
        leadToolExecuted: false,
        handoffToolExecuted: false,
        promptTokens: 0,
        completionTokens: 0,
        totalLatencyMs: Date.now() - startEngineTime,
      };
    }

    // 3. Historial reciente y ensamblaje de contexto con el pack activo
    const historyMessages = await messageRepository.getSlidingContextWindow(conversation.id, 6);
    const preparedContext = await contextManager.prepareContext(
      contact,
      conversation,
      historyMessages,
      incomingText,
      pack,
      options?.channel
    );

    // Mensajes activos para el turno conversacional
    const activeMessages: LlmContentMessage[] = preparedContext.contents.map((c) => ({
      role: c.role,
      parts: c.parts.map((p) => ({ text: p.text })),
    }));

    let catalogToolExecuted = false;
    let leadToolExecuted = false;
    let handoffToolExecuted = false;
    let pendingLead: CreateQualifiedLeadArgs | undefined;
    let pendingHandoff: RequestHumanHandoffArgs | undefined;
    const executedTools = new Set<string>();
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

      const turnResult = await llmClient.generateTurn(
        preparedContext.systemInstruction,
        activeMessages,
        turnTimeout,
        options?.abortSignal,
        registry.list()
      );

      totalPromptTokens += turnResult.promptTokens;
      totalCompletionTokens += turnResult.completionTokens;

      // Si el modelo decide invocar herramientas
      if (turnResult.functionCalls && turnResult.functionCalls.length > 0) {
        for (const call of turnResult.functionCalls) {
          logger.info({ toolName: call.name, iteration }, '🛠️ Modelo solicitó ejecución de Tool');

          let definition;
          let toolOutput: unknown;
          let parsedInput: unknown;
          try {
            definition = registry.get(call.name);
            parsedInput = definition.inputSchema.parse(call.args);
            toolOutput = await registry.execute(call.name, parsedInput, {
              contactId: contact.id,
              conversationId: conversation.id,
              channel: options?.channel,
              deferSideEffects: options?.deferSideEffects,
            });
          } catch (toolError) {
            const message = toolError instanceof Error ? toolError.message : 'Tool execution failed';
            logger.warn({ toolName: call.name, message }, 'Tool inválida o fallida; se devuelve error al modelo');
            activeMessages.push({
              role: 'assistant',
              parts: [{ functionCall: call }],
            });
            activeMessages.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: call.name,
                    response: { error: message },
                  },
                },
              ],
            });
            continue;
          }

          executedTools.add(call.name);

          if (definition.effect === 'catalog') {
            catalogToolExecuted = true;
          } else if (definition.effect === 'lead') {
            leadToolExecuted = true;
            if (options?.deferSideEffects) {
              const leadFields = definition.leadArgs?.(parsedInput) ?? {};
              pendingLead = {
                ...(parsedInput as Omit<CreateQualifiedLeadArgs, 'contactId' | 'conversationId'>),
                ...leadFields,
                contactId: contact.id,
                conversationId: conversation.id,
              };
            }
          } else if (definition.effect === 'handoff') {
            handoffToolExecuted = true;
            if (options?.deferSideEffects) {
              pendingHandoff = {
                ...(parsedInput as Omit<RequestHumanHandoffArgs, 'contactId' | 'conversationId'>),
                contactId: contact.id,
                conversationId: conversation.id,
              };
            }
          }

          activeMessages.push({
            role: 'assistant',
            parts: [{ functionCall: call }],
          });
          activeMessages.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: call.name,
                  response: { result: toolOutput },
                },
              },
            ],
          });
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

    // 4. Verificación determinista de la respuesta final
    const allowedPrices = pack
      ? pack.catalog.map((item) => item.price)
      : OFFICIAL_CATALOG.map((item) => item.priceUSD);

    const evaluateFinalText = (
      text: string
    ): { passed: boolean; reason?: string; safeResponse: string } => {
      const groundingCheck = guardrails.checkGroundingLock(text, catalogToolExecuted);
      if (!groundingCheck.passed) {
        return {
          passed: false,
          reason: groundingCheck.violationReason ?? 'UNGROUNDED_PRICE_MENTION',
          safeResponse:
            groundingCheck.sanitizedResponse ??
            'No puedo confirmar ese dato sin verificarlo. ¿Me das el modelo o producto exacto?',
        };
      }

      const denylistCheck = guardrails.checkPostInferenceDenylist(text);
      if (!denylistCheck.passed) {
        return {
          passed: false,
          reason: denylistCheck.violationReason ?? 'DENYLIST_CONTENT_DETECTED',
          safeResponse:
            denylistCheck.sanitizedResponse ??
            'No puedo ayudarte con ese contenido. ¿Te ayudo con productos, precios o una cita?',
        };
      }

      const salesCheck = checkSalesPolicy(text, {
        catalogToolExecuted,
        leadToolExecuted,
        handoffToolExecuted,
        executedTools: Array.from(executedTools),
        allowedPrices,
      });
      if (!salesCheck.passed) {
        return {
          passed: false,
          reason: salesCheck.violationReason ?? 'SALES_POLICY_VIOLATION',
          safeResponse:
            salesCheck.sanitizedResponse ??
            'Déjame verificar ese dato antes de confirmártelo. ¿Me das un poco más de contexto?',
        };
      }

      return { passed: true, safeResponse: text };
    };

    let evaluation = evaluateFinalText(finalBotText);

    // 5. Reescritura acotada: una oportunidad para corregir sin perder el turno
    if (!evaluation.passed) {
      const remainingBudget = options?.deadlineMs
        ? options.deadlineMs - Date.now()
        : 20000;
      const blockedResponse = finalBotText.replace(/<\//g, '<\\/');
      const rewriteInstruction = `${preparedContext.systemInstruction}
<rewrite_instruction>
Tu respuesta anterior fue bloqueada por la política "${evaluation.reason}".
Respuesta bloqueada: <blocked_response>${blockedResponse}</blocked_response>
Reescribe esa respuesta usando SOLO hechos de las tools/catálogo o del conocimiento ya recuperado.
Si falta información, haz UNA sola pregunta de aclaración o deriva a un asesor.
No repitas la infracción. Mantén el idioma, el tono y la brevedad.
</rewrite_instruction>`;

      if (remainingBudget <= 0) {
        finalBotText = evaluation.safeResponse;
      } else {
      try {
        const rewrite = await llmClient.generateTurn(
          rewriteInstruction,
          activeMessages,
          Math.min(20000, remainingBudget),
          options?.abortSignal,
          []
        );
        totalPromptTokens += rewrite.promptTokens;
        totalCompletionTokens += rewrite.completionTokens;

        const rewritten = rewrite.text?.trim() ?? '';
        if (rewritten) {
          const rewrittenEvaluation = evaluateFinalText(rewritten);
          finalBotText = rewrittenEvaluation.passed
            ? rewritten
            : rewrittenEvaluation.safeResponse;
        } else {
          finalBotText = evaluation.safeResponse;
        }
      } catch (rewriteError) {
        logger.warn(
          { error: rewriteError instanceof Error ? rewriteError.message : 'unknown' },
          'Reescritura de guardrail falló; se usa respuesta segura'
        );
        finalBotText = evaluation.safeResponse;
      }
      }

      evaluation = evaluateFinalText(finalBotText);
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
