import { RUNTIME_BUDGETS } from '../config/runtime_budgets';

export interface ReadPageResult {
  url: string;
  title?: string;
  contentType: string;
  text: string;
}

function parseIPv4(host: string): number[] | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(value => value <= 255) ? octets : [999, 0, 0, 0];
}

/** Expands an IPv6 address, including a `::` run, to its eight 16-bit groups. */
function expandIPv6(host: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(':')) return null;

  // A trailing dotted quad occupies the final two groups.
  let text = host;
  const trailing = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (trailing) {
    const quad = parseIPv4(trailing[1]);
    if (!quad || quad[0] > 255) return null;
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${text.slice(0, -trailing[1].length)}${high}:${low}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const toGroups = (part: string) => (part ? part.split(':').filter(Boolean).map(g => parseInt(g, 16)) : []);
  const left = toGroups(head);
  const right = tail === undefined ? [] : toGroups(tail);
  if (tail === undefined && left.length !== 8) return null;

  const groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * Pulls the IPv4 address out of an IPv6 wrapper — IPv4-mapped (::ffff:a.b.c.d),
 * IPv4-compatible, and the NAT64 well-known prefix — so `[::ffff:127.0.0.1]`
 * cannot be used to reach a target that plain 127.0.0.1 would be refused for.
 */
function embeddedIPv4(host: string): number[] | null {
  const groups = expandIPv6(host);
  if (!groups) return null;

  const mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0
    && groups[3] === 0 && groups[4] === 0 && (groups[5] === 0xffff || groups[5] === 0);
  const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b;
  if (!mapped && !nat64) return null;
  // ::  and ::1 are addresses in their own right, not wrapped IPv4.
  if (mapped && groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return null;

  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (octets.some(value => value > 255)) return true;
  if (a === 0 || a === 127) return true;                 // this-network, loopback
  if (a === 10) return true;                             // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;      // RFC1918
  if (a === 192 && b === 168) return true;               // RFC1918
  if (a === 169 && b === 254) return true;               // link-local, cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // carrier-grade NAT
  if (a === 192 && b === 0) return true;                 // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmarking
  if (a >= 224) return true;                             // multicast and reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const groups = expandIPv6(host);
  if (!groups) return true;                              // unparseable: refuse rather than guess
  if (groups.every(group => group === 0)) return true;   // ::
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true;      // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;      // fe80::/10 link local
  if ((groups[0] & 0xff00) === 0xff00) return true;      // ff00::/8 multicast
  return false;
}

export class URLReader {
  private static readonly MAX_REDIRECTS = 3;

  async read(rawUrl: string, signal?: AbortSignal): Promise<ReadPageResult> {
    let url = this.validateUrl(rawUrl);
    for (let redirects = 0; redirects <= URLReader.MAX_REDIRECTS; redirects++) {
      const response = await fetch(url.toString(), { redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === URLReader.MAX_REDIRECTS) {
          throw new Error('Too many or invalid redirects while reading URL');
        }
        url = this.validateUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(`URL returned HTTP ${response.status}`);
      }

      const contentType = (response.headers.get('content-type') || 'text/plain').split(';')[0].toLowerCase();
      if (!this.isSupportedContentType(contentType)) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > RUNTIME_BUDGETS.maxPageBytes) {
        throw new Error(`Page exceeds ${RUNTIME_BUDGETS.maxPageBytes} byte limit`);
      }

      const rawText = await this.readBoundedText(response);
      const title = contentType === 'text/html' ? this.extractTitle(rawText) : undefined;
      const text = contentType === 'text/html'
        ? this.extractReadableHtml(rawText)
        : rawText.replace(/\s+/g, ' ').trim();
      if (!text) {
        throw new Error('Page did not contain readable text');
      }
      return { url: url.toString(), title, contentType, text: text.slice(0, 30_000) };
    }
    throw new Error('Unable to read URL');
  }

  validateUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS URLs are supported');
    }
    if (url.username || url.password) {
      throw new Error('URLs containing credentials are not supported');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.isPrivateHostname(hostname)) {
      throw new Error('Private or local network URLs are not allowed');
    }
    return url;
  }

  /**
   * Defence in depth, not the boundary. Cloudflare's egress policy is what
   * actually stops a Worker reaching RFC1918 space; this rejects obviously
   * internal targets early and keeps them out of logs and error messages.
   *
   * It cannot cover a public hostname whose DNS record points somewhere
   * internal: a Worker resolves names inside `fetch`, so there is no address to
   * inspect before the request goes out.
   *
   * Numeric IPv4 in decimal, hex, octal, and short forms needs no special
   * handling because the WHATWG URL parser has already canonicalised the
   * hostname to dotted-quad by this point.
   */
  private isPrivateHostname(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

    const octets = parseIPv4(host) ?? embeddedIPv4(host);
    if (octets) return isPrivateIPv4(octets);
    if (host.includes(':')) return isPrivateIPv6(host);
    return false;
  }

  private isSupportedContentType(contentType: string): boolean {
    return contentType.startsWith('text/') || [
      'application/json',
      'application/ld+json',
      'application/xml',
      'application/rss+xml',
      'application/atom+xml',
    ].includes(contentType);
  }

  private async readBoundedText(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RUNTIME_BUDGETS.maxPageBytes) {
        await reader.cancel();
        throw new Error(`Page exceeds ${RUNTIME_BUDGETS.maxPageBytes} byte limit`);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  private extractTitle(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? this.decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
  }

  private extractReadableHtml(html: string): string {
    return this.decodeEntities(html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|article|section|main|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  }

  private decodeEntities(text: string): string {
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    };
    return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity[0] === '#') {
        const hexadecimal = entity[1]?.toLowerCase() === 'x';
        const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ';
      }
      return named[entity.toLowerCase()] ?? ' ';
    });
  }
}
