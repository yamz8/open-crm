import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guards outbound, user-specified HTTP destinations.
 *
 * A webhook URL is attacker-controlled by anyone holding `webhooks:admin` —
 * which includes any wildcard-scoped agent token. Without this, "deliver a
 * payload to a URL I choose" becomes "probe the host's private network from
 * inside the perimeter", including cloud metadata endpoints.
 */

/** RFC1918, loopback, link-local, CGNAT, and their IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(normalized)) return true; // unique local
    // IPv4-mapped (::ffff:169.254.169.254) tunnels straight past a v4-only check.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export type DestinationCheck =
  | { allowed: true }
  /** `retryable` separates a transient DNS failure from a policy refusal. */
  | { allowed: false; reason: string; retryable: boolean };

/**
 * Resolves the host and rejects private destinations. Resolution happens per
 * delivery rather than once at subscription time, because DNS can be changed
 * to point at an internal address after the URL passes validation.
 */
export async function checkDestination(
  rawUrl: string,
  options: { allowPrivate?: boolean } = {},
): Promise<DestinationCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'destination is not a valid URL', retryable: false };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `destination scheme ${url.protocol} is not allowed`,
      retryable: false,
    };
  }
  if (options.allowPrivate) return { allowed: true };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { allowed: false, reason: `destination ${hostname} is a private address`, retryable: false }
      : { allowed: true };
  }

  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) {
      return { allowed: false, reason: `destination ${hostname} did not resolve`, retryable: true };
    }
    // Every answer must be public: one private record is enough to pivot.
    const offender = results.find((r) => isPrivateAddress(r.address));
    if (offender) {
      return {
        allowed: false,
        reason: `destination ${hostname} resolves to the private address ${offender.address}`,
        retryable: false,
      };
    }
    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      reason: `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      // DNS hiccups are transient; do not burn the delivery over one.
      retryable: true,
    };
  }
}
