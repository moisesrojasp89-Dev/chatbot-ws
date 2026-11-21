import { z } from 'zod';
import { LlmTool } from '../providers/llm/llmTypes.js';

export type ToolEffect = 'catalog' | 'lead' | 'handoff' | 'media';

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  parameters: LlmTool['function']['parameters'];
  inputSchema: z.ZodType<TInput>;
  /** Efecto de negocio que el motor debe reflejar (flag/diferido). */
  effect?: ToolEffect;
  /** Mapea input a args de lead cuando effect='lead'. */
  leadArgs?: (input: TInput) => Record<string, unknown>;
  execute: (input: TInput, context: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolContext {
  contactId?: string;
  conversationId?: string;
  channel?: string;
  deferSideEffects?: boolean;
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Tool no registrada: ${name}`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolInputError extends Error {
  constructor(name: string, issues: string) {
    super(`Input inválido para tool ${name}: ${issues}`);
    this.name = 'ToolInputError';
  }
}

/**
 * Registro de tools del agente.
 *
 * El motor no debe hacer `if (tool === ...)`. Las tools se registran desde el
 * pack/arranque y el motor solo enumera y ejecuta por nombre.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown>>();

  public register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool duplicada: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as ToolDefinition<unknown>);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): ToolDefinition<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  /** Declaración neutra para el proveedor LLM (function calling). */
  public list(): LlmTool[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(tool.parameters)) as LlmTool['function']['parameters'],
      },
    }));
  }

  public async execute(name: string, input: unknown, context: ToolContext = {}): Promise<unknown> {
    const tool = this.get(name);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolInputError(name, parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    return tool.execute(parsed.data, context);
  }
}
