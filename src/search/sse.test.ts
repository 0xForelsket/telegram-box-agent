import { describe, expect, it } from 'vitest';
import { readSSEJson } from './sse';

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readSSEJson', () => {
  it('parses JSON frames split across arbitrary chunks', async () => {
    const events: object[] = [];
    for await (const event of readSSEJson(chunkedStream([
      'event: response\r\ndata: {"type":"response.output_',
      'text.delta","delta":"hi"}\r\n\r\n',
      'data: [DONE]\n\n',
    ]))) events.push(event);
    expect(events).toEqual([{ type: 'response.output_text.delta', delta: 'hi' }]);
  });

  it('ignores malformed frames and continues with later valid events', async () => {
    const events: object[] = [];
    for await (const event of readSSEJson(chunkedStream([
      'data: not-json\n\ndata: {"type":"response.completed"}\n\n',
    ]))) events.push(event);
    expect(events).toEqual([{ type: 'response.completed' }]);
  });
});
