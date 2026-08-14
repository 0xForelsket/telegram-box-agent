import { readSSEJson } from '../search/sse';
import { globalFetch } from '../utils/helpers';
import { ChatCompletionResponse, ToolCall } from './chat_types';

interface ChatStreamChunk {
  id?: string;
  created?: number;
  model?: string;
  error?: { message?: string };
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ChatCompletionResponse['usage'];
}

export async function streamOpenAIChatCompletion(
  url: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  onTextDelta: (delta: string) => Promise<void>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ChatCompletionResponse> {
  const doFetch = options.fetchImpl ?? globalFetch;
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ ...requestBody, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok) {
    throw new Error(`Streaming chat completion error (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  if (!response.body) throw new Error('Streaming chat completion returned no body');

  let id = '';
  let created = 0;
  let resolvedModel = String(requestBody.model || '');
  let content = '';
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'];
  const calls = new Map<number, ToolCall>();

  for await (const chunk of readSSEJson<ChatStreamChunk>(response.body)) {
    if (chunk.error) throw new Error(chunk.error.message || 'Streaming chat completion failed');
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) resolvedModel = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices || []) {
      if (choice.finish_reason !== undefined) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        await onTextDelta(delta.content);
      }
      for (const partial of delta?.tool_calls || []) {
        const existing = calls.get(partial.index) || {
          id: partial.id || '',
          index: partial.index,
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (partial.id) existing.id = partial.id;
        if (partial.function?.name) existing.function.name += partial.function.name;
        if (partial.function?.arguments) existing.function.arguments += partial.function.arguments;
        calls.set(partial.index, existing);
      }
    }
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model: resolvedModel,
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: content || null,
        ...(calls.size > 0 ? { tool_calls: [...calls.values()].sort((a, b) => (a.index || 0) - (b.index || 0)) } : {}),
      },
    }],
    usage,
  };
}
