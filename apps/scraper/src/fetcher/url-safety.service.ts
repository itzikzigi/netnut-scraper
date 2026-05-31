import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup as dnsLookupCb } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { isIP, LookupFunction } from 'node:net';

/**
 * Thrown when a target URL is rejected for SSRF reasons (bad protocol, or it
 * resolves to a private/internal address). Deterministic — the worker treats
 * it as non-retryable.
 */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

// ── Pure IP-range checks ────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // Reject empty, non-numeric, out-of-range, and zero-padded octets.
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255 || (p.length > 1 && p[0] === '0')) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function isBlockedV4Int(n: number): boolean {
  // [base, prefix-bits] for IANA special-use / private ranges we must never hit.
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this" network
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay anycast
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved
  ];
  return ranges.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (n & mask) === (baseInt & mask);
  });
}

/** Expand any IPv6 textual form (compressed, embedded IPv4, zone id) to 16 bytes. */
function expandV6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // drop zone id

  // Pull off an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) and keep the ':'.
  let v4Bytes: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    v4Bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    s = s.slice(0, lastColon + 1);
  }

  if ((s.match(/::/g) || []).length > 1) return null; // at most one '::'
  const hasDouble = s.includes('::');

  const toGroups = (seg: string): string[] => seg.split(':').filter((g) => g !== '');
  let headGroups: string[];
  let tailGroups: string[];
  if (hasDouble) {
    const [h, t] = s.split('::');
    headGroups = toGroups(h);
    tailGroups = toGroups(t);
  } else {
    headGroups = toGroups(s);
    tailGroups = [];
  }

  const bytes: number[] = [];
  const pushGroup = (g: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
    const v = parseInt(g, 16);
    bytes.push((v >>> 8) & 255, v & 255);
    return true;
  };

  for (const g of headGroups) if (!pushGroup(g)) return null;

  const hextetBytes = 16 - (v4Bytes ? 4 : 0);
  if (hasDouble) {
    const zeros = hextetBytes - (headGroups.length + tailGroups.length) * 2;
    if (zeros < 0) return null;
    for (let i = 0; i < zeros; i++) bytes.push(0);
  }
  for (const g of tailGroups) if (!pushGroup(g)) return null;
  if (v4Bytes) bytes.push(...v4Bytes);

  return bytes.length === 16 ? bytes : null;
}

function isBlockedV6(ip: string): boolean {
  const b = expandV6(ip);
  if (!b) return true; // unparseable → block to be safe
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d — defer to the v4 rules.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4Int(((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0);
  }
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** True if `ip` is a private/internal/reserved address we must not connect to. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4Int(ipv4ToInt(ip)!);
  if (family === 6) return isBlockedV6(ip);
  return true; // not a valid IP → can't verify, block
}

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class UrlSafetyService {
  private readonly logger = new Logger(UrlSafetyService.name);
  // Escape hatch for local/dev runs that legitimately target localhost.
  private readonly allowPrivate: boolean;

  constructor(config: ConfigService) {
    this.allowPrivate = config.get<string>('ALLOW_PRIVATE_TARGETS') === 'true';
    if (this.allowPrivate) {
      this.logger.warn('ALLOW_PRIVATE_TARGETS=true — SSRF guard disabled (dev only)');
    }
  }

  /**
   * Fail fast before connecting: enforce http(s) and reject targets that
   * resolve to a private/internal address. The agent lookup guard
   * (`guardedLookup`) re-checks at connect time to also cover redirects and
   * DNS rebinding; this pre-flight gives a clean error for the common case.
   */
  async assertPublicUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BlockedUrlError(`Malformed URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlockedUrlError(`Unsupported protocol: ${parsed.protocol}`);
    }
    if (this.allowPrivate) return;

    const host = this.stripBrackets(parsed.hostname);
    let addresses: string[];
    if (isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await dnsLookupAsync(host, { all: true })).map((a) => a.address);
      } catch {
        throw new BlockedUrlError(`DNS resolution failed for ${host}`);
      }
    }
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) {
        throw new BlockedUrlError(`${host} resolves to a blocked address (${addr})`);
      }
    }
  }

  /**
   * DNS lookup that rejects private/internal addresses at connect time. Passed
   * to the http(s) Agent on the direct path so every hop (initial + redirects)
   * is validated against the *actually-resolved* IP — closing DNS-rebinding.
   */
  guardedLookup(): LookupFunction {
    const allowPrivate = this.allowPrivate;
    return ((hostname, options, callback) => {
      dnsLookupCb(hostname, options, (err, address, family) => {
        if (err || allowPrivate) return callback(err, address as never, family);
        const addrs = Array.isArray(address)
          ? (address as Array<{ address: string }>).map((a) => a.address)
          : [address as string];
        for (const a of addrs) {
          if (isBlockedAddress(a)) {
            return callback(new BlockedUrlError(`Blocked address ${a}`), '' as never, 0);
          }
        }
        callback(err, address as never, family);
      });
    }) as LookupFunction;
  }

  private stripBrackets(host: string): string {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  }
}
