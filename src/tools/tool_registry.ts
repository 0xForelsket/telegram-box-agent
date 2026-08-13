import { Message, ToolCall, ToolDefinition } from '../api/chat_types';

export type ToolCategory = 'search' | 'knowledge' | 'finance' | 'memory' | 'utility';

export interface RegisteredTool {
  definition: ToolDefinition;
  category: ToolCategory;
  isAvailable: () => boolean;
  execute: (toolCall: ToolCall, signal: AbortSignal) => Promise<Message>;
}

export class ToolRegistry {
  constructor(
    tools: RegisteredTool[],
    private readonly timeoutMs = 8_000,
  ) {
    this.tools = new Map(tools.map(tool => [tool.definition.function.name, tool]));
  }

  private readonly tools: Map<string, RegisteredTool>;

  getDefinitions(names?: string[]): ToolDefinition[] {
    const requested = names ? new Set(names) : null;
    return [...this.tools.values()]
      .filter(tool => tool.isAvailable() && (!requested || requested.has(tool.definition.function.name)))
      .map(tool => tool.definition);
  }

  getAvailableNames(): string[] {
    return [...this.tools.values()]
      .filter(tool => tool.isAvailable())
      .map(tool => tool.definition.function.name);
  }

  async execute(toolCall: ToolCall): Promise<Message> {
    const name = toolCall.function?.name;
    const tool = name ? this.tools.get(name) : undefined;
    if (!tool || !tool.isAvailable()) {
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Unknown or unavailable tool: ${name || 'missing name'}`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await tool.execute(toolCall, controller.signal);
    } catch (error) {
      const message = controller.signal.aborted
        ? `Tool timed out after ${this.timeoutMs} ms`
        : error instanceof Error ? error.message : 'Unknown tool error';
      return { role: 'tool', tool_call_id: toolCall.id, content: `${name} failed: ${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
