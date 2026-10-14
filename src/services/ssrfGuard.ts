import dns from 'node:dns';
import net from 'node:net';
import { createRequire } from 'node:module';

/**
 * SSRF guard for server-initiated requests whose target comes from user input
 * (outbound webhooks, API Studio, SEO audit).
 *
 * A hostname regex is not enough: `evil.example` can resolve to 127.0.0.1, and
 * a DNS answer can change between the check and the connect (rebinding). This
 * module resolves the name once (`dns.lookup`, all addresses), rejects the
 * request if ANY answer is in a blocked range, and pins the connection to the
 * vetted address through an undici dispatcher whose `connect.lookup` returns
 * only that address. TLS still verifies the certificate against the hostname.
 * Redirects are followed manually and every hop is re-checked.
 *
 * Blocked: unspecified, loopback, RFC1918 private, CGNAT (100.64/10),
 * link-local (incl. 169.254.169.254), multicast, reserved/benchmark/doc
 * ranges, IPv6 ULA/link-local/site-local/multicast, IPv4-mapped and
 * IPv4-compatible IPv6, NAT64, and cloud metadata hostnames.
 *
 * OPENHUB_ALLOW_PRIVATE_URLS=1 (or the older OPENHUB_ALLOW_PRIVATE_FETCH=1 /
 * OPENHUB_WEBHOOK_ALLOW_PRIVATE=1) allows private and loopback targets for
 * local development. Metadata endpoints stay blocked even then.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export function privateUrlsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENHUB_ALLOW_PRIVATE_URLS === '1'
    || env.OPENHUB_ALLOW_PRIVATE_FETCH === '1'
    || env.OPENHUB_WEBHOOK_ALLOW_PRIVATE === '1';
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.com',
]);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '100.100.100.200']);

function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export function isMetadataHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return METADATA_HOSTS.has(h) || METADATA_IPS.has(h);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inV4(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network" / unspecified
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

/** Parse an IPv6 literal (no zone) into 16 bytes, or null. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const n = ipv4ToInt(maybeV4);
    if (n === null) return null;
    tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, undefined];
  const hextets = (str: string) => (str ? str.split(':').filter((x) => x !== '') : []);
  const h = hextets(head);
  const r = rest === undefined ? [] : hextets(rest);
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  const all = [...h, ...Array(fill).fill('0'), ...r];
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const x of all) {
    const v = parseInt(x, 16);
    bytes.push((v >> 8) & 255, v & 255);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True when `ip` (v4 or v6 literal) is in a range outbound requests must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const addr = normalizeHost(ip);
  if (METADATA_IPS.has(addr)) return true;
  if (net.isIPv4(addr)) {
    const n = ipv4ToInt(addr);
    if (n === null) return true;
    return BLOCKED_V4.some(([base, bits]) => inV4(n, base, bits));
  }
  const b = parseIPv6(addr);
  if (!b) return true; // unparseable: fail closed
  const zeroPrefix = (len: number) => b.slice(0, len).every((x) => x === 0);
  if (zeroPrefix(16)) return true;                                   // ::
  if (zeroPrefix(15) && b[15] === 1) return true;                    // ::1
  if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return true; // ::ffff:0:0/96 IPv4-mapped
  if (zeroPrefix(12)) return true;                                   // ::/96 IPv4-compatible (deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // 64:ff9b::/96 NAT64
  if (b[0] === 0x01 && b[1] === 0x00 && zeroPrefix(0)) {
    if (b.slice(2, 8).every((x) => x === 0)) return true;            // 100::/64 discard
  }
  if ((b[0] & 0xfe) === 0xfc) return true;                           // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;          // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;          // fec0::/10 site-local
  if (b[0] === 0xff) return true;                                    // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 doc
  if (b[0] === 0x20 && b[1] === 0x02) return true;                   // 2002::/16 6to4 (can embed private v4)
  return false;
}

export interface LookupAddress { address: string; family: number }
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: LookupFn = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

type FetchLike = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

interface Hooks { lookup: LookupFn; fetch: FetchLike | null }
const hooks: Hooks = { lookup: defaultLookup, fetch: null };

/** Test seam: replace DNS lookup and/or the fetch transport. Pass {} to reset. */
export function __setSsrfTestHooks(next: Partial<Hooks>): void {
  hooks.lookup = next.lookup ?? defaultLookup;
  hooks.fetch = next.fetch ?? null;
}

