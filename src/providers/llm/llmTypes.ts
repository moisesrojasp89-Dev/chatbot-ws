/**
 * Tipos neutros de la capa LLM.
 *
 * No pertenecen a ningún proveedor: describen el contrato interno que usa el
 * harness (mensajes, tools y resultado de un turno). El cliente HTTP concreto
 * (API compatible con OpenAI) adapta este contrato al wire format del proveedor
 * configurado mediante LLM_BASE_URL + LLM_MODEL.
 */

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
    }
  >;
  required?: string[];
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

export interface FunctionCallPart {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmContentMessage {
  role: 'user' | 'assistant';
  parts: Array<{
    text?: string;
    functionCall?: FunctionCallPart;
    functionResponse?: {
      name: string;
      response: Record<string, unknown>;
    };
  }>;
}

export interface LlmCompletionResult {
  text: string;
  functionCalls?: FunctionCallPart[];
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  finishReason?: string;
}
