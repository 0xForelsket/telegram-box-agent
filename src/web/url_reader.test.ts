import { afterEach, describe, expect, it, vi } from 'vitest';
import { URLReader } from './url_reader';

describe('URLReader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects local, private, credentialed, and non-HTTP targets', () => {
    const reader = new URLReader();
    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.1/',
      'http://user:pass@example.com/',
      'file:///etc/passwd',
    ]) {
      expect(() => reader.validateUrl(url)).toThrow();
    }
  });

  it('rejects numeric encodings of a loopback address', () => {
    const reader = new URLReader();
    // The URL parser canonicalises these to 127.0.0.1 before we see them, so
    // this pins that assumption rather than testing our own arithmetic.
    for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0/']) {
      expect(() => reader.validateUrl(url), url).toThrow('Private or local network');
    }
  });

  it('rejects IPv4 smuggled inside an IPv6 address', () => {
    const reader = new URLReader();
    for (const url of [
      'http://[::ffff:127.0.0.1]/',        // IPv4-mapped loopback
      'http://[::ffff:7f00:1]/',           // the same address, already normalised
      'http://[::ffff:169.254.169.254]/',  // IPv4-mapped cloud metadata endpoint
      'http://[::ffff:10.0.0.1]/',         // IPv4-mapped RFC1918
      'http://[64:ff9b::127.0.0.1]/',      // NAT64 well-known prefix
    ]) {
      expect(() => reader.validateUrl(url), url).toThrow('Private or local network');
    }
  });

  it('rejects reserved IPv6 ranges', () => {
    const reader = new URLReader();
    for (const url of ['http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[ff02::1]/']) {
      expect(() => reader.validateUrl(url), url).toThrow('Private or local network');
    }
  });

  it('rejects reserved and non-routable IPv4 ranges', () => {
    const reader = new URLReader();
    for (const url of ['http://172.16.0.1/', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/']) {
      expect(() => reader.validateUrl(url), url).toThrow('Private or local network');
    }
  });

  it('still allows ordinary public hosts', () => {
    const reader = new URLReader();
    // Neighbours of blocked ranges that are themselves perfectly routable.
    for (const url of [
      'https://example.com/',
      'http://8.8.8.8/',
      'http://[2606:4700::1]/',
      'http://173.16.0.1/',
      'http://192.169.0.1/',
      'http://99.64.0.1/',
    ]) {
      expect(() => reader.validateUrl(url), url).not.toThrow();
    }
  });

  it('extracts bounded readable HTML and follows a validated redirect', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://example.org/article' } }))
      .mockResolvedValueOnce(new Response(
        '<html><head><title> Example &amp; Title </title><style>.x{}</style></head><body><nav>Menu</nav><main><h1>Heading</h1><p>Useful text.</p></main></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new URLReader().read('https://example.com/start');
    expect(result.url).toBe('https://example.org/article');
    expect(result.title).toBe('Example & Title');
    expect(result.text).toContain('Heading');
    expect(result.text).toContain('Useful text.');
    expect(result.text).not.toContain('Menu');
  });

  it('rejects unsupported content types and oversized declared bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('pdf', {
      headers: { 'content-type': 'application/pdf' },
    })));
    await expect(new URLReader().read('https://example.com/file.pdf')).rejects.toThrow('Unsupported content type');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('small', {
      headers: { 'content-type': 'text/plain', 'content-length': '500001' },
    })));
    await expect(new URLReader().read('https://example.com/large')).rejects.toThrow('byte limit');
  });

  it('cancels a streamed body that exceeds the byte limit without a content-length header', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'content-type': 'text/plain' },
    })));

    await expect(new URLReader().read('https://example.com/stream')).rejects.toThrow('byte limit');
    expect(cancelled).toBe(true);
  });
});