/**
 * Resolve `hostname` and return one vetted address to pin the connection to.
 * Throws SsrfBlockedError when the host is a metadata endpoint or when ANY
 * resolved address is blocked (unless private targets are explicitly allowed,
 * in which case only metadata is refused).
 */
export async function resolvePinnedAddress(
  hostname: string,
  opts: { env?: NodeJS.ProcessEnv; label?: string } = {},
): Promise<LookupAddress> {
  const env = opts.env ?? process.env;
  const label = opts.label ?? 'outbound URL';
  const host = normalizeHost(hostname);
  if (!host) throw new SsrfBlockedError(`${label} has no host`);
  if (isMetadataHost(host)) throw new SsrfBlockedError(`${label} points at a cloud metadata endpoint (private address)`);
  const allowPrivate = privateUrlsAllowed(env);

  if (net.isIP(host)) {
    if (!allowPrivate && isBlockedAddress(host)) {
      throw new SsrfBlockedError(`${label} points at a loopback/private address (set OPENHUB_ALLOW_PRIVATE_URLS=1 to allow)`);
    }
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }

  let addrs: LookupAddress[];
  try {
    addrs = await hooks.lookup(host);
  } catch (err) {
    throw new Error(`${label}: DNS lookup for ${host} failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!addrs.length) throw new Error(`${label}: ${host} did not resolve`);
  for (const a of addrs) {
    if (METADATA_IPS.has(normalizeHost(a.address))) {
      throw new SsrfBlockedError(`${label} resolves to a cloud metadata address (private address)`);
    }
    if (!allowPrivate && isBlockedAddress(a.address)) {
      throw new SsrfBlockedError(`${label} resolves to a loopback/private address (set OPENHUB_ALLOW_PRIVATE_URLS=1 to allow)`);
    }
  }
  return { address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
}

// undici ships with this install (transitively); load it lazily so a missing
// copy degrades to check-then-fetch rather than crashing the module.
type AgentCtor = new (opts: Record<string, unknown>) => { close(): Promise<void> };
let agentCtor: AgentCtor | null | undefined;
function loadAgent(): AgentCtor | null {
  if (agentCtor !== undefined) return agentCtor;
  try {
    const req = createRequire(import.meta.url);
    agentCtor = (req('undici') as { Agent: AgentCtor }).Agent;
  } catch {
    agentCtor = null;
    console.warn('[ssrfGuard] undici not available; outbound requests are checked but not address-pinned');
  }
  return agentCtor;
}

/** An undici dispatcher whose every connection goes to `pinned`, whatever the hostname. */
export function pinnedDispatcher(pinned: LookupAddress): unknown {
  const Agent = loadAgent();
  if (!Agent) return undefined;
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | number | undefined,
    cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    const all = typeof options === 'object' && options !== null && options.all;
    if (all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
  return new Agent({ connect: { lookup }, keepAliveTimeout: 1_000, keepAliveMaxTimeout: 1_000 });
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function assertScheme(url: URL, label: string): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`${label} scheme "${url.protocol}" is not allowed (http/https only)`);
  }
}

/**
 * `fetch` for untrusted targets: validates the scheme, resolves and vets the
 * address, pins the connection to it, and follows redirects manually with the
 * same checks on every hop. 303 (and 301/302 on non-GET/HEAD) become GET with
 * the body dropped; 307/308 keep method and body. Credentials-bearing headers
 * are dropped when a redirect changes origin.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; label?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const label = opts.label ?? 'outbound URL';
  let current: URL;
  try {
    current = new URL(String(rawUrl));
  } catch {
    throw new Error(`${label} is not a valid absolute URL`);
  }
  let method = String(init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers ?? {});
  const origin0 = current.origin;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertScheme(current, label);
    const pinned = await resolvePinnedAddress(current.hostname, { env: opts.env, label });
    const dispatcher = pinnedDispatcher(pinned);
    const transport: FetchLike = hooks.fetch ?? ((input, i) => globalThis.fetch(input, i as RequestInit));
    const res = await transport(current.toString(), {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    const next = new URL(location, current);
    if (next.origin !== origin0) {
      headers = new Headers(headers);
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    current = next;
  }
  throw new Error(`${label} exceeded ${maxRedirects} redirects`);
}
