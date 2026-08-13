import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamOpenAIChatCompletion } from './openai_chat_stream';

function sse(events: object[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }));
}

describe('streamOpenAIChatCompletion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams final text and assembles usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      { id: 'chat-1', model: 'model-1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ])));
    const onDelta = vi.fn().mockResolvedValue(undefined);

    const result = await streamOpenAIChatCompletion(
      'https://example.test/chat/completions', 'key', { model: 'model-1', messages: [] }, onDelta,
    );

    expect(onDelta.mock.calls.flat()).toEqual(['Hello', ' world']);
    expect(result.choices[0].message.content).toBe('Hello world');
    expect(result.usage?.total_tokens).toBe(12);
  });

  it('assembles incremental function-call arguments without displaying them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"news"}' } }] }, finish_reason: 'tool_calls' }] },
    ])));
    const onDelta = vi.fn().mockResolvedValue(undefined);

    const result = await streamOpenAIChatCompletion(
      'https://example.test/chat/completions', 'key', { model: 'model-1', messages: [] }, onDelta,
    );

    expect(onDelta).not.toHaveBeenCalled();
    expect(result.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: 'call-1', function: { name: 'web_search', arguments: '{"query":"news"}' },
    });
  });
});
