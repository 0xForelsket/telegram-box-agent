/** Minimal Worker-compatible SSE JSON reader with chunk-boundary handling. */
export async function* readSSEJson<T extends object>(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data) as T;
        } catch {
          // Ignore non-JSON keepalive/debug events without losing later frames.
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
