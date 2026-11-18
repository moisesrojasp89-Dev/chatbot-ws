export interface ToolFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
      }
    >;
    required: string[];
  };
}

export interface ToolDefinition {
  functionDeclarations: ToolFunctionDeclaration[];
}

export interface FunctionCallPart {
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiContentMessage {
  role: 'user' | 'model';
  parts: Array<{
    text?: string;
    functionCall?: FunctionCallPart;
    functionResponse?: {
      name: string;
      response: Record<string, unknown>;
    };
  }>;
}

export interface GeminiCompletionResult {
  text: string;
  functionCalls?: FunctionCallPart[];
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  finishReason?: string;
}
