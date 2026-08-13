import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FETCH_TIMEOUT_MS, FetchTimeoutError, fetchJson, formatMarkdown, splitMessage, stripFormatting } from './helpers';

describe('splitMessage', () => {
  it('never emits an oversized part for long plain lines', () => {
    const parts = splitMessage('a'.repeat(10_000), 1000);
    expect(parts.length).toBe(10);
    expect(parts.every(part => part.length <= 1000)).toBe(true);
  });

  it('splits oversized code blocks into independently fenced chunks', () => {
    const parts = splitMessage(`\`\`\`ts\n${'x'.repeat(5000)}\n\`\`\``, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.startsWith('```ts\n') && part.endsWith('\n```') && part.length <= 1000)).toBe(true);
  });
});

/** A fetch that never settles until its signal aborts. */
const hangingFetch: typeof fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: init.signal!.reason?.name ?? 'AbortError' }));
    });
  })) as typeof fetch;

function jsonFetch(payload: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('fetchJson', () => {
  it('parses a successful JSON response', async () => {
    await expect(fetchJson('https://example.test', {}, 'ctx', { fetchImpl: jsonFetch({ ok: 1 }) }))
      .resolves.toEqual({ ok: 1 });
  });

  it('includes the status and body when the response is not ok', async () => {
    const failing = vi.fn(async () => new Response('upstream detail', { status: 502 })) as unknown as typeof fetch;

    await expect(fetchJson('https://example.test', {}, 'Provider error', { fetchImpl: failing }))
      .rejects.toThrow(/Provider error: 502[\s\S]*upstream detail/);
  });

  it('attaches a timeout signal even when the caller supplies none', async () => {
    const fetchImpl = jsonFetch({ ok: 1 });
    await fetchJson('https://example.test', {}, 'ctx', { fetchImpl });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hanging request and reports it as a timeout', async () => {
    await expect(
      fetchJson('https://example.test', {}, 'Provider error', { fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it('names the context and budget in the timeout message', async () => {
    await expect(
      fetchJson('https://example.test', {}, 'Provider error', { fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).rejects.toThrow('Provider error: timed out after 20ms');
  });

  it('still honours a caller signal that aborts before the timeout', async () => {
    const controller = new AbortController();
    const pending = fetchJson(
      'https://example.test',
      { signal: controller.signal },
      'ctx',
      { fetchImpl: hangingFetch, timeoutMs: 10_000 },
    );

    controller.abort();

    // Caller cancellation is the caller's own concern, so it must not be
    // relabelled as one of our timeouts.
    await expect(pending).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  it('defaults to a generous backstop rather than a latency policy', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('formatMarkdown', () => {
  it('collapses bold and bold-italic to Telegram single-asterisk emphasis', () => {
    expect(formatMarkdown('a **bold** b')).toBe('a *bold* b');
    expect(formatMarkdown('a ***both*** b')).toBe('a *both* b');
  });

  it('leaves single-asterisk emphasis alone', () => {
    expect(formatMarkdown('a *it* b')).toBe('a *it* b');
  });

  it('closes the gap in a spaced-out link', () => {
    expect(formatMarkdown('see [text] (https://e.com) end')).toBe('see [text](https://e.com) end');
  });

  it('converts dash bullets to a bullet glyph, preserving indentation', () => {
    expect(formatMarkdown('- one\n- two')).toBe('• one\n• two');
    expect(formatMarkdown('  - indented')).toBe('  • indented');
  });

  it('renders block quotes as an italic bar', () => {
    expect(formatMarkdown('> quoted line')).toBe('▎ _quoted line_');
  });

  it('gives inline code breathing room when it abuts other words', () => {
    expect(formatMarkdown('x`code`y')).toBe('x `code` y');
    expect(formatMarkdown('x `code` y')).toBe('x `code` y');
  });

  it('pads a fenced block onto its own lines', () => {
    expect(formatMarkdown('before\n```ts\nconst a = 1;\n```\nafter'))
      .toBe('before\n\n```ts\nconst a = 1;\n```\n\nafter');
  });

  it('collapses runs of blank lines inside a fence', () => {
    expect(formatMarkdown('```js\n\n\n\na\n\n\n\nb\n\n\n```')).toBe('\n```js\na\n\nb\n```\n');
  });

  it('does not apply emphasis rules inside a fence', () => {
    expect(formatMarkdown('```\n**not bold**\n```')).toBe('\n```\n**not bold**\n```\n');
  });

  it('handles several fences in one message', () => {
    expect(formatMarkdown('```a\n1\n```\nmid\n```b\n2\n```'))
      .toBe('\n```a\n1\n```\n\nmid\n\n```b\n2\n```\n');
  });

  it('leaves an unterminated fence untouched', () => {
    expect(formatMarkdown('```ts\nnever closed')).toBe('```ts\nnever closed');
  });
});

describe('stripFormatting', () => {
  it('removes emphasis markers', () => {
    expect(stripFormatting('a **bold** b')).toBe('a bold b');
    expect(stripFormatting('a ***both*** b')).toBe('a both b');
    expect(stripFormatting('a *it* b')).toBe('a it b');
  });

  it('flattens a link to text plus parenthesised URL', () => {
    expect(stripFormatting('see [text](https://e.com) end')).toBe('see text (https://e.com) end');
  });

  it('converts bullets and quotes to plain glyphs', () => {
    expect(stripFormatting('- one\n- two')).toBe('• one\n• two');
    expect(stripFormatting('> quoted line')).toBe('▎ quoted line');
  });

  it('unwraps inline code', () => {
    expect(stripFormatting('x `code` y')).toBe('x code y');
  });

  it('leaves fenced blocks verbatim', () => {
    expect(stripFormatting('```js\n\n\na\n```')).toBe('```js\n\n\na\n```');
    expect(stripFormatting('```\n**not bold**\n```')).toBe('```\n**not bold**\n```');
  });

  it('does not mangle an unterminated fence into a stray backtick', () => {
    // The inline-code rule must not consume two backticks of an unclosed fence.
    expect(stripFormatting('```ts\nnever closed')).toBe('```ts\nnever closed');
  });
});
