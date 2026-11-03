// Webhook target URL rules (PRD §21.6): an SSRF guard for product-configured endpoints. Checked when
// an endpoint is created / changed and again before every delivery. Only the URL is inspected: Workers
// cannot resolve DNS before fetching, so a DNS name that resolves to a private address is not caught here
// (Cloudflare's network does not route Workers' subrequests into private networks; a self-hosted workerd
// has no such restriction — see the residual risk in PRD §21.6).
import type { Environment } from '@z-cloudbase/contracts';

export type WebhookUrlProblem = 'invalid_url' | 'https_required' | 'credentials_not_allowed' | 'private_address' | 'localhost_not_allowed';

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || (a === 203 && b === 0) || // TEST-NET-2/3
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast (deprecated, tunnels to embedded IPv4)
    a! >= 224 // multicast, reserved, broadcast
  );
}

/**
 * Expand an IPv6 literal (without brackets) to 8 hextets; null when it is not one. The WHATWG URL parser
 * has already canonicalised it (lowercase hex, embedded IPv4 rewritten as hextets).
 */
function ipv6(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const n = head.length + rest.length;
  if ([...head, ...rest].some(Number.isNaN) || n > 8 || (halves.length === 1 && n !== 8)) return null;
  return [...head, ...new Array(8 - n).fill(0), ...rest];
}

function privateIpv6(x: number[]): boolean {
  if (x.every((n) => n === 0)) return true; // ::
  if (x.slice(0, 7).every((n) => n === 0) && x[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4 address.
  if (x.slice(0, 5).every((n) => n === 0) && (x[5] === 0xffff || x[5] === 0)) {
    return privateIpv4([x[6]! >> 8, x[6]! & 0xff, x[7]! >> 8, x[7]! & 0xff]);
  }
  const first = x[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && x[1] === 0x0db8) || // documentation
    (first === 0x0064 && x[1] === 0xff9b) || // NAT64: embeds IPv4
    first === 0x2002 || // 6to4 (2002::/16): embeds an IPv4 address
    (first === 0x2001 && x[1] === 0x0000) // Teredo (2001::/32): embeds an IPv4 address
  );
}

/**
 * Check a webhook endpoint URL for an environment. `https:` everywhere; the `dev` environment may also
 * use `http://localhost` (or the loopback literals) for local receivers. IP literals in private,
 * loopback, link-local, CGNAT, multicast or documentation ranges and `localhost` names are refused.
 */
export function checkWebhookUrl(value: string, env: Environment): WebhookUrlProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_url';
  }
  if (url.username || url.password) return 'credentials_not_allowed';
  // WHATWG URL parsing already normalised numeric IPv4 forms (e.g. 2130706433, 0x7f.1) to dotted quads.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (env === 'dev' && LOCAL_DEV_HOSTS.has(host) && (url.protocol === 'http:' || url.protocol === 'https:')) return null;
  if (url.protocol !== 'https:') return url.protocol === 'http:' ? 'https_required' : 'invalid_url';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost_not_allowed';
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4) ? 'private_address' : null;
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = ipv6(host.slice(1, -1));
    if (!v6) return 'invalid_url';
    return privateIpv6(v6) ? 'private_address' : null;
  }
  return null;
}
